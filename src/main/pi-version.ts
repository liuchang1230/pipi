/**
 * pi-version.ts — 目标机上的 pi：怎么把它叫起来、它是哪个版本、怎么把它对齐到
 * app 的 pin。
 *
 * 它只认两样东西：一个命令运行器（`CommandRunner`）和一份缓存身份（`key`）。
 * 它**不认识**目标词汇（`Target` / `SessionTarget` / 渲染层的 `TargetRef`）：
 * 凭据、二进制与 argv 由绑定方给，所以它不需要、也不该长出第七份「目标」。
 * 决策与备选方案：`docs/adr/0007-pi-runtime-seam.md`。
 *
 * 契约：
 * - 命令文本是 POSIX 脚本，跑在目标的**登录交互 shell** 里（`bash -ic '…'`）：
 *   远端 PATH 常由 rc 文件设置（nvm / bun / ~/.local/bin），非登录 shell 看不到。
 *   三种远程传输今天各自手写了这一层，收在这里，绑定方就只剩「凭据 + argv」。
 * - 失败抛 `PiCommandError`（kind + phase + 原始 stderr + 已产出的日志）；
 *   **面向用户的文案由边界翻**，本模块不产出中文。
 * - 事实与策略分开：这里只回答「探测到什么版本」「哪一步失败了」；
 *   什么算「漂移」、要不要提示、要不要对齐，由调用方决定。
 */
import type { CommandRunner, RunResult } from "./runner";

/** 目标上的 pi 该怎么被叫起来。不含凭据——那是绑定方的事。 */
export interface PiTarget {
  /** 目标上的项目工作目录。省略则留在登录 shell 的默认目录。 */
  cwd?: string;
  /** PI_CODING_AGENT_DIR；只在形状安全时才注入（见 targetPiCommand）。 */
  agentDir?: string;
}

/** 一次「对某个目标上的 pi 做探测/对齐」的完整输入。 */
export interface PiPort {
  run: CommandRunner;
  /** 缓存身份（`"local"` / `"wsl:<distro>"` / `ssh:<user>@<host>:<port>[agentDir]`）。
   *  版本缓存挂在它上面：换目标就换 key。 */
  key: string;
  target?: PiTarget;
}

/** 探测结果的事实部分。`version` 为 null 表示输出里没有 semver（今天调用方
 *  把它当「远端 pi 起不来」）。 */
export interface PiProbeResult {
  version: string | null;
  /** 原始 stdout，给日志与诊断用。 */
  raw: string;
}

export interface PiAlignResult {
  /** 安装那一步的 stdout，原样给用户看的日志。 */
  output: string;
  /** 安装后实测到的版本；null = 探测不到。是否等于 pin 由**调用方**判定。 */
  version: string | null;
}

/** 探测超时。20s：一次 ssh 连接 + 一个 node 进程冷启动。 */
export const PROBE_TIMEOUT_MS = 20_000;
/** 对齐超时。600s：对齐命令可能跑两次 npm（默认源，再 npmmirror 回退），
 *  一个被黑洞掉的默认源也得给镜像留出时间。 */
export const ALIGN_TIMEOUT_MS = 600_000;
/** 探测结果（含失败）的缓存时长。失败也缓存是**今天的**行为：否则每次切标签
 *  都会重新发起一次 ssh 连接。 */
export const PROBE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type PiErrorKind = "timeout" | "failed";
/** 对齐的两步：安装与安装后的验证。失败发生在哪一步决定用户看到什么。 */
export type PiErrorPhase = "install" | "verify";

/** 一次失败的 pi 命令。信息全在里面：边界只需要翻译，不需要重新猜测。 */
export class PiCommandError extends Error {
  constructor(
    readonly kind: PiErrorKind,
    readonly phase: PiErrorPhase | undefined,
    /** 远端 stderr 原文——`pi: command not found`、undici 的 markAsUncloneable
     *  崩溃都在这里，边界的友好文案就是靠它分流的。 */
    readonly stderr: string,
    /** 运行器给的原因：`ssh not found` / `exit 1` / `timeout` / `spawn failed: …`。 */
    readonly detail: string,
    /** 失败前已经拿到的输出（验证失败时用户在安装日志里看到的那些）。 */
    readonly output: string,
  ) {
    super(`pi ${phase ?? "probe"} ${kind === "timeout" ? "timed out" : `failed: ${detail}`}`);
    this.name = "PiCommandError";
  }
}

