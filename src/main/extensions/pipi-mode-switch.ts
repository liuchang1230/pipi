import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * pipi 随 app 分发的扩展：auto / plan / edit 三模式切换。
 *
 * pi 上游刻意不内置模式系统（docs/usage.md：no permission popups / plan mode），
 * 一切模式皆走扩展 API。本扩展整合官方 examples/extensions/plan-mode 的机制，
 * 并补上 edit（写操作确认）模式：
 *
 * - auto = pi 默认的完全自主模式，本扩展不拦截任何工具调用。
 * - plan = 只读研究模式：edit/write 工具从活动工具集摘除（模型看不到），
 *          bash/powershell 只放行只读白名单命令；agent 输出 "Plan:" 编号计划，
 *          agent_end 提取步骤并询问「执行计划？」，执行期用 [DONE:n] 跟踪进度。
 * - edit = 写操作确认模式：只读命令直接放行，edit/write 工具与带写特征的
 *          bash/powershell 命令逐个 ctx.ui.confirm；无 UI（print/json 模式）
 *          一律 block（fail-closed）。
 *
 * 交互：
 * - /mode                 查看当前模式
 * - /mode auto|plan|edit  直接切换
 * - /mode next            循环 auto → plan → edit → auto
 * - Ctrl+Alt+M            循环切换
 * - --pipi-mode plan|edit 启动时指定（注册名避开内置 --mode rpc/json）
 *
 * 实现机制（对应 docs/extensions.md）：
 * - 工具开关: pi.setActiveTools()/getActiveTools()
 * - 拦截/确认: pi.on("tool_call") 返回 { block: true, reason }
 * - 上下文注入: pi.on("before_agent_start")，旧标记由 pi.on("context") 过滤
 * - 进度跟踪: pi.on("turn_end") 扫 [DONE:n]，widget 展示
 * - 状态持久化: pi.appendEntry()，session_start/resume 恢复
 *
 * 该文件由主进程在启动时写入 ~/.pi/agent/extensions/（extension-sync.ts），
 * pi 自动发现；/reload 可热加载。删除后下次启动会被重新写入（产品自带增强）。
 */

type Mode = "auto" | "plan" | "edit";

const MODE_ENTRY = "pipi-mode";
const PLAN_CONTEXT_TYPE = "pipi-mode-context";
const EXEC_CONTEXT_TYPE = "pipi-mode-exec";
const EDIT_CONTEXT_TYPE = "pipi-mode-edit-context";
const PLAN_MARKER = "[PIPI PLAN MODE ACTIVE]";
const EXEC_MARKER = "[PIPI EXECUTING PLAN]";
const EDIT_MARKER = "[PIPI EDIT MODE ACTIVE]";
const MODE_CYCLE: readonly Mode[] = ["auto", "plan", "edit"];

/** 机器可解析的状态推送载体：ctx.ui.setStatus 的文本会原样到达 chat UI 的
 *  extension_ui_request(method=setStatus) 分支。前缀约定（与 app 端
 *  parseModeStatus 严格配对）：
 *  - "pipi-mode:<mode>"            —— auto / plan / edit（执行计划期回 auto）
 *  - "pipi-mode:exec <done>/<n>"   —— 执行计划进度（turn_end 时刷新）
 *  - undefined                     —— 自动清除（setStatus(key, undefined)）
 *  app 端渲染时剥掉前缀；TUI 用户看到的则是一小段可读状态。 */
const STATUS_KEY = "pipi-mode";
function statusTextFor(next: Mode): string {
	return `pipi-mode:${next}`;
}
function statusTextForExec(done: number, total: number): string {
	return `pipi-mode:exec ${done}/${total}`;
}
/** TUI 友好的展示形式（不用于机器解析）。 */
function humanStatus(next: Mode): string {
	return next === "plan" ? "⏸ plan" : next === "edit" ? "✎ edit" : "▶ auto";
}

/** plan 模式下禁用的内置写工具（从活动工具集摘除，模型不可见）。 */
const PLAN_DISABLED_TOOLS = new Set(["edit", "write"]);
/** plan 模式下保证可用的只读工具（缺失才补，不覆盖项目自定义工具）。 */
const PLAN_READ_TOOLS = ["read", "grep", "find", "ls"];

// ---------------------------------------------------------------------------
// bash 只读判定（plan 白名单 / edit 放行），源自官方 plan-mode/utils.ts，补 cd。
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cd\b/,
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|run\s+lint|test\s+--?dry)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python(3)?\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/** 只读 bash 判定：命中破坏性 pattern 直接否决；再要求命中 SAFE 白名单。
 *  复合命令（cat a && rm b）因开头不匹配 SAFE 而被拦，宁严勿漏。 */
function isReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(trimmed))) return false;
	return SAFE_PATTERNS.some((p) => p.test(trimmed));
}

/** PowerShell 写特征（Windows 下 pi 用 powershell 工具）：写 cmdlet / 重定向 /
 *  管道写文件。edit 模式下命中即弹确认，未命中视为只读放行。 */
