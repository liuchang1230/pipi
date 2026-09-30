/**
 * pipi 随 app 分发的扩展：审批门 —— 在不可逆操作真正执行前，问用户一句。
 *
 * 为什么需要它：pi 本身**故意不含权限弹窗**（docs/usage.md「It intentionally does
 * not include ... permission popups」，docs/security.md「No Built-in Sandbox」），
 * 工具与扩展都以 pi 进程的权限直接执行。本地这么做还能靠 git + 编辑器撤销兜底，
 * 但 pipi 的卖点是「让 AI 在你的远程服务器上跑」—— 那里一条 `rm -rf` 或
 * `git reset --hard` 之后没有撤销。
 *
 * 本扩展只做**审批**（consent：动手前问一句），不做**沙箱**（containment：OS 层
 * 隔离）。这个区别是诚实的：
 *   1) 拦不住扩展自己干的活 —— pi-rewind 在 session_start 里直接跑 `git add`，
 *      不走 tool_call，本门看不见；
 *   2) bash 命令本质上不可判定 —— 下面是模式匹配，绕过它的写法无穷多。
 * 所以它是「速度缓冲」，不是安全边界。真正的隔离只能靠容器
 * （docs/containerization.md）。
 *
 * 策略由 app 通过环境变量注入（见 src/main/approval-env.ts）：
 *   PIPI_APPROVAL_POLICY     off | destructive | all
 *   PIPI_APPROVAL_TIMEOUT_MS 无人应答时的等待毫秒数
 *
 * **env 缺失 = off**，这是刻意的：同一个文件也会被装进用户自己的 agent 目录、被
 * 命令行里的 `pi` 加载。命令行用户不该突然收到自己没要过的弹窗，所以「不是 app 在
 * 驱动这个进程」必须读作「关闭」。代价是「漏注入 = 静默失效」，所以 app 侧有一条
 * 完备性测试（src/main/__tests__/approval-gate.test.ts）盯着所有 spawn 点。
 *
 * 该文件由主进程启动时写入 ~/.pi/agent/extensions/（见 extension-sync.ts），
 * 并同步到 WSL/远程的 agent 目录。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// —— 与 app 的约定：这些字面量在 src/shared/approval.ts / confirm-detail.ts 里各有
// 一份，测试会核对两边一致，所以不要单方面改。 ——
export const POLICY_ENV = "PIPI_APPROVAL_POLICY";
export const TIMEOUT_ENV = "PIPI_APPROVAL_TIMEOUT_MS";
/** 必须与 src/shared/confirm-detail.ts 的 CONFIRM_DETAIL_MARKER 一致：渲染层用它
 *  把「一句话 + 要点」与「可折叠的等宽核对块」分开（see UiDialog）。 */
export const DETAIL_MARKER = "详情（供核对）";

export const DEFAULT_TIMEOUT_MS = 120000;
export const MIN_TIMEOUT_MS = 10000;
export const MAX_TIMEOUT_MS = 3600000;

/** 弹窗标题，测试用它断言「真的问了」。 */
export const CONFIRM_TITLE = "需要你确认";

export type Policy = "off" | "destructive" | "all";

/** env → 策略。未知/缺失/拼错一律 off（绝不出人意料地开始拦）。 */
export function readPolicy(env: Record<string, string | undefined>): Policy {
  const raw = (env[POLICY_ENV] ?? "").trim().toLowerCase();
  return raw === "destructive" || raw === "all" ? raw : "off";
}

