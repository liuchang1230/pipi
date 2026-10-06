/**
 * pi 及扩展更新检查（RPC 聊天模式没有 TUI 的 "Update Available" 横幅，
 * 由 app 层补齐）：启动时异步对比本地版本与 npm registry 最新版，
 * 有新版则提示；一键执行 `pi update`（pi 自身 + 扩展包一起更新）。
 */
import { app, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildRemoteKey, findSshBin, findWslBin } from "./pty";
import { bundledPiVersion, bundledPiPackagePath, localPiSpawnPlan, probeOutcome, resolveLocal } from "./local-pi";
import { classifyPiDrift, type PiDrift, type PiProbeOutcome } from "../shared/pi-drift";
import { compareVersions } from "../shared/version-compare";
import type { Target } from "./target-fs";
import { runSshCommand } from "./ssh-exec";
import { runSsh2Command } from "./ssh2-exec";
import { runWslCommand } from "./wsl-exec";
import { align, cachedProbe, parseVersion, PiCommandError, type PiPort } from "./pi-version";

const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest";
const APP_RELEASES_URL = "https://api.github.com/repos/liuchang1230/pipi/releases/latest";

export interface UpdateInfo {
  current: string | null;
  latest: string | null;
  /** Configured npm/git pi packages with newer versions available. */
  extensions: string[];
  hasUpdate: boolean;
  /** 契约版本（捆绑 pi）与实际会跑的那个 pi 的关系。`hasUpdate` 说的只是
   *  「npm 上有更新的版本」，漂移说的是「是不是契约版本」——两件事。 */
  drift: PiDrift;
  /** 本机终端 TUI 真正启动的那个 pi（全局 `pi` 命令）的漂移。远程目标没有
   *  这一项；本机聊天/更新走的是契约版本（`drift`）。 */
  terminalDrift?: PiDrift;
  error?: string;
}

export interface UpdateRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface RemoteUpdateInfo {
  /** Sanitized target identity; credentials never cross back to the renderer. */
  target: { kind: "ssh" | "wsl" | "local"; label: string };
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  /** pi update --all also updates configured extension packages. */
  extensions: string[];
  /** 目标机上那个 pi 的漂移（ADR 0008）：与契约不一致、不在、跑不起来，
   *  是四种不同的事。 */
  drift: PiDrift;
  error?: string;
}

/** Application update metadata from the public GitHub Releases endpoint. */
export interface AppUpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  downloadUrl?: string;
  releaseUrl?: string;
  notes?: string;
  error?: string;
}

let cached: UpdateInfo | null = null;
let lastCheckedAt = 0;
let updateInFlight = false;
let cachedApp: AppUpdateInfo | null = null;
let appLastCheckedAt = 0;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // re-check at most every 6h

