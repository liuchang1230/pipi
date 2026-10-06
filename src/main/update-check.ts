/**
 * 更新检查：**只剩两件事** ——（1）app 自己的新版本（GitHub Releases，它是捆绑
 * pi 的唯一到手路径）；（2）目标机（SSH/WSL）上的 pi 是否等于应用配套的契约版本，
 * 不等就提议对齐（ADR 0008 的状态、ADR 0009 的范围）。
 *
 * ADR 0009 删掉了三条「追最新」的路：本机 pi 不再跟 npm registry 比、不再提示
 * 「pi agent 有新版本」、不再替用户升级自己配的扩展包（`pi update --all`），远程
 * 对齐命令也不再顺手 `pi update --extensions`。本机那个 pi 是用户自己的，追新是
 * 他能做的选择，app 不该拿它当待办事项催；我们要保证的只是「目标机跑的是我们钉住
 * 的那个协议版本」。
 */
import { app, shell } from "electron";
import { buildRemoteKey, findSshBin, findWslBin } from "./pty";
import { bundledPiVersion } from "./local-pi";
import { classifyPiDrift, type PiDrift, type PiProbeOutcome } from "../shared/pi-drift";
import { compareVersions } from "../shared/version-compare";
import type { Target } from "./target-fs";
import { runSshCommand } from "./ssh-exec";
import { runSsh2Command } from "./ssh2-exec";
import { runWslCommand } from "./wsl-exec";
import { align, cachedProbe, parseVersion, PiCommandError, type PiPort } from "./pi-version";

const APP_RELEASES_URL = "https://api.github.com/repos/liuchang1230/pipi/releases/latest";

export interface UpdateRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface RemoteUpdateInfo {
  /** Sanitized target identity; credentials never cross back to the renderer. */
  target: { kind: "ssh" | "wsl" | "local"; label: string };
  current: string | null;
  hasUpdate: boolean;
  /** 目标机上那个 pi 的漂移（ADR 0008）：与契约不一致、不在、跑不起来，
   *  是四种不同的事。`drift.bundled` 就是提议对齐的目标版本。 */
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

let cachedApp: AppUpdateInfo | null = null;
let appLastCheckedAt = 0;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // re-check at most every 6h

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
    current,
    hasUpdate: !!(current && bundled && current !== bundled),
    // 下面两个退化分支（无标签 / 本机标签）在 UI 上不可达（只对远程标签页调
    // checkTarget），它们的 `unverified` 总是分类为 unknown。
    drift: classifyPiDrift({ bundled, probe }),
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
 * same location `pi` currently resolves from. The renderer only supplies a
 * tab id. */
export async function runRemotePiUpdate(target: Target | undefined): Promise<UpdateRunResult> {
  const bundled = bundledPiVersion();
  if (!bundled) return { ok: false, output: "", error: "无法确定应用配套的 pi 版本" };
  if (!target) return { ok: false, output: "", error: "目标标签不存在" };
  const port = portForTarget(target);
  if (!port) return { ok: false, output: "", error: "本机标签不适用：对齐只对目标机有意义" };
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