/** Take the first `x.y.z` in a string. */
export function parseVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Take the last semver-looking line from `pi --version` output: interactive
 * shells print banners first, and pi's own version line comes last. */
export function pickVersionFromOutput(output: string): string | null {
  return [...output.split(/\r?\n/)].reverse().map(parseVersion).find((v): v is string => v !== null) ?? null;
}

/** 目标 shell 里的 pi 命令。`cwd` 走 base64：路径没有 shell 引号边界，也不会
 *  在嵌套的 `bash -ic '…'` 里提前把引号闭合。 */
export function targetPiCommand(target: PiTarget | undefined, command: string): string {
  const agentDir = target?.agentDir?.trim();
  // Match pty's AgentDir constraints even though tabs were already validated.
  const agentEnv = agentDir && /^(?:~|~\/[-A-Za-z0-9_./]+|\/[-A-Za-z0-9_./]+)$/.test(agentDir) && !agentDir.includes("..")
    ? `export PI_CODING_AGENT_DIR='${agentDir}' && `
    : "";
  const cwd = target?.cwd;
  if (!cwd) return `${agentEnv}${command}`;
  // Paths are transferred as base64: no shell quoting edge cases and the
  // check/update target matches the tab's actual project working directory.
  const encodedCwd = Buffer.from(cwd, "utf8").toString("base64");
  // base64 has no shell metacharacters, so it can stay unquoted inside the
  // nested `bash -ic '…'` layer (inner single quotes would terminate it).
  return `P="$(printf %s ${encodedCwd} | base64 -d)"; case "$P" in "~") P="$HOME";; "~/"*) P="$HOME/\${P#\\~/}";; esac; cd "$P" && ${agentEnv}${command}`;
}

/** Build the remote align command. No single quotes (it nests inside
 * `bash -ic '…'`) and no shell metacharacters from inputs.
 * 只装我们钉住的那个版本：用户自己配的扩展包不是 app 的事（ADR 0009）。
 * When withRegistryFallback is set, npm falls back to npmmirror in the SAME
 * command: the official registry is frequently unreachable from China
 * servers (direct egress), and when npm can't reach a registry it may serve
 * STALE LOCAL CACHE metadata instead — which surfaces as a bogus ETARGET
 * "No matching version" for versions that were published days ago.
 * npmmirror is China-reachable and syncs from the official registry within
 * hours, so it is the reliable retry target. bun has no --registry flag →
 * `bun pm` config unchanged; its default registry is the official one.
 */
export function buildRemoteAlignCommand(version: string, withRegistryFallback = false): string {
  // fetch-timeout/retries are clamped so a black-holed default registry
  // cannot eat the whole 600s budget before the npmmirror fallback runs.
  const npmFlags = "--fetch-timeout=60000 --fetch-retries=1 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=10000";
  const npmInstall = `npm install -g ${npmFlags} @earendil-works/pi-coding-agent@${version}`;
  const npmSpec = withRegistryFallback ? `${npmInstall} || ${npmInstall} --registry=https://registry.npmmirror.com` : npmInstall;
  // 2026-10-07 事故守卫：若 PATH 上的 pi 来自 pi.dev 官方安装器的托管树
  // （/root/.local/share/pi-node/node-*/bin/pi），`npm` 往往也解析到托管树
  // 自带的 npm —— `npm install -g` 就会重写活着的托管树内部，升级到一半时
  // 旧进程惰性加载 chunk 撞上「入口已换、部分文件未落地」的中间态，报
  // Cannot find module …/openai-completions-*.js（实测 36.151.162.7）。
  // 这种安装由 pi 自己的 `pi update` 管理，npm -g 对它永远是错位安装：
  // 直接报错退出，让用户先 `pi update`（或卸载托管版换 npm 安装）。
  const guard = `P=$(command -v pi || true); case "$P" in */pi-node/node-*/bin/*) echo "pipi-align-blocked: pi 来自 pi.dev 安装器（pi-node 托管树），请在目标机上用 pi 自带的升级命令更新，或卸载托管版后重试对齐" >&2; exit 3;; esac;`;
  return `${guard} case "$P" in */.bun/*) ${npmInstall};; *) ${npmSpec};; esac`;
}