function runPi(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // node-vs-shim 的分支与本地 RPC 启动共用一条（`localPiSpawnPlan`）：
    // 两边都偏好 node + cli.js，因为那是终端里跑 `pi` 的同一件事。
    const plan = localPiSpawnPlan(args);
    const child = spawn(plan.file, plan.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* */
      }
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 本机**契约运行时**（捆绑 pi，node + cli.js）的探测结论。今天渲染层要的
 *  `current` 就是它的版本；漂移状态（runtime: "bundled"）也用它。 */
async function probeLocalBundled(): Promise<PiProbeOutcome> {
  try {
    const { code, stdout, stderr, timedOut } = await runPi(["--version"], 20000);
    if (timedOut) return { kind: "timeout" };
    if (code === 0) return { kind: "version", version: parseVersion(stdout.split(/\r?\n/)[0]) };
    // node 不在 / 捆绑的 cli.js 被删：二进制层面的缺失，与「跑不起来」不同。
    if (/ENOENT|not recognized as an internal or external command/i.test(stderr)) return { kind: "absent" };
    const detail = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
      .find((l) => /error|cannot find|not found|denied/i.test(l)) ?? stderr.trim().split(/\r?\n/)[0] ?? "";
    return { kind: "unrunnable", detail: detail.slice(0, 200) || `exit ${code ?? "?"}` };
  } catch (e) {
    return { kind: "unrunnable", detail: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
  }
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return parseVersion(data.version);
  } catch {
    return null;
  }
}

/** Resolve pi's package entry file for the standalone checker child.
 *
 * Order:
 *  1. global npm install (real files on disk — works in the packaged app too,
 *     and is the install that `pi update` actually maintains);
 *  2. the app's own node_modules (dev); paths inside app.asar are skipped
 *     because a standalone node process cannot read asar archives.
 */
function resolvePiPackageEntry(): string | null {
  const piBin = resolveLocal().piBin;
  if (piBin) {
    const globalEntry = join(dirname(piBin), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    if (existsSync(globalEntry)) return globalEntry;
  }
  try {
    const appEntry = join(app.getAppPath(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    if (existsSync(appEntry) && !appEntry.includes("app.asar")) return appEntry;
  } catch {
    /* ignore */
  }
  return null;
}

/** Ask pi's package manager which configured extensions have updates.
 *
 * This must run in a standalone Node process. Electron's embedded Node can be
 * older/different from the Node version supported by pi's transitive undici
 * dependency (which may use newer webidl APIs) — importing the package in the
 * Electron main process would crash the whole app at startup.
 *
 * The script text deliberately avoids static `import ... from` statements:
 * electron-vite injects its CJS shims right after the last static import it
 * can regex-find in the bundle, and a lookalike import inside this string
 * would make the shim (including `__dirname`) land inside the string, breaking
 * the whole main process. Dynamic `import()` is used instead.
 */
async function getExtensionUpdates(): Promise<string[]> {
  const nodeBin = resolveLocal().nodeBin;
  const piEntry = resolvePiPackageEntry();
  if (!nodeBin || !piEntry) return [];
  const cwd = process.cwd();
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const script = `
    const { DefaultPackageManager, SettingsManager } = await import(${JSON.stringify(pathToFileURL(piEntry).href)});
    const manager = new DefaultPackageManager({
      cwd: ${JSON.stringify(cwd)},
      agentDir: ${JSON.stringify(agentDir)},
      settingsManager: SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)})
    });
    const updates = await manager.checkForAvailableUpdates();
    process.stdout.write(JSON.stringify(updates.map((update) => update.displayName)));
  `;
  return new Promise((resolve) => {
    const child = spawn(nodeBin, ["--input-type=module", "-e", script], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      resolve([]);
    }, 20000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => { stdout += data; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => { stderr += data; });
    child.once("error", (error) => {
      clearTimeout(timer);
      console.warn("[update] extension check failed:", error.message);
      resolve([]);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn("[update] extension check failed:", stderr.trim().slice(-500));
        resolve([]);
        return;
      }
      try {
        const updates = JSON.parse(stdout.trim());
        resolve(Array.isArray(updates) ? updates.filter((x): x is string => typeof x === "string") : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/** Check the public GitHub release for an application update. The small
 * Interface is intentionally just check/open: the installer remains the
 * proven NSIS overwrite path, rather than adding a fragile in-place updater.
 */
export async function checkAppUpdate(force = false): Promise<AppUpdateInfo> {
  if (!force && cachedApp && Date.now() - appLastCheckedAt < CHECK_TTL_MS) return cachedApp;
  const current = app.getVersion();
  try {
    const res = await fetch(APP_RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pipi-desktop" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub Releases HTTP ${res.status}`);
    const release = (await res.json()) as {
      tag_name?: string; html_url?: string; body?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const latest = parseVersion(release.tag_name);
    const setup = release.assets?.find((asset) => /-setup\.exe$/i.test(asset.name ?? ""));
    const info: AppUpdateInfo = {
      current,
      latest,
      hasUpdate: !!(latest && compareVersions(latest, current) > 0),
      downloadUrl: setup?.browser_download_url ?? release.html_url,
      releaseUrl: release.html_url,
      notes: release.body?.slice(0, 1200),
    };
    cachedApp = info;
    appLastCheckedAt = Date.now();
    console.log(`[app-update] pipi ${current} → ${latest ?? "?"}${info.hasUpdate ? " (update available)" : ""}`);
    return info;
  } catch (e) {
    const info: AppUpdateInfo = { current, latest: null, hasUpdate: false, error: e instanceof Error ? e.message : String(e) };
    cachedApp = info;
    appLastCheckedAt = Date.now();
    return info;
  }
}

export async function openAppUpdateDownload(url: string): Promise<boolean> {
  try {
    // Only accept GitHub's release/download links; renderer input cannot turn
    // this privileged IPC into an arbitrary external-navigation primitive.
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["github.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"].includes(parsed.hostname)) return false;
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

/** Check for a pi update (cached; async, never throws). */
export async function checkPiUpdate(force = false): Promise<UpdateInfo> {
  if (!force && cached && Date.now() - lastCheckedAt < CHECK_TTL_MS) return cached;
  const [bundledProbe, latest, extensions] = await Promise.all([
    probeLocalBundled(),
    getLatestVersion(),
    getExtensionUpdates(),
  ]);
  const current = bundledProbe.kind === "version" ? bundledProbe.version : null;
  const bundled = bundledPiVersion();
  const info: UpdateInfo = {
    current,
    latest,
    extensions,
    hasUpdate: !!(current && latest && compareVersions(latest, current) > 0) || extensions.length > 0,
    drift: classifyPiDrift({ bundled, runtime: "bundled", probe: bundledProbe }),
    // 终端里那个 pi（全局命令）的版本顺手记下：它是**已经跑过一次**的探测
    // （`localPi.probeOutcome()`，预热缓存命中时零 spawn），而在此之前它的版本
    // 被直接丢掉了——于是「终端跑着一个非契约 pi」这件事无名可叫。
    terminalDrift: classifyPiDrift({ bundled, runtime: "global", probe: probeOutcome() }),
  };
  if (!latest) info.error = "无法连接 npm registry";
  cached = info;
  lastCheckedAt = Date.now();
  console.log(`[update] pi ${current ?? "?"} → latest ${latest ?? "?"}${info.hasUpdate ? " (update available)" : ""}`);
  return info;
}

/** Drop the noise `bash -ic` prints WITHOUT a controlling tty (ioctl / job
 * control warnings) from a remote command's stderr. These two lines sit
 * ABOVE the real error (bash prints them at startup), so tail-selection
 * never reaches them and the update banner would otherwise open with two
 * lines of misleading "Inappropriate ioctl" before the actual npm error. */
export function stripShellNoise(stderr: string): string {
  const kept: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/cannot set terminal process group|no job control in this shell/i.test(line)) continue;
    kept.push(line);
  }
  const text = kept.join("\n");
  // Keep both ends when huge: npm's verdict lines (code/notarget) lead, the
  // log-tail trails — never truncate away one side entirely.
  return text.length > 1600 ? text.slice(0, 800) + "\n…\n" + text.slice(-800) : text;
}

/** Map a failed remote-align run to a short, actionable next step.
 *
 * Two failure families matter and they look deceptively alike:
 *  - ETARGET: npm DID answer — but stale. npm's HTTP layer falls back to the
 *    local cacache packument when the network fails (stale-if-error), so an
 *    unreachable registry masquerades as "version doesn't exist" when it
 *    really means "version didn't exist when this cache was written".
 *  - FETCH_ERROR / network timeout: npm genuinely could not reach the
 *    registry (no proxy, direct egress blocked — the usual China-server
 *    situation against registry.npmjs.org/Cloudflare).
 * Both resolve the same way: npmmirror is reachable from inside China and
 * syncs within hours, so the hint is a paste-ready mirror install command.
 */
export function friendlyRemoteInstallError(raw: string, version: string): string {
  if (/ETARGET|notarget|No matching version/i.test(raw)) {
    // If npmmirror itself answered the ETARGET, the mirror genuinely lags
    // (fresh bundle not yet synced) — the mirror command just failed, so
    // recommending it again would be wrong. Otherwise the stale-cache story
    // applies: the version exists; point at the mirror.
    if (/registry\.npmmirror\.com/i.test(raw)) {
      return `建议：npmmirror 镜像尚未同步 ${version}，请稍后重试；若急需，可先检查服务器到 registry.npmjs.org 的网络后再从官方源安装`;
    }
    return `建议：官方源网络不通时 npm 会回退到本地旧缓存，ETARGET 往往是过期缓存的假象（版本其实是存在的）。在服务器上执行：npm install -g @earendil-works/pi-coding-agent@${version} --registry=https://registry.npmmirror.com`;
  }
  if (/FETCH_ERROR|network timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|getaddrinfo/i.test(raw)) {
    return `建议：服务器到 npm 源的网络连接失败。执行：npm install -g @earendil-works/pi-coding-agent@${version} --registry=https://registry.npmmirror.com`;
  }
  return "";
}

/** Turn a failed remote `pi --version` stderr into a short actionable reason. */
export function friendlyRemoteProbeError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const useful = [...lines].reverse().find((l) => !/cannot set terminal process group|no job control in this shell/i.test(l));
  const tail = useful ?? lines[0] ?? "";
  if (/markAsUncloneable|webidl|TypeError/i.test(tail)) {
    return "远程 pi 无法启动：服务器运行时过旧（新版 pi 需要 Node ≥20.10，且所有稳定版 Bun 均不支持）";
  }
  if (/command not found|not found/i.test(tail)) {
    return "远程未检测到 pi（未安装或不在 PATH）";
  }
  if (/no such file/i.test(tail)) {
    return `远程目录不存在：${tail.slice(0, 120)}`;
  }
  return tail.slice(0, 160) || "远程 pi 版本检测失败";
}

/** 一次远程探测失败 → 给人看的诊断原文。与今天逐字相同：有 stderr 就用它
 * （`pi: command not found`、undici 的 markAsUncloneable 崩溃都在里面），
 * 裸退出码退到「远程 pi 不可用」，传输层的具体原因（`ssh not found` /
 * `spawn failed: …`）则直接用——那是唯一能解释“连都没连上”的线索。 */
export function remoteProbeFailureText(e: unknown): string {
  if (e instanceof PiCommandError) {
    if (e.kind === "timeout") return "远程 pi 版本检查超时";
    // 裸退出码（含 code 为 null 的信号死）不算诊断信息：旧实现同样退到
    // “远程 pi 不可用”而不是“exit 1”。
    const detail = e.detail && !/^exit\b/.test(e.detail) ? e.detail : "";
    return e.stderr.trim() || detail || "远程 pi 不可用";
  }
  return e instanceof Error ? e.message : String(e);
}

function buildRemoteInfo(target: Target | undefined, current: string | null, bundled: string | null, probe: PiProbeOutcome, probeStderr: string): RemoteUpdateInfo {
  const info: RemoteUpdateInfo = {
    target: target ? { kind: targetKind(target), label: targetLabel(target) } : { kind: "ssh", label: "未知目标" },
    current, latest: bundled,
    hasUpdate: !!(current && bundled && current !== bundled),
    extensions: [],
    // runtime 固定为 "remote"：这个函数只在「目标机上的 pi」这条路上被调用。
    // 下面两个退化分支（无标签 / 本机标签）在 UI 上不可达（4a 之后只对远程
    // 标签页调 checkTarget），它们的 `unverified` 总是分类为 unknown。
    drift: classifyPiDrift({ bundled, runtime: "remote", probe }),
  };
  if (!bundled) info.error = "无法确定应用配套的 pi 版本";
  else if (!current) info.error = friendlyRemoteProbeError(probeStderr);
  return info;
}

/** 远程探测失败 → 探测结论（状态说话，文案另算）。
 *
 * 顺序重要：传输层失败（连都没连上 / 认证不过）**不是**「目标上没有 pi」——
 * 那时候我们连目标上有什么都还没学到，所以只能算 `unverified`（→ unknown）。
 *
 * 导出只为测试（同 `remoteProbeFailureText` 的先例）。 */
export function remoteProbeOutcome(e: unknown): PiProbeOutcome {
  if (!(e instanceof PiCommandError)) return { kind: "unverified" };
  if (e.kind === "timeout") return { kind: "timeout" };
  const text = `${e.stderr}\n${e.detail ?? ""}`;
  if (/ssh not found|wsl not found|permission denied|authentication|host key|connection (closed|refused|reset)|could not resolve|no route to host|spawn failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed out/i.test(text)) {
    return { kind: "unverified" };
  }
  if (/command not found|not found/i.test(text)) return { kind: "absent" };
  return { kind: "unrunnable", detail: friendlyRemoteProbeError(e.stderr) };
}

/** 一个 Target 的 pi 端点（ADR 0007）：免密 ssh / 密码 ssh2 / WSL 都接在同一个
 * seam 上，凭据只决定绑定，不决定语义。本机目标不属于远程更新对话框，返回 null。
 *
 * `key` 复用既有格式（`buildRemoteKey(remote)` / `wsl:<distro>`）——update-check
 * 原本自己拼了第三种 key 格式，这里收回一种。 */
function portForTarget(target: Target): PiPort | null {
  if (target.kind === "wsl") {
    return {
      key: `wsl:${target.distro}`,
      // root 就是标签页的 cwd（`targetFromTab` 已把缺省 path 归一为 `~`），
      // 所以探测跑在 pi 真正跑的那个目录里。
      target: { cwd: target.root },
      run: (options) => runWslCommand({ distro: target.distro, wslBin: findWslBin(), ...options }),
    };
  }
  if (target.kind === "local") return null;
  const remote = target.remote;
  return {
    key: `ssh:${buildRemoteKey(remote)}`,
    target: { cwd: target.root, agentDir: remote.agentDir },
    run: remote.password
      ? (options) => runSsh2Command({ remote, ...options })
      : (options) => runSshCommand({ remote, sshBin: findSshBin(), ...options }),
  };
}

/** 渲染层只认这三个 kind（`sftp` 与 `ssh` 对用户是同一件事：一台远端服务器），
 * label 与 `updateTargetForTab` 时代逐字相同。 */
function targetLabel(target: Target): string {
  if (target.kind === "wsl") return `WSL ${target.distro}`;
  if (target.kind === "local") return "本机";
  return `${target.remote.user}@${target.remote.host}`;
}

function targetKind(target: Target): "ssh" | "wsl" | "local" {
  return target.kind === "wsl" ? "wsl" : target.kind === "local" ? "local" : "ssh";
}

/** Check pi --version inside one remote/WSL execution target and compare it
 * against the app's bundled version. */
export async function checkRemotePiUpdate(target: Target | undefined): Promise<RemoteUpdateInfo> {
  const bundled = bundledPiVersion();
  const port = target && portForTarget(target);
  if (!target) return buildRemoteInfo(target, null, bundled, { kind: "unverified" }, "目标标签不存在");
  if (!port) return buildRemoteInfo(target, null, bundled, { kind: "unverified" }, "本机标签不适用远程 pi 检查");
  let current: string | null = null;
  let probeStderr = "";
  let outcome: PiProbeOutcome = { kind: "unverified" };
  try {
    const result = await cachedProbe(port);
    current = result.version;
    outcome = { kind: "version", version: result.version };
  } catch (e) {
    probeStderr = remoteProbeFailureText(e);
    outcome = remoteProbeOutcome(e);
  }
  const info = buildRemoteInfo(target, current, bundled, outcome, probeStderr);
  console.log(`[update] ${targetLabel(target)} pi ${current ?? "?"} → bundled ${bundled ?? "?"}${info.hasUpdate ? " (version mismatch)" : ""}${info.error ? ` error=${info.error.slice(0, 80)}` : ""}`);
  return info;
}

/** Align the remote/WSL pi to the app's bundled version (not npm latest).
 * Detects the remote install method (bun vs npm) so the pin lands in the
 * same location `pi` currently resolves from; extensions are updated
 * best-effort afterwards. The renderer only supplies a tab id. */
export async function runRemotePiUpdate(target: Target | undefined): Promise<UpdateRunResult> {
  const bundled = bundledPiVersion();
  if (!bundled) return { ok: false, output: "", error: "无法确定应用配套的 pi 版本" };
  if (!target) return { ok: false, output: "", error: "目标标签不存在" };
  const port = portForTarget(target);
  if (!port) return { ok: false, output: "", error: "本机标签不适用远程 pi 更新" };
  try {
    const { output, version } = await align(port, bundled);
    // Post-install verification: the newest bundle needs undici's
    // markAsUncloneable, which old Node (<20.10) and every stable Bun lack —
    // the install can succeed while `pi` still crashes at startup. 是否算
    // 失败是策略，所以这一步在本模块之外判定。
    if (!version || version !== bundled) {
      return { ok: false, output, error: `已安装，但远程 pi 无法启动（未检测到 ${bundled}）。请升级服务器 Node（≥20.10，建议 22 LTS）并确保 pi 用 npm 安装，或改用 bun 但保留旧版 pi。` };
    }
    return { ok: true, output: (output + "\npi " + version).slice(-2000) };
  } catch (e) {
    if (e instanceof PiCommandError && e.phase === "verify") {
      const line = e.stderr.split(/\r?\n/).filter((l) => /markAsUncloneable|TypeError/i.test(l))[0] ?? "";
      return { ok: false, output: e.output, error: `已安装，但远程 pi 无法启动——服务器运行时过旧（新版 pi 的 undici 需要 Node ≥20.10 的 markAsUncloneable；所有稳定版 Bun 均不支持）。请升级服务器 Node 并用 npm 安装 pi 后重试。（${line}）` };
    }
    const raw = remoteProbeFailureText(e);
    const cleaned = stripShellNoise(raw);
    const hint = friendlyRemoteInstallError(raw, bundled);
    return { ok: false, output: "", error: `远程安装失败：${cleaned}${hint ? `\n${hint}` : ""}` };
  }
}

/** Run `pi update` (pi itself + extension packages). Rejects concurrent
 * runs: the update UI exists in both the chat page and the global banner,
 * each with its own busy state, so the main process must be the guard. */
export async function runPiUpdate(): Promise<UpdateRunResult> {
  if (updateInFlight) return { ok: false, output: "", error: "更新已在进行中" };
  updateInFlight = true;
  try {
    const { code, stdout, stderr } = await runPi(["update", "--all"], 300000);
    const output = (stdout + "\n" + stderr).trim();
    const ok = code === 0;
    // Invalidate the cached check so the next check reflects the new version.
    cached = null;
    return { ok, output: output.slice(-2000) };
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    updateInFlight = false;
  }
}
