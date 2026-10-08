/**
 * User-package mirror（2026-10-07）—— 把用户本机 `~/.pi/agent/settings.json`
 * `packages` 里的自装扩展包，镜像到远程/WSL 目标机。
 *
 * 为什么存在：pipi 的远程会话此前只带 app 自有内容（扩展/技能/agents，见
 * content-sync.ts 四通道），用户的第三方包（pi-rewind、pi-web-access、
 * pi-subagents…）一律不 traveling —— ADR 0009 刻意划的界：用户扩展包归用户管，
 * app 不提议、不代劳。2026-10-07 用户明确拍板要这批包跟着上远程（他要的正是
 * 「远程 = 本机的镜像」体验），于是边界收窄为：
 *
 *   app 替你搬运，但**永不决定**搬什么、升到哪 —— 范围=本机清单，版本=本机
 *   当前 pin，随本机变而变；远程上你自己 pi install 的多余包会在下一次
 *   reconcile 被掰回来（镜像=双向收敛）。
 *
 * 与 ADR 0009 不矛盾的三条边界（设置文案同款）：
 *   1. 默认关闭 —— 不开就是旧行为（app 不碰用户包）。
 *   2. 只镜像，不追新 —— 版本取自本机包清单，不查询 registry 最新。
 *   3. 只动远程的 pi 包清单（npm/package.json + node_modules）—— settings.json
 *      / auth / skills 等一切其他文件依旧永不过境。
 *
 * 为什么不用 content-sync 那套（账本 + 逐文件投递）：包是 pi 包管理器装在
 * `~/.pi/agent/npm/` 的**依赖树**，逐文件投递既脆弱又越俎代庖 —— 正确的原语
 * 是 pi 自己的 `pi install <spec>`（写包清单、装依赖、处理 trust），本模块只
 * 负责「算清 spec 清单 + 跑命令」。
 *
 * 传输：任意 CommandRunner（runner.ts 的缝）。key-auth ssh 由调用方绑
 * runSshCommand；密码 ssh 绑 ssh2 conn.exec（sftp lease 只有文件 IO 没有
 * exec，单独包一个）；WSL 绑 wsl.exe。命令行只含短 spec（`npm:pkg@1.2.3`），
 * 无内容载荷 —— 不踩 32,767 字符 argv 限制。
 *
 * 版本对账读远程 `~/.pi/agent/npm/package.json`（pi 包管理器的直接依赖清单，
 * 即用户包；传递依赖在 node_modules 不在这里）——比解析 `pi packages list`
 * 的 human 文本确定得多（那个不回显版本）。
 *
 * 幂等：diff 为空 → 零写入（第二次连接是空跑）。失败不重试不排队 —— 下次
 * 连接自然重算（同 syncKeyAuthExtensions 模式）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./runner";

/** 一条镜像目标：包名 + 本机钉住的版本。 */
export interface MirrorSpec {
  name: string;
  version: string;
}

/** 远端包清单里的一条：名字 + 记录的版本区间（如 `^0.5.0`）。 */
export interface RemotePkg {
  name: string;
  range: string;
}

/** `npm:pi-rewind@0.5.0` —— pi install 接受的确切来源形态。 */
export function specToSource(spec: MirrorSpec): string {
  return `npm:${spec.name}@${spec.version}`;
}

/** `^1.2.3`/`~1.2.3`/`1.2.3` → `1.2.3`（对账只关心主版本钉没钉对）。 */
export function stripRange(range: string): string {
  return range.replace(/^[^0-9]*/, "");
}

/**
 * 本机镜像清单 = settings.json `packages` 的名字 × npm/package.json 解析出的
 * 版本。pi install 在 settings.json 里只记 `npm:name`（无版本）；实际安装的
 * 版本记在 `~/.pi/agent/npm/package.json` 的 dependencies（`^0.5.0` 形态）——
 * 那才是「本机现在跑的是什么」的真值。两处都有的条目才镜像；缺版本的跳过
 * （没有 pin 就没有可镜像的确定性）。
 */
export function readLocalPackages(agentDir = join(homedir(), ".pi", "agent")): MirrorSpec[] {
  const settingsFile = join(agentDir, "settings.json");
  const npmFile = join(agentDir, "npm", "package.json");
  if (!existsSync(settingsFile)) return [];
  let names: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown };
    if (!Array.isArray(parsed.packages)) return [];
    for (const raw of parsed.packages) {
      if (typeof raw !== "string") continue;
      const m = /^npm:(@?[^@]+)(?:@(.+?))?\s*$/.exec(raw.trim());
      if (m) names.push(m[1]!);
    }
  } catch {
    // 读不了本机清单 = 没有可信的镜像源：返回空让 reconcile 变成空跑，
    // 绝不能因此跑去清空远程。
    return [];
  }
  // 解析版本：优先 npm/package.json（本机实际安装的）；settings.json 条目自带
  // @version 时作为兑底（包已从 npm 目录移除但清单还没清的中间态）。
  let deps = new Map<string, string>();
  if (existsSync(npmFile)) {
    try {
      const parsed = JSON.parse(readFileSync(npmFile, "utf8")) as { dependencies?: Record<string, string> };
      deps = new Map(Object.entries(parsed.dependencies ?? {}).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]));
    } catch {
      // 解析不出就只剩 settings 自带版本这条兑底路。
    }
  }
  const specs: MirrorSpec[] = [];
  for (const name of names) {
    const fromDeps = deps.get(name.toLowerCase());
    const version = fromDeps ? stripRange(fromDeps) : undefined;
    if (version) specs.push({ name, version });
  }
  return specs;
}