const POWERSHELL_WRITE_PATTERNS = [
	/\b(Set-Content|Add-Content|Remove-Item|New-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Out-File|Invoke-WebRequest|Invoke-Expression|Start-Process|Stop-Process|Set-ItemProperty|Register-|Unregister-|Install-|Uninstall-)\b/i,
	/\b(rm|del|erase|rd|rmdir|ni|mi|cpi|mpi|rni|ri|spi|saps|sasv)\b/i,
	/(\||^|\s)(>|>>|2>|2>>)(\s|$)/,
	/\b(git|npm|pnpm|yarn|pip)\s+(install|add|commit|push|publish|uninstall|remove)/i,
];

function isPowerShellWrite(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	return POWERSHELL_WRITE_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Plan 提取与 [DONE:n] 进度（源自官方 plan-mode/utils.ts）
// ---------------------------------------------------------------------------

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
	return cleaned;
}

/** 「信息量」权重：CJK 每字按 2，其余按 1（阈值沿用官方语义但适配中文）。 */
function stepWeight(text: string): number {
	let weight = 0;
	for (const ch of text) weight += /[㐀-鿿＀-￯]/.test(ch) ? 2 : 1;
	return weight;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;
	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		// 门槛按"信息量"而不是字符数：官方 utils 用 >5 字符（英文调优），但中文步骤
		// 「补一个测试」只有 5 个字却完全可用，被丢掉就等于计划少了一步。CJK 字符按 2 计。
		if (stepWeight(text) >= 8 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

function markCompletedSteps(text: string, items: TodoItem[]): number {
	let marked = 0;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (!Number.isFinite(step)) continue;
		const item = items.find((t) => t.step === step);
		if (item) {
			item.completed = true;
			marked++;
		}
	}
	return marked;
}

// ---------------------------------------------------------------------------
// 消息辅助（避免跨包 import pi-agent-core / pi-ai，用结构化类型窄化）
// ---------------------------------------------------------------------------

interface TextBlock {
	type: string;
	text?: string;
}

function isAssistantMessage(m: unknown): boolean {
	return typeof m === "object" && m !== null && (m as { role?: unknown }).role === "assistant";
}

function getTextContent(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextBlock => typeof c === "object" && c !== null && (c as TextBlock).type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function contentHasMarker(m: unknown, marker: string): boolean {
	const content = (m as { content?: unknown }).content;
	if (typeof content === "string") return content.includes(marker);
	if (!Array.isArray(content)) return false;
	return content.some((c) => typeof c === "object" && c !== null && (c as TextBlock).text?.includes(marker));
}

/** Is this message one of our mode-instruction injections (by customType or
 *  marker text)? NOTE: the BEFORE-AGENT-START injection carries BOTH the
 *  customType AND the marker in its content; filtering must check both —
 *  and only when that mode is INACTIVE (see the context handler). */
function isModeInjection(m: unknown, customType: string, marker: string): boolean {
	if ((m as { customType?: unknown }).customType === customType) return true;
	return contentHasMarker(m, marker);
}

// ---------------------------------------------------------------------------
// 确认弹窗摘要
// ---------------------------------------------------------------------------

/**
 * 人话描述一条会写文件的命令想干什么。
 *
 * 用户反馈：「edit 请求编辑的时候，提供的是一堆代码命令，看不懂」。确认框原先只有一句
 * 命令原文，用户得先读懂 shell 才能判断该不该点「允许」。这里按命令类型先说一句人话，
 * 原始命令仍完整附在下面供核对。
 */
export function describeBashIntent(command: string): string {
	const c = command.replace(/\s+/g, " ").trim();
	const has = (re: RegExp) => re.test(c);
	// 「以管理员权限…」 is a property of the WHOLE command, so it prefixes whatever it does.
	const elevated = has(/\b(sudo|su)\b|Verb RunAs/i);
	const prefix = elevated ? "以管理员权限" : "";
	const say = (action: string) => `${prefix}${action}`;
	/** The thing being touched: first token that is neither a flag nor a command/verb. */
	const NOISE = new Set([
		"sudo", "su", "sh", "bash", "zsh", "env",
		"rm", "rmdir", "del", "erase", "rd", "Remove-Item", "mv", "Move-Item", "Rename-Item", "rni", "ren",
		"cp", "Copy-Item", "cpi", "mkdir", "New-Item", "ni", "touch", "chmod", "chown", "chgrp", "kill", "pkill", "killall", "taskkill",
		"git", "add", "commit", "push", "pull", "merge", "rebase", "reset", "checkout", "switch", "stash", "cherry-pick", "revert", "tag", "init", "clone",
		"npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "conda", "uv", "install", "uninstall", "update", "upgrade", "ci", "link", "publish",
		"apt", "apt-get", "brew", "choco", "winget", "scoop", "remove", "purge",
		"systemctl", "service", "start", "stop", "restart", "enable", "disable",
	]);
	const target = (): string =>
		c.split(" ").map((t) => t.replace(/^["']|["';|&>]+$/g, ""))
			.find((t) => t.length > 0 && !t.startsWith("-") && !/^\d*>$/.test(t) && !NOISE.has(t)) ?? "";	if (has(/\b(rm|rmdir|del|erase|rd|Remove-Item)\b/i)) {
		const t = target();
		return say(t ? `删除 ${t}` : "删除文件或目录");
	}
	if (has(/\b(mv|Move-Item|Rename-Item|rni|ren)\b/i)) {
		const t = target();
		return say(t ? `移动或重命名 ${t}` : "移动或重命名文件");
	}
	if (has(/\b(cp|Copy-Item|cpi|xcopy|robocopy)\b/i)) {
		const t = target();
		return say(t ? `复制 ${t}` : "复制文件");
	}
	if (has(/\b(mkdir|New-Item|ni)\b/i)) return say("新建目录");
	if (has(/\b(touch)\b/i)) {
		const t = target();
		return say(t ? `新建文件 ${t}` : "新建文件");
	}
	if (has(/\b(tee|truncate|Out-File|Set-Content|Add-Content)\b/i) || /(^|[^<])>(?!>)|>>/.test(c)) return say("写入或覆盖文件内容");
	if (has(/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i)) {
		const verb = c.match(/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i)?.[1]?.toLowerCase() ?? "";
		const zh: Record<string, string> = {
			add: "把改动加入待提交", commit: "提交改动", push: "推送代码到远端", pull: "拉取远端代码",
			merge: "合并分支", rebase: "变基（重排提交）", reset: "重置提交历史", checkout: "切换分支或版本",
			switch: "切换分支", stash: "暂存改动", "cherry-pick": "摘取某个提交", revert: "撤销某个提交",
			tag: "打标签", init: "初始化仓库", clone: "克隆仓库",
		};
		return say(`Git：${zh[verb] ?? "仓库操作"}`);
	}
	if (has(/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|ci|link|publish|upgrade)\b/i)) {
		const pkg = target();
		const verb = /\b(remove|uninstall)\b/i.test(c) ? "卸载" : /\b(publish)\b/i.test(c) ? "发布" : "安装或更新";
		return say(`${verb} JS 依赖${pkg ? ` ${pkg}` : ""}`);
	}
	if (has(/\b(pip|pip3|poetry|conda|uv)\s+(install|uninstall|add|remove)\b/i)) {
		const pkg = target();
		const verb = /\b(uninstall|remove)\b/i.test(c) ? "卸载" : "安装";
		return say(`${verb} Python 依赖${pkg ? ` ${pkg}` : ""}`);
	}
	if (has(/\b(apt|apt-get|brew|choco|winget|scoop)\s+(install|remove|purge|update|upgrade)\b/i)) {
		const pkg = target();
		return say(`安装或更新系统软件${pkg ? ` ${pkg}` : ""}`);
	}
	if (has(/\b(chmod|chown|chgrp|Set-ItemProperty|icacls)\b/i)) return say("修改文件权限或属主");
	if (has(/\b(kill|pkill|killall|Stop-Process|taskkill)\b/i)) {
		const t = target();
		return say(t ? `结束进程 ${t}` : "结束进程");
	}
	if (has(/\b(systemctl|service)\s+\S*\s*(start|stop|restart|enable|disable)/i)) {
		const svc = target();
		const action = c.match(/\b(start|stop|restart|enable|disable)\b/i)?.[1]?.toLowerCase() ?? "";
		const zh: Record<string, string> = { start: "启动", stop: "停止", restart: "重启", enable: "设为开机自启", disable: "取消开机自启" };
		return say(`${zh[action] ?? "启停"} ${svc || "系统服务"}`);
	}
	if (has(/\b(vim?|nano|emacs|code|subl)\b/i)) return say("用编辑器修改文件");
	if (has(/\b(docker|docker-compose|kubectl|helm)\b/i)) return say("执行容器或集群命令");
	if (has(/\b(sh|bash|zsh|python|python3|node|tsx|ts-node|deno|make|gradle|mvn|cargo|go)\s+\S+/i)) return say("运行项目里的脚本或构建");
	return say("执行一条命令");
}

/** 与 src/shared/confirm-detail.ts 的 CONFIRM_DETAIL_MARKER 必须一致（扩展是独立
 *  文件、由 pi 直接加载，无法 import 应用代码；有测试读本文件校验二者一致）。 */
/**
 * 人话摘要：回答用户真正的问题——「**授权来做什么**」。
 *
 * 用户反馈：「弹窗描述非常不具体，只有写什么、覆盖什么，然后就是一堆代码，用户根本不知道
 * 要授权来做什么」。别的 agent 会先说目的（"修改 login 函数里的重试次数"）再说细节。
 * 这里把三样东西凑齐：
 *   1. 模型自己的话（它请求这次编辑前说的那句，来自会话里的上一条 assistant 文本）；
 *   2. 改哪里（读文件、定位被替换片段，回溯到最近的函数/类声明，给出符号名与行号）；
 *   3. 改了什么（从 old/new 文本抽出可读要点：数字/字符串变化、新增函数、增删行数）。
 * 原始 diff 仍然附在「详情（供核对）」之后，但不再作为主要信息。
 */

/** 纯函数：从 old→new 抽出可读要点。可单测（无 fs）。 */
export function summarizeTextChange(oldText: string, newText: string): string[] {
	const out: string[] = [];
	const oldLines = oldText ? oldText.split("\n") : [];
	const newLines = newText ? newText.split("\n") : [];
	// Numbers that changed (retry counts, timeouts, versions…): the single most
	// useful fact in a config-ish edit.
	const oldNums = [...new Set((oldText.match(/\b\d+(?:\.\d+)?\b/g) ?? []))];
	const newNums = [...new Set((newText.match(/\b\d+(?:\.\d+)?\b/g) ?? []))];
	const removedNums = oldNums.filter((n) => !newNums.includes(n));
	const addedNums = newNums.filter((n) => !oldNums.includes(n));
	if (removedNums.length === 1 && addedNums.length === 1) out.push(`把 ${removedNums[0]} 改为 ${addedNums[0]}`);
	else if (addedNums.length > 0 && removedNums.length === 0) out.push(`新增数值 ${addedNums.slice(0, 3).join("、")}`);
	// Newly declared functions/classes/methods — "what is being introduced".
	const declRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func)\s+([A-Za-z_$][\w$]*)/g;
	const decls = (text: string) => [...text.matchAll(declRe)].map((m) => m[1]!);
	const newDecls = decls(newText).filter((d) => !decls(oldText).includes(d));
	if (newDecls.length > 0) out.push(`新增 ${newDecls.slice(0, 3).map((d) => `${d}()`).join("、")}`);
	// Changed string literals.
	const strs = (text: string) =>
		[...text.matchAll(/["'`]([^"'`\n]{2,60})["'`]/g)].map((m) => m[1]!);
	const oldStrs = strs(oldText);
	const addedStrs = strs(newText).filter((x) => !oldStrs.includes(x));
	if (addedStrs.length > 0) out.push(`新增文案「${addedStrs[0]}」`);
	// Size, always: the reader wants to know how big this is.
	if (oldLines.length > 0 || newLines.length > 0) {
		out.push(`删除 ${oldLines.filter((l) => l.trim()).length} 行 / 新增 ${newLines.filter((l) => l.trim()).length} 行`);
	}
	return out;
}

/**
 * 纯函数：在被改动的文件里找到这段旧代码属于哪个函数/类，以及它大概在第几行。
 * 返回 undefined 表示定位不到（片段不在文件里 / 文件读不到）——调用方就不要编造符号名。
 */
export function findEnclosingSymbol(
	fileText: string,
	snippet: string,
): { symbol: string; line: number } | undefined {
	if (!fileText || !snippet) return undefined;
	const at = fileText.indexOf(snippet);
	if (at < 0) return undefined;
	const upTo = fileText.slice(0, at);
	const line = upTo.split("\n").length;
	const declRe = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|def|fn|func|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
	const lines = upTo.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const m = lines[i]!.match(declRe);
		if (m) return { symbol: m[1]!, line };
	}
	return { symbol: "", line };
}

/** 模型自己刚说过的话：这次编辑的"为什么"。取不到就返回 undefined（不编造）。 */
export function lastAssistantIntent(
	entries: Array<Record<string, unknown>>,
	limit = 40,
): string | undefined {
	const tail = entries.slice(-limit);
	for (let i = tail.length - 1; i >= 0; i -= 1) {
		const e = tail[i]!;
		const msg = e.message as { role?: string; content?: unknown } | undefined;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.map((b) => (b as { type?: string; text?: string }).type === "text" ? ((b as { text?: string }).text ?? "") : "")
			.join(" ")
			.replace(/```[\s\S]*?```/g, " ")
			.replace(/[#*`>]/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		// First sentence reads best; cap the length so the dialog stays scannable.
		const firstSentence = text.split(/(?<=[。.!?])\s*/)[0] ?? text;
		const picked = firstSentence.length >= 8 ? firstSentence : text;
		return picked.length > 160 ? `${picked.slice(0, 157)}...` : picked;
	}
	return undefined;
}

const CONFIRM_DETAIL_MARKER = "详情（供核对）";

/** 一句人话 + 原文照附（用户要能核对具体内容）。 */
export function summarizeBash(command: string, intent?: string): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	const shown = oneLine.length > 400 ? `${oneLine.slice(0, 397)}...` : oneLine;
	// 目的（模型自述）在前，命令原文在「详情（供核对）」之后。
	const head = intent ? `${describeBashIntent(command)}\nAI 说：${intent}` : describeBashIntent(command);
	return `${head}\n\n${CONFIRM_DETAIL_MARKER}:\n${shown}`;
}

function firstLine(text: string, max = 90): string {
	const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * 文件修改的人话摘要。
 *
 * 原先给的是「路径 + 替换: 第一行」：看不出改了哪几行、改成什么、还是只是换行差异。
 * 这里先说清动作与规模（改写 N 行 → M 行 / 新增 M 行 / 整份覆盖 / 只是空白变化），
 * 再把改动前后各一行作为可核对详情。
 */
/**
 * 文件修改的确认文案：先说**要做什么**，再说规模，最后附可核对的原文。
 *
 * 用户反馈的原话：「根本弹窗中描述非常不具体，只有写什么，覆盖什么，然后就是一堆代码…
 * 用户根本不知道要授权来做什么」。所以顺序是：
 *   目的（模型自述 + 符号名 + 行号）→ 要点（数值/新增符号/文案变化 + 行数）→ 原文。
 *
 * `intent` 由调用方从会话里取（模型请求编辑前说的那句话）；取不到就不编造。
 * 这里会读文件：判断"新建还是覆盖"、把被替换的片段定位到所在函数/类。扩展运行在工具所在的
 * 那台机器上，所以本地 / WSL / 远程读到的都是同一份文件。
 */
/**
 * 文件修改的确认文案：先说**要做什么**，再说规模，最后附可核对的原文。
 *
 * 用户反馈的原话：「根本弹窗中描述非常不具体，只有写什么，覆盖什么，然后就是一堆代码…
 * 用户根本不知道要授权来做什么」。所以顺序是：
 *   目的（模型自述 + 符号名 + 行号）→ 要点（数值/新增符号/文案变化 + 行数）→ 原文。
 *
 * `intent` 由调用方从会话里取（模型请求编辑前说的那句话）；取不到就不编造。
 * 这里会读文件：判断"新建还是覆盖"、把被替换的片段定位到所在函数/类。扩展运行在工具所在的
 * 那台机器上，所以本地 / WSL / 远程读到的都是同一份文件。
 */
export function summarizeWrite(toolName: string, input: unknown, intent?: string): string {
	const i = (input ?? {}) as { path?: unknown; file_path?: unknown; oldText?: unknown; newText?: unknown; content?: unknown };
	const rawPath = String(i.path ?? i.file_path ?? "(未知路径)");
	const rel = (() => {
		try {
			return relative(process.cwd(), rawPath) || rawPath;
		} catch {
			return rawPath;
		}
	})();
	const head: string[] = [];
	const bullets: string[] = [];
	if (intent) head.push(`AI 说：${intent}`);

	if (toolName === "edit") {
		const oldText = String(i.oldText ?? "");
		const newText = String(i.newText ?? "");
		let where = rel;
		try {
			const found = findEnclosingSymbol(readFileSync(rawPath, "utf8"), oldText);
			if (found) {
				where = found.symbol ? `${rel} 的 ${found.symbol}()（约第 ${found.line} 行）` : `${rel}（约第 ${found.line} 行）`;
			}
		} catch {
			/* 读不到就不编造位置 */
		}
		head.push(`修改 ${where}`);
		bullets.push(...summarizeTextChange(oldText, newText));
		const detail = [
			oldText ? `删掉: ${firstLine(oldText)}` : "",
			newText ? `换成: ${firstLine(newText)}` : "",
		].filter(Boolean).join("\n");
		return composeConfirm(head, bullets, detail);
	}

	const content = String(i.content ?? "");
	const lineCount = content.length > 0 ? content.split("\n").length : 0;
	// 新建还是覆盖：真实存在的文件被整份重写，风险高得多，必须说清楚。
	let exists = false;
	try {
		exists = statSync(rawPath).isFile();
	} catch {
		exists = false;
	}
	head.push(exists ? `覆盖已有文件 ${rel}（整份重写）` : `新建文件 ${rel}`);
	if (exists) bullets.push(`原文件会被整份替换：${lineCount} 行新内容将成为文件全部内容`);
	else bullets.push(`将写入 ${lineCount} 行内容`);
	const firstMeaningful = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	if (firstMeaningful) bullets.push(`开头是：${firstMeaningful.slice(0, 80)}`);
	return composeConfirm(
		head,
		bullets,
		content.split("\n").slice(0, 8).map((l) => l.trim()).filter(Boolean).join("\n"),
	);
}

/** 目的 + 要点 + 原文（原文放在「详情（供核对）」之后，供核对而非首要信息）。 */
function composeConfirm(head: string[], bullets: string[], detail: string): string {
	const lines = [head.join("\n"), ...bullets.map((b) => `· ${b}`)];
	return `${lines.join("\n")}\n\n${CONFIRM_DETAIL_MARKER}:\n${detail || "（无改动内容）"}`;
}


// ---------------------------------------------------------------------------
// 主扩展
// ---------------------------------------------------------------------------

interface ModeState {
	mode: Mode;
	executing: boolean;
	todos: TodoItem[];
	savedTools?: string[];
}

export default function pipiModeSwitch(pi: ExtensionAPI): void {
	let mode: Mode = "auto";
	let executing = false;
	let todos: TodoItem[] = [];
	let savedTools: string[] | undefined;

	// `--plan` (the official extension's startup flag) as an alias for --pipi-mode plan.
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only); alias of --pipi-mode plan",
		type: "boolean",
	});

	pi.registerFlag("pipi-mode", {
		description: "Start in a mode: auto | plan | edit",
		type: "string",
		default: "auto",
	});

	// --- 工具开关 -----------------------------------------------------------

	/**
 * 「先侦察再规划」的提示：只有当 subagent 能力真的在时才对模型说 —— 否则它会照着提示去调用
 * 一个不存在的工具（我们自己也踩过"提示了不存在的命令"这一类坑）。
 * 判据：活动工具里有 subagent（pi-subagent 扩展注册的名字），或 scout/planner 之一。
 */
function subagentHint(): string {
	const tools = (() => {
		try {
			return pi.getActiveTools();
		} catch {
			return [] as string[];
		}
	})();
	const hasSubagent = tools.includes("subagent") || tools.some((t) => t.startsWith("scout") || t.startsWith("planner"));
	if (!hasSubagent) return "";
	return `

Before writing the plan for a non-trivial task, consider delegating the legwork so this
conversation keeps its context for the work itself:
- use the "scout" agent to gather the relevant code, then
- use the "planner" agent with that context to produce the plan.
The app ships both agent definitions plus a /scout-and-plan prompt template that chains them.`;
}

function enablePlanTools(): void {
		if (savedTools === undefined) savedTools = pi.getActiveTools();
		pi.setActiveTools([
			...new Set([...(savedTools ?? []).filter((n) => !PLAN_DISABLED_TOOLS.has(n)), ...PLAN_READ_TOOLS]),
		]);
	}

	function restoreTools(): void {
		if (savedTools !== undefined) {
			pi.setActiveTools(savedTools);
			savedTools = undefined;
		}
	}

	// --- 状态 ---------------------------------------------------------------

	function persistState(): void {
		pi.appendEntry(MODE_ENTRY, { mode, executing, todos, savedTools } satisfies ModeState);
	}

	const lastPushedStatus = { text: "" };

	function updateStatus(ctx: ExtensionContext): void {
		// 机器可解析状态推送：chat UI 据此渲染模式控件/进度。去重：相同
		// 文本不重复发 extension_ui_request（turn_end 可能高频触发）。
		const parsed =
			executing && todos.length > 0
				? statusTextForExec(todos.filter((t) => t.completed).length, todos.length)
				: statusTextFor(mode);
		if (lastPushedStatus.text !== parsed) {
			lastPushedStatus.text = parsed;
			ctx.ui.setStatus(STATUS_KEY, parsed);
		}

		// TUI footer 状态 + 进度 widget
		if (executing && todos.length > 0) {
			const completed = todos.filter((t) => t.completed).length;
			const label = mode === "auto" ? "▶ exec" : humanStatus(mode);
			ctx.ui.setStatus(
				"pipi-mode-human",
				ctx.ui.theme.fg("accent", `${label} ${completed}/${todos.length}`),
			);
		} else if (mode === "plan") {
			ctx.ui.setStatus("pipi-mode-human", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else if (mode === "edit") {
			ctx.ui.setStatus("pipi-mode-human", ctx.ui.theme.fg("accent", "✎ edit"));
		} else {
			ctx.ui.setStatus("pipi-mode-human", undefined);
		}

		if (executing && todos.length > 0) {
			const lines = todos.map((t) =>
				t.completed
					? ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
					: `${ctx.ui.theme.fg("muted", "☐ ")}${t.text}`,
			);
			ctx.ui.setWidget("pipi-mode-todos", lines);
		} else {
			ctx.ui.setWidget("pipi-mode-todos", undefined);
		}
	}

	async function setMode(next: Mode, ctx: ExtensionContext): Promise<void> {
		if (next === mode && !executing) {
			await ctx.ui.notify(`当前已是 ${next} 模式`, "info");
			return;
		}
		const prev = executing ? "exec" : mode;
		executing = false;
		todos = [];
		mode = next;

		if (mode === "plan") {
			enablePlanTools();
		} else {
			restoreTools();
		}
		updateStatus(ctx);
		persistState();
		await ctx.ui.notify(`模式: ${prev} → ${mode}${mode === "plan" ? "（只读）" : mode === "edit" ? "（写操作需确认）" : ""}`, "info");
	}

	async function cycleMode(ctx: ExtensionContext): Promise<void> {
		const current: Mode = executing ? "auto" : mode;
		const idx = MODE_CYCLE.indexOf(current);
		await setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? "auto", ctx);
	}

	// --- 命令与快捷键 --------------------------------------------------------

	pi.registerCommand("mode", {
		description: "Show or switch mode: auto | plan | edit | next",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (!arg) {
				const extra = executing ? "（执行计划中）" : "";
				await ctx.ui.notify(
					`当前模式: ${mode}${extra} — 用法: /mode auto|plan|edit|next（Ctrl+Alt+M 循环切换）`,
					"info",
				);
				return;
			}
			if (arg === "next") return cycleMode(ctx);
			if (arg === "auto" || arg === "plan" || arg === "edit") return setMode(arg, ctx);
			await ctx.ui.notify(`未知模式 "${arg}"。用法: /mode auto|plan|edit|next`, "warning");
		},
	});

	pi.registerCommand("todos", {
		description: "Show plan progress",
		handler: async (_args, ctx) => {
			if (todos.length === 0) {
				await ctx.ui.notify("没有计划。先切到 plan 模式（/mode plan）生成计划", "info");
				return;
			}
			const list = todos.map((t, i) => `${i + 1}. ${t.completed ? "✓" : "○"} ${t.text}`).join("\n");
			await ctx.ui.notify(`计划进度:\n${list}`, "info");
		},
	});

	// `/plan` — the OFFICIAL plan-mode extension's command name (pi ships one at
	// examples/extensions/plan-mode). Ours is a superset (three modes + write
	// confirmation), so we do NOT install the official extension alongside it: both
	// register the same `plan-mode` status key, the same `plan-todos` widget and
	// both intercept `tool_call`, and they would fight. Instead we accept the
	// official surface so pi's docs and muscle memory keep working.
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only). Alias of /mode plan",
		handler: async (_args, ctx) => {
			if (mode === "plan") return setMode("auto", ctx);
			return setMode("plan", ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+m", {
		description: "Cycle mode: auto → plan → edit",
		handler: (ctx) => cycleMode(ctx),
	});

	// The official extension's shortcut, kept as an alias so `Ctrl+Alt+P` (documented
	// in pi's plan-mode README) does what people expect here too.
	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode (alias)",
		handler: (ctx) => (mode === "plan" ? setMode("auto", ctx) : setMode("plan", ctx)),
	});

	// --- tool_call 拦截/确认 --------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "auto") return undefined; // 执行计划期也在 auto：全程不拦
		const input = (event.input ?? {}) as { command?: unknown };

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = String(input.command ?? "");
			const readOnly =
				event.toolName === "bash" ? isReadOnlyBash(command) : !isPowerShellWrite(command);
			if (readOnly) return undefined;

			if (mode === "plan") {
				return {
					block: true,
					reason: `Plan 模式为只读：该命令已拦截。执行写操作请先 /mode auto 或 /mode edit。\n命令: ${command}`,
				};
			}
			// edit 模式逐命令确认
			if (!ctx.hasUI) {
				return { block: true, reason: `edit 模式需要确认，但当前无 UI，按 fail-closed 拦截。\n命令: ${command}` };
			}
			const ok = await ctx.ui.confirm(
				"AI 想执行一条命令",
				// 目的来自模型自己刚说的话（会话里上一条 assistant 文本）——
				// 「用户根本不知道要授权来做什么」的答案在这里，不在 diff 里。
				summarizeBash(command, lastAssistantIntent(ctx.sessionManager.getEntries())),
			);
			if (!ok) return { block: true, reason: "用户在 edit 模式下拒绝了该命令" };
			return undefined;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			// plan 模式下这两个工具已从活动集摘除；此处是防御性兜底。
			if (mode === "plan") {
				return { block: true, reason: "Plan 模式为只读：文件修改已拦截" };
			}
			if (!ctx.hasUI) {
				return { block: true, reason: "edit 模式需要确认，但当前无 UI，按 fail-closed 拦截" };
			}
			const ok = await ctx.ui.confirm(
				event.toolName === "write" ? "AI 想创建或覆盖文件" : "AI 想修改文件",
				summarizeWrite(event.toolName, event.input, lastAssistantIntent(ctx.sessionManager.getEntries())),
			);
			if (!ok) return { block: true, reason: "用户在 edit 模式下拒绝了本次文件修改" };
		}
		return undefined;
	});

	// --- 上下文注入 / 旧标记过滤 ----------------------------------------------

	pi.on("context", async (event) => {
		// Which injections are CURRENT? Those MUST stay in the LLM context —
		// this is how the agent learns it is in plan/edit/execution mode. Only
		// stale injections from a previous mode/finished run get filtered.
		// (Bug history: an earlier version gated only the marker checks and left
		// the customType checks unconditional, so the agent NEVER saw its own
		// plan-mode instructions — it kept trying to write and only learned
		// from the tool-call blocks. Symptom: "运行失败了才知道在 plan 模式".)
		const keepPlan = mode === "plan";
		const keepExec = executing; // full-access plan execution (mode auto)
		const keepEdit = mode === "edit";
		if (keepPlan && keepExec && keepEdit) return undefined; // unreachable combo
		return {
			messages: (event as { messages?: unknown[] }).messages?.filter((m) => {
				if (!keepPlan && isModeInjection(m, PLAN_CONTEXT_TYPE, PLAN_MARKER)) return false;
				if (!keepExec && isModeInjection(m, EXEC_CONTEXT_TYPE, EXEC_MARKER)) return false;
				if (!keepEdit && isModeInjection(m, EDIT_CONTEXT_TYPE, EDIT_MARKER)) return false;
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (mode === "edit") {
			// Agent 必须知道当前处于确认模式，否则它会碎碎念地发起一串小编辑，
			// 让用户点一堆确认框。指导它：合并编辑、被拒后换方案而非重试。
			return {
				message: {
					customType: EDIT_CONTEXT_TYPE,
					content: `${EDIT_MARKER}
The user has enabled edit mode: every write operation (edit/write tools, or bash commands that modify files) is shown to the user for confirmation before it runs.

ALWAYS say what you are about to do in ONE short sentence immediately BEFORE each write operation — in the user's language (Chinese if they write Chinese). That sentence is shown verbatim in the confirmation dialog as 「AI 说：…」, and without it the user cannot tell what they are being asked to authorize.
- Say the intent, not the mechanics: "把登录失败的重试次数从 3 提到 5" — not "editing src/auth.ts".
- Name the effect when it is destructive: "删除 build 目录下的全部产物".

To keep confirmations to a minimum:
- Batch related changes into as few edit/write calls as possible instead of many small ones.
- If the user rejects a change, do NOT retry the same change — ask what they would prefer instead.
- Read-only work (read/grep/bash read-only commands) is never interrupted.`,
					display: false,
				},
			};
		}
		if (mode === "plan") {
			return {
				message: {
					customType: PLAN_CONTEXT_TYPE,
					content: `${PLAN_MARKER}
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions when requirements are ambiguous.

Analyze the code and produce a plan with this shape (it mirrors pi's own planner
subagent output, which we adopt because it is markedly easier to review):

## Goal
One sentence: what the user gets when this is done.

## Plan
A NUMBERED list under a "Plan:" header — these numbers are tracked, and each step
must be small and actionable (name the file/function, not "improve the code"):

Plan:
1. First step description
2. Second step description

## Files to Modify
- path/to/file.ts — what changes there

## New Files (if any)
- path/to/new.ts — its purpose

## Risks
Anything that could break, plus the check that would catch it.

Do NOT attempt to make changes - just describe what you would do.${subagentHint()}`,
					display: false,
				},
			};
		}
		if (executing && todos.length > 0) {
			const remaining = todos.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: EXEC_CONTEXT_TYPE,
					content: `${EXEC_MARKER}
Full tool access is enabled. Remaining plan steps:

${todoList}

Execute each step in order. After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
		return undefined;
	});

	// --- 执行进度跟踪 ---------------------------------------------------------

	pi.on("turn_end", async (event, ctx) => {
		if (!executing || todos.length === 0) return;
		const message = (event as { message?: unknown }).message;
		if (!isAssistantMessage(message)) return;
		if (markCompletedSteps(getTextContent(message), todos) > 0) updateStatus(ctx);
		persistState();
	});

	// --- 计划提取与执行入口 ---------------------------------------------------

	pi.on("agent_end", async (event, ctx) => {
		// 执行完成检查
		if (executing && todos.length > 0) {
			if (todos.every((t) => t.completed)) {
				const completedList = todos.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "pipi-plan-complete", content: `**计划完成！** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executing = false;
				todos = [];
				restoreTools();
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (mode !== "plan") return;

		// 从最后一条 assistant 消息提取 Plan:
		const messages = (event as { messages?: unknown[] }).messages ?? [];
		const lastAssistant = [...messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) todos = extracted;
		}
		if (todos.length === 0) return;
		persistState();

		const todoListText = todos.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planListMessage = {
			customType: "pipi-plan-list",
			content: `**计划步骤（${todos.length}）：**\n\n${todoListText}`,
			display: true,
		};

		if (!ctx.hasUI) {
			// print/json 等无 UI 模式：不阻塞，提示用户手动切换后重发执行指令。
			pi.sendMessage(planListMessage, { deliverAs: "nextTurn" });
			await ctx.ui.notify("已提取计划。执行请 /mode auto 后重新发送任务", "warning");
			return;
		}

		const choice = await ctx.ui.select("计划已列好，接下来做什么？", ["执行计划（跟踪进度）", "留在 plan 模式", "修改计划"]);
		if (choice?.startsWith("执行计划")) {
			const first = todos[0];
			if (!first) return;
			mode = "auto";
			executing = true;
			restoreTools();
			updateStatus(ctx);
			persistState();

			const remainingList = todos.map((t) => `${t.step}. ${t.text}`).join("\n");
			pi.sendMessage(planListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{
					customType: EXEC_CONTEXT_TYPE,
					display: true,
					content: `执行计划。

剩余步骤:
${remainingList}

从第 1 步开始: ${first.text}
每完成一步，在回复中包含 [DONE:n] 标记。`,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "修改计划") {
			const refinement = await ctx.ui.editor("修改计划：", "");
			if (refinement?.trim()) {
				pi.sendMessage(planListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
		// "留在 plan 模式" / Esc 取消 → 无操作，保持 plan 模式
	});

	// --- 会话恢复 -------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("pipi-mode");
		if (flag === "plan" || flag === "edit") mode = flag;
		// `--plan` is boolean (the official extension's flag shape), so presence wins.
		if (pi.getFlag("plan") === true) mode = "plan";

		const entries = ctx.sessionManager.getEntries() as Array<{
			type: string;
			customType?: string;
			data?: ModeState;
			message?: unknown;
		}>;

		// 恢复持久化状态
		const stateEntry = [...entries].reverse().find((e) => e.type === "custom" && e.customType === MODE_ENTRY);
		if (stateEntry?.data) {
			mode = stateEntry.data.mode ?? mode;
			todos = stateEntry.data.todos ?? todos;
			executing = stateEntry.data.executing ?? executing;
			savedTools = stateEntry.data.savedTools;
		}

		// 启动即推送一次当前模式：chat UI（RPC / SDK worker）在会话建立后
		// 立刻能渲染正确的模式控件，不必等第一次切换。setMode 路径已有
		// updateStatus 推送；这里补齐 resume/新会话的初始状态。
		if (executing && todos.length > 0) {
			const completed = todos.filter((t) => t.completed).length;
			ctx.ui.setStatus(STATUS_KEY, statusTextForExec(completed, todos.length));
		} else {
			ctx.ui.setStatus(STATUS_KEY, statusTextFor(mode));
		}

		// resume 时重扫执行起点之后的 [DONE:n]，重建完成状态
		if (stateEntry !== undefined && executing && todos.length > 0) {
			let execIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i]?.customType === EXEC_CONTEXT_TYPE) {
					execIndex = i;
					break;
				}
			}
			const allText = entries
				.slice(execIndex + 1)
				.filter((e) => e.type === "message" && isAssistantMessage(e.message))
				.map((e) => getTextContent(e.message))
				.join("\n");
			markCompletedSteps(allText, todos);
		}

		if (mode === "plan") enablePlanTools();
		updateStatus(ctx);
	});
}