/** 把一行 POSIX 脚本放进登录交互 shell。脚本自身**不能含单引号**（会提前
 *  闭合外层引号）——`buildRemoteAlignCommand` 为此专门没有引号。 */
function loginShell(command: string): string {
  return `bash -ic '${command}'`;
}

function toError(phase: PiErrorPhase | undefined, result: RunResult, output = ""): PiCommandError {
  const kind: PiErrorKind = result.error === "timeout" ? "timeout" : "failed";
  const detail = result.error ?? (result.code === null ? "no exit code" : `exit ${result.code}`);
  return new PiCommandError(kind, phase, result.stderr, detail, output);
}

async function rawProbe(port: PiPort): Promise<RunResult> {
  return port.run({
    command: loginShell(targetPiCommand(port.target, "pi --version")),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

/** 跑一次 `pi --version`。无缓存——需要缓存用 cachedProbe。 */
export async function probe(port: PiPort): Promise<PiProbeResult> {
  const result = await rawProbe(port);
  if (!result.ok) throw toError(undefined, result);
  return { version: pickVersionFromOutput(result.stdout), raw: result.stdout };
}

type ProbeCacheEntry =
  | { checkedAt: number; facts: PiProbeResult; error?: undefined }
  | { checkedAt: number; facts?: undefined; error: PiCommandError };

const probeCache = new Map<string, ProbeCacheEntry>();

/** 带缓存的探测（TTL 见 PROBE_CACHE_TTL_MS）。失败也进缓存并原样重抛：这是
 *  今天的行为，也是唯一能避免「每次切标签都摸一次 ssh」的形状。 */
export async function cachedProbe(port: PiPort): Promise<PiProbeResult> {
  const hit = probeCache.get(port.key);
  if (hit && Date.now() - hit.checkedAt < PROBE_CACHE_TTL_MS) {
    if (hit.error) throw hit.error;
    return hit.facts;
  }
  try {
    const facts = await probe(port);
    probeCache.set(port.key, { checkedAt: Date.now(), facts });
    return facts;
  } catch (error) {
    if (error instanceof PiCommandError) probeCache.set(port.key, { checkedAt: Date.now(), error });
    throw error;
  }
}

/** 丢掉一个目标的探测缓存。对齐成功后必须调用——缓存里是安装前的版本。 */
export function invalidate(key: string): void {
  probeCache.delete(key);
}

/** 清空整个探测缓存。测试用；注意与上面对齐成功时的**按 key** 失效不同。 */
export function clearProbeCache(): void {
  probeCache.clear();
}

/**
 * 把目标上的 pi 对齐到 `pin`：装（npm 保留 bun 安装位置），然后**验证**。
 * 验证不是可选项——新版 pi 需要 undici 的 `markAsUncloneable`，老 Node
 * （<20.10）与所有稳定版 Bun 都没有：安装可以成功而 `pi` 依然起不来。
 *
 * 版本是否等于 pin 不由这里判定（事实留给调用方）：装完返回实测版本，探测
 * 失败抛 phase="verify" 的错误，并按今天的语义把安装日志带回去。
 */
export async function align(port: PiPort, pin: string): Promise<PiAlignResult> {
  const install = await port.run({
    command: loginShell(targetPiCommand(port.target, buildRemoteAlignCommand(pin, true))),
    timeoutMs: ALIGN_TIMEOUT_MS,
  });
  const output = install.stdout;
  if (!install.ok) throw toError("install", install, output);
  // 装完的这一刻缓存就已经过期了，验证成不成功都一样。
  invalidate(port.key);
  const verified = await rawProbe(port);
  if (!verified.ok) throw toError("verify", verified, output);
  return { output, version: pickVersionFromOutput(verified.stdout) };
}