/**
 * 解析远程 `~/.pi/agent/npm/package.json` 的 dependencies（= 用户包清单）。
 * stdout 可能混有 shell 噪音：取第一个 `{` 到最后一个 `}` 之间的片段解析。
 * 解析不出就返回空 —— 上层对「读不到」的处理是收手，不是清空。
 */
export function parseRemoteDeps(stdout: string): RemotePkg[] {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { dependencies?: Record<string, string> };
    const deps = parsed.dependencies ?? {};
    return Object.entries(deps).map(([name, range]) => ({ name, range: String(range ?? "") }));
  } catch {
    return [];
  }
}

/**
 * 已装（远程 dependencies）vs 期望（本机清单）→ 精确的 install/remove 计划。
 *   - 名字不在远端，或远端 pin 的主版本不同 → 装（pi install 幂等，重装即升级/降级）
 *   - 名字在远端但不在本机清单 → 删（本机卸载了，远程跟随）
 *   - 其余（含 ^/~ 前缀差异）→ 视为一致，不动
 */
export function planMirror(
  wanted: MirrorSpec[],
  installed: RemotePkg[],
): { install: MirrorSpec[]; remove: string[] } {
  const installedByName = new Map(installed.map((p) => [p.name.toLowerCase(), p]));
  const install = wanted.filter((s) => {
    const have = installedByName.get(s.name.toLowerCase());
    return !have || stripRange(have.range) !== stripRange(s.version);
  });
  const wantedNames = new Set(wanted.map((s) => s.name.toLowerCase()));
  const remove = installed.filter((p) => !wantedNames.has(p.name.toLowerCase())).map((p) => p.name);
  return { install, remove };
}

/**
 * 一次 reconcile 的脚本：先删多余（pi remove），再装缺失（pi install）。
 * 删除失败不阻断安装（失败模式是「包已经不在」，无害）；安装失败让退出码
 * 暴露出去。npmmirror 兜底与对齐命令同款理由：国内服务器直连 registry 常
 * 年超时，镜像数小时内同步官方源。结尾哨兵行用于区分「脚本跑完」与
 * 「sh -s 半路死了但退出码是 0」的传输假象。
 */
export function buildMirrorScript(params: { install: MirrorSpec[]; remove: string[] }): string {
  const parts: string[] = [];
  for (const name of params.remove) {
    parts.push(`pi remove npm:${name} >/dev/null 2>&1 || true`);
  }
  for (const spec of params.install) {
    const source = specToSource(spec);
    parts.push(`pi install ${source} || pi install ${source} --registry=https://registry.npmmirror.com`);
  }
  if (parts.length === 0) return "";
  parts.push("echo PIPI_MIRROR_DONE");
  return parts.join("\n");
}

export interface MirrorResult {
  ok: boolean;
  /** 本轮实际执行的变更（都为空 = 已收敛，零写入）。 */
  installed: string[];
  removed: string[];
  error?: string;
}

/** 远程 pi 包清单的绝对路径（探测用；home 由远程 shell 解析）。 */
export const REMOTE_NPM_PACKAGE_JSON = `"$HOME/.pi/agent/npm/package.json"`;

/**
 * 跑一轮镜像（probe → plan → apply）。run 由调用方绑定到具体传输
 * （key-auth ssh / ssh2 密码 exec / wsl）。apply 超时要覆盖最坏情况：
 * N 个包 × 冷缓存的 npm install（首次可能真要几分钟）。
 */
export async function reconcilePackages(
  run: CommandRunner,
  wanted: MirrorSpec[],
  timeoutMs = 600_000,
): Promise<MirrorResult> {
  if (wanted.length === 0) return { ok: true, installed: [], removed: [] };
  const probe = await run({
    command: `cat ${REMOTE_NPM_PACKAGE_JSON} 2>/dev/null || true`,
    timeoutMs: 60_000,
  });
  // 探测失败（连接断）：不区分「没装」与「读不到」——读不到就收手，
  // 绝不能把「读不到」当「没装」去执行删除。cat 失败但命令本身 ok
  // （`|| true`）时 stdout 为空 → parse 出空清单 → 装全部、删零，安全。
  if (!probe.ok) {
    return { ok: false, installed: [], removed: [], error: probe.error ?? "probe failed" };
  }
  const installed = parseRemoteDeps(probe.stdout);
  const plan = planMirror(wanted, installed);
  if (plan.install.length === 0 && plan.remove.length === 0) {
    return { ok: true, installed: [], removed: [] };
  }
  const script = buildMirrorScript(plan);
  const apply = await run({ command: "sh -s", stdin: script, timeoutMs });
  const done = apply.ok && apply.stdout.includes("PIPI_MIRROR_DONE");
  return {
    ok: done,
    installed: plan.install.map(specToSource),
    removed: plan.remove.map((n) => `npm:${n}`),
    error: done ? undefined : apply.error ?? `apply failed${apply.stderr.trim() ? `: ${apply.stderr.trim().slice(-300)}` : ""}`,
  };
}