/** env → 超时毫秒。非法值退回默认；结果夹在 [MIN, MAX] 内。 */
export function readTimeoutMs(env: Record<string, string | undefined>): number {
  const n = Number.parseInt((env[TIMEOUT_ENV] ?? "").trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

/** 一条需要用户确认的风险。 */
export interface Danger {
  /** 稳定标识，用于测试、日志与去重。 */
  rule: string;
  /** 一句话说明「AI 要干什么」（弹窗第一行）。 */
  what: string;
  /** 后果（渲染成「· 要点」）。 */
  why: string;
}

interface Rule {
  rule: string;
  re: RegExp;
  what: string;
  why: string;
}

/**
 * 逐片段（`&&` / `;` / `|` 切开后）匹配的规则。
 *
 * 除 `>` 重定向那一条外全部**锚定片段开头**：不锚定就会把「提到」当成「执行」，
 * 于是 `grep -rn sudo docs/`、`echo "rm -rf /"` 都会弹窗 —— 误报比漏报更快让用户
 * 把这个功能关掉。片段开头之前的前缀由 stripWrappers 剥掉。
 */
const SEGMENT_RULES: Rule[] = [
  {
    rule: "find-delete",
    re: /^find\s[^&|;]*(?:-delete\b|-exec\s+rm\b)/,
    what: "批量删除搜索到的文件（find -delete / -exec rm）",
    why: "匹配到的文件会被直接删掉，事前看不到列表",
  },
  {
    rule: "git-reset-hard",
    re: /^git\s+reset\s+--(?:hard|merge|keep)\b/,
    what: "把工作区回退到某个提交（git reset --hard）",
    why: "未提交的改动会被直接丢弃",
  },
  {
    rule: "git-clean",
    re: /^git\s+clean\s[^&|;]*-[a-zA-Z]*[fdx]/,
    what: "删除未跟踪的文件与目录（git clean）",
    why: "新写的、还没进 git 的文件会永久消失",
  },
  {
    rule: "git-force-push",
    re: /^git\s+push\b[^&|;]*(?:--force\b|--force-with-lease\b|\s-f(?:\s|$))/,
    what: "强制推送，覆盖远端历史（git push --force）",
    why: "远端已有的提交会丢，别人拉到过的工作会冲突",
  },
  {
    rule: "git-branch-delete",
    re: /^git\s+branch\s+(?:-D\b|--delete\s+--force\b)/,
    what: "强制删除分支（git branch -D）",
    why: "该分支上未合并的提交会失去引用",
  },
  {
    rule: "git-stash-drop",
    re: /^git\s+stash\s+(?:drop|clear)\b/,
    what: "丢弃暂存的改动（git stash drop / clear）",
    why: "暂存的改动会永久消失",
  },
  {
    rule: "sudo",
    re: /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo|doas|su)\s/,
    what: "以 root 或其他用户身份执行（sudo / su）",
    why: "越权操作会改到系统文件，影响的不只是这个项目",
  },
  {
    rule: "disk",
    re: /^(?:mkfs(?:\.\w+)?|shred)\b|^dd\s[^&|;]*\bof=\/dev\/|>\s*\/dev\/(?:sd|nvme|hd|vd)/,
    what: "直接操作磁盘/块设备（mkfs、dd of=/dev/…、shred）",
    why: "目标写错会毁掉整块盘的数据",
  },
  {
    rule: "fork-bomb",
    re: /:\(\)\s*\{/,
    what: "疑似 fork 炸弹",
    why: "会瞬间耗尽服务器资源，连带影响同一台机器上的其他人",
  },
  {
    rule: "exfil",
    // `\b` not `\s` after the tool name: `curl -d@f` puts the flag right after the
    // space that `curl\s` would have eaten, so the flag needs its own boundary.
    re: /^(?:curl|wget)\b[^&|;]*(?:\s--data[\w-]*\b|\s--post-data\b|\s--post-file\b|\s--upload-file\b|\s-[dFT](?=\s|@|=))/,
    what: "把数据发到外部地址（curl / wget 带数据）",
    why: "可能把服务器上的代码或密钥传出这台机器",
  },
  {
    rule: "npm-publish",
    re: /^(?:npm|pnpm|yarn)\s+publish\b/,
    what: "发布包到 registry（npm publish）",
    why: "一旦发布就很难撤回，版本号也收不回来",
  },
  {
    rule: "chmod-root",
    // `\s+\/(?:\s|$|\*)`: the catastrophic target is the filesystem root, not just
    // "any absolute path" — `chmod 755 /data/app/run.sh` is a normal chore and
    // asking about it is noise.
    re: /^chmod\s+(?:-R\s+)?[0-7]{3,4}\s+\/(?:\s|$|\*)/,
    what: "改根路径的权限（chmod … /）",
    why: "会破坏系统权限，且几乎无法还原",
  },
];

/** 必须看整条命令的规则（管道两侧咬合，切开就丢了语义）。 */
const WHOLE_RULES: Rule[] = [
  {
    rule: "pipe-to-shell",
    re: /(?:^|[\s;&|])(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|k|d)?sh\b/,
    what: "把网上的脚本直接管道进 shell 执行（curl … | sh）",
    why: "执行的是此刻网络上的内容，没有先审阅的机会",
  },
];

/**
 * 剥掉 `sudo` / `nohup` / `time` / `env A=1` / `xargs -0` / `A=1` 这类前缀，让后面的
 * 规则仍然从「真正的命令」开始匹配。（`sudo` 本身在剥之前已单独判过，不会丢。）
 */
const LEADING_WRAPPERS =
  /^(?:(?:sudo|doas|nohup|time|command|nice|setsid|ionice)\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s+|xargs(?:\s+-[^\s]+)*\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

function stripWrappers(segment: string): string {
  return segment.replace(LEADING_WRAPPERS, "");
}

/** `git -C <dir> --no-pager reset --hard` → `git reset --hard`。 */
const GIT_GLOBAL_FLAGS =
  /^git\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)(?:=\S+|\s+\S+)\s+|-P\s+|--\S+\s+)*/;

function gitCore(segment: string): string {
  return segment.replace(GIT_GLOBAL_FLAGS, "git ");
}

/**
 * `rm` 的风险判定。问的是三类：
 *   - 递归删除（`-r` / `-R`）—— 经典灾难，且不可枚举
 *   - 通配 / 目录（`*`、`build/`、`.`、`~`）或 /tmp 之外的绝对路径
 *   - 根目录 `/`
 * 放过的：`rm 某个文件`、`rm -f /tmp/中间的产物` —— 那是 agent 的日常动作，
 * 而且可恢复。误报比漏报更快让用户把这个功能关掉，所以这条线划得窄。
 * 想更严就把 policy 设成 all。
 */
export function riskyRm(segment: string): boolean {
  const m = /^rm\s+(.+)$/.exec(segment.trim());
  if (!m) return false;
  const tokens = m[1].split(/\s+/).filter(Boolean);
  const flags = tokens.filter((t) => t.startsWith("-"));
  const targets = tokens.filter((t) => !t.startsWith("-"));
  // 长选项 `--preserve-root` 不在此列：`--` 后紧跟的不是字母，故不匹配。
  if (flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive")) return true;
  return targets.some((t) => {
    if (/[*?]/.test(t)) return true;
    if (t === "/" || t === "." || t === ".." || t === "~" || t.endsWith("/") || t.startsWith("~")) return true;
    if (t.startsWith("/")) return !(t === "/tmp" || t.startsWith("/tmp/"));
    return false;
  });
}

/**
 * 纯函数：这条命令有哪些需要确认的风险。空数组 = 放过。
 *
 * 导出是为了让 app 的 vitest 直接测 —— 分类器是这套东西唯一的判断逻辑，
 * 必须由表驱动的「该拦 / 不该拦」用例钉住。
 */
export function bashDangers(command: string, depth = 0): Danger[] {
  const found = new Map<string, Danger>();
  const push = (r: { rule: string; what: string; why: string }) => {
    if (!found.has(r.rule)) found.set(r.rule, { rule: r.rule, what: r.what, why: r.why });
  };

  for (const rule of WHOLE_RULES) if (rule.re.test(command)) push(rule);

  // `bash -c "rm -rf /"` 把命令藏进字符串：把载荷也判一遍（限深，别被套娃玩死）。
  // 要遍历**所有**载荷而不是第一个：`bash -c 'ls'; bash -c 'rm -rf /'` 里危险的是后者。
  if (depth < 3) {
    const nested = /(?:^|[\s;&|])(?:bash|sh|zsh|dash)\s+-c\s+(["'])([\s\S]*?)\1/g;
    for (const m of command.matchAll(nested)) {
      for (const d of bashDangers(m[2], depth + 1)) push(d);
    }
  }

  // 按控制流/管道切开逐段判：`cd x && echo "rm -rf"` 只是在打印字符串，不该拦；
  // 而 `curl a | rm -rf b` 里的 rm 仍要拦。
  for (const seg of command.split(/&&|\|\||[;&|\n]/)) {
    const s = seg.trim();
    if (!s) continue;
    for (const rule of SEGMENT_RULES) if (rule.re.test(s)) push(rule);
    const core = gitCore(stripWrappers(s));
    for (const rule of SEGMENT_RULES) if (rule.re.test(core)) push(rule);
    if (riskyRm(core)) {
      push({
        rule: "rm-risky",
        what: "删除文件或目录（rm 递归 / 强制 / 通配）",
        why: "删掉的内容不在 git 里，恢复不了",
      });
    }
  }
  return [...found.values()];
}

/**
 * 写/改「项目目录之外」的文件。纯字符串判断，不做路径规范化 —— 保守方向是
 * 「看起来在外面就问一句」，宁可多问一次。相对路径一律放过（它们就在项目里）。
 */
export function escapesProject(path: unknown, cwd: string): boolean {
  if (typeof path !== "string" || !path || !cwd) return false;
  const p = path.replace(/\\/g, "/");
  // A `..` segment climbs out even when the path starts relative:
  // `write({path: "../../etc/hosts"})` looks in-tree at a glance but is not.
  if (p.split("/").includes("..")) return true;
  const absolute = p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
  if (!absolute) return false;
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && (p === root || p.startsWith(`${root}/`))) return false;
  // 临时目录是正常用法（跑测试、写中间产物），不该问。
  if (p === "/tmp" || p.startsWith("/tmp/")) return false;
  return true;
}

/** 需要过门的工具。read / grep 只读，永远不问。 */
export function isGateTarget(toolName: string): boolean {
  return toolName === "bash" || toolName === "write" || toolName === "edit";
}

/**
 * 汇总一次工具调用要问的风险。`policy = all` 时，即使没命中任何规则也要问
 * （那是用户明确要求的「每次执行命令/改文件都询问」）。
 */
export function collectDangers(
  policy: Policy,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Danger[] {
  if (policy === "off") return [];
  const found = toolName === "bash" && typeof input.command === "string" ? bashDangers(input.command) : [];
  if (typeof input.path === "string" && escapesProject(input.path, cwd)) {
    found.push({
      rule: "outside-project",
      what: `要写项目目录之外的文件：${input.path}`,
      why: `改的不是当前项目（${cwd || "?"}）里的文件，改动会落到别处`,
    });
  }
  if (found.length === 0 && policy === "all" && isGateTarget(toolName)) {
    found.push({
      rule: `all:${toolName}`,
      what: toolName === "bash" ? "要执行一条命令" : "要修改一个文件",
      why: "你选择了「每次执行命令/改文件前都询问」",
    });
  }
  return found;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（共 ${text.length} 字符，已截断）`;
}

/** 需要用户核对的「原样材料」（渲染层排版成等宽、默认折叠）。 */
export function dangerDetail(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return truncate(String(input.command ?? ""), 2000);
  const parts: string[] = [String(input.path ?? "")];
  if (typeof input.content === "string") parts.push(truncate(input.content, 1500));
  if (Array.isArray(input.edits)) {
    for (const e of input.edits.slice(0, 5)) {
      const edit = e as { oldText?: unknown; newText?: unknown };
      parts.push(`- ${truncate(String(edit.oldText ?? ""), 300)}`);
      parts.push(`+ ${truncate(String(edit.newText ?? ""), 300)}`);
    }
  }
  return truncate(parts.join("\n"), 4000);
}

/**
 * 弹窗正文。前半是一句话 + 要点，`DETAIL_MARKER` 之后是原样材料 —— 渲染层
 * （UiDialog 的 ConfirmMessage）据此排版：一句话大而居中，材料默认折叠。
 *
 * 这里**故意不显示倒计时**：审批门上挂倒计时会逼人快点点「允许」。改为在要点里
 * 说清「N 秒无人应答视为拒绝」，知情但不施压。
 */
export function composeMessage(dangers: Danger[], cwd: string, timeoutMs: number): string {
  const lines = [`⚠️ ${dangers[0].what}`];
  for (const d of dangers) lines.push(`· ${d.why}`);
  if (cwd) lines.push(`· 位置：${cwd}`);
  lines.push(`· ${Math.round(timeoutMs / 1000)} 秒内无人应答将视为拒绝`);
  return `${lines.join("\n")}\n\n${DETAIL_MARKER}:\n`;
}

export default function (pi: ExtensionAPI) {
  const env = process.env as Record<string, string | undefined>;
  const policy = readPolicy(env);
  if (policy === "off") return;
  const timeoutMs = readTimeoutMs(env);

  pi.on("tool_call", async (event: any, ctx) => {
    const toolName = String(event?.toolName ?? "");
    const input = (event?.input ?? {}) as Record<string, unknown>;
    const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
    const dangers = collectDangers(policy, toolName, input, cwd);
    if (dangers.length === 0) return;

    const what = dangers[0].what;
    const detail = dangerDetail(toolName, input);

    // 用 signal 而不是 timeout：只有它能区分「用户说不」和「没人应答」
    // （docs/extensions.md「Return values on timeout」），而这决定我们回给模型的
    // 话 —— 前者要它换个思路，后者要它别傻等一个不在电脑前的人。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let allowed = false;
    try {
      if (typeof ctx?.ui?.confirm !== "function") throw new Error("no UI");
      allowed =
        (await ctx.ui.confirm(CONFIRM_TITLE, `${composeMessage(dangers, cwd, timeoutMs)}${detail}`, {
          signal: controller.signal,
        })) === true;
    } catch {
      // 问不出来就绝不能默认放行：审批门拿不到答案时，安全的一侧是「拒绝」。
      return {
        block: true,
        reason: `审批门无法向用户提问（宿主没有可用的 UI），已按拒绝处理：${what}。不要重试，先说明你需要什么确认。`,
      };
    } finally {
      clearTimeout(timer);
    }
    if (allowed) return;

    const timedOut = controller.signal.aborted;
    return {
      block: true,
      reason: timedOut
        ? `等待用户确认超时（约 ${Math.round(timeoutMs / 1000)} 秒无人应答），已按拒绝处理：${what}。用户现在可能不在电脑前 —— 不要重试这条命令，先停下来说明你需要什么确认。`
        : `用户拒绝了这条操作：${what}。不要重试同一条命令，也不要换个写法绕过；先说明你想达到什么目的，让用户决定怎么做。`,
    };
  });
}
