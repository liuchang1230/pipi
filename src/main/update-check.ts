/**
 * pi 及扩展更新检查（RPC 聊天模式没有 TUI 的 "Update Available" 横幅，
 * 由 app 层补齐）：启动时异步对比本地版本与 npm registry 最新版，
 * 有新版则提示；一键执行 `pi update`（pi 自身 + 扩展包一起更新）。
 */
import { app, shell } from "electron";
import { spawn } from "node:child_process";
import { Client as SshClient } from "ssh2";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { bundledPiPackagePath, findSshBin, findWslBin, getGlobalPiBin, type RemoteOpts, type WslOpts } from "./pty";

const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest";
const APP_RELEASES_URL = "https://api.github.com/repos/liuchang1230/pipi/releases/latest";

export interface UpdateInfo {
  current: string | null;
  latest: string | null;
  /** Configured npm/git pi packages with newer versions available. */
  extensions: string[];
  hasUpdate: boolean;
  error?: string;
}

export interface UpdateRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface RemoteUpdateTarget {
  kind: "ssh" | "wsl";
  label: string;
  remote?: RemoteOpts;
  wsl?: WslOpts;
}

export interface RemoteUpdateInfo {
  /** Sanitized target identity; credentials never cross back to the renderer. */
  target: Pick<RemoteUpdateTarget, "kind" | "label">;
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  /** pi update --all also updates configured extension packages. */
  extensions: string[];
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
const remoteCached = new Map<string, { checkedAt: number; info: RemoteUpdateInfo }>();
let updateInFlight = false;
let cachedApp: AppUpdateInfo | null = null;
let appLastCheckedAt = 0;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // re-check at most every 6h

function parseVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Semver-ish compare: "0.84.1" > "0.84.0". Returns 1/0/-1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (x !== 0) return Math.sign(x);
  }
  return 0;
}

function resolveNodeBin(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, "node.exe");
    if (existsSync(cand)) return cand;
  }
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveCliJs(): string | null {
  const piBin = getGlobalPiBin();
  if (/\.cmd$/i.test(piBin)) {
    try {
      const content = readFileSync(piBin, "utf8");
      const m = content.match(/"([^"]*cli\.js)"/i);
      if (m && existsSync(m[1]!)) return m[1];
    } catch {
      /* fall through */
    }
    const cand = join(dirname(piBin), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (existsSync(cand)) return cand;
  }
  return null;
}

function runPi(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const nodeBin = findNodeBinForSpawn();
    let child;
    if (nodeBin && resolveCliJs()) {
      child = spawn(nodeBin, [resolveCliJs()!, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      const piBin = getGlobalPiBin().replace(/\//g, "\\");
      child = spawn("cmd.exe", ["/d", "/c", `"${piBin}"`, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
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
      resolve({ code: null, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function findNodeBinForSpawn(): string | null {
  return resolveNodeBin();
}

async function getLocalPiVersion(): Promise<string | null> {
  try {
    const { stdout } = await runPi(["--version"], 20000);
    return parseVersion(stdout.split(/\r?\n/)[0]);
  } catch {
    return null;
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
  const piBin = getGlobalPiBin();
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
  const nodeBin = resolveNodeBin();
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
  const [current, latest, extensions] = await Promise.all([
    getLocalPiVersion(),
    getLatestVersion(),
    getExtensionUpdates(),
  ]);
  const info: UpdateInfo = {
    current,
    latest,
    extensions,
    hasUpdate: !!(current && latest && compareVersions(latest, current) > 0) || extensions.length > 0,
  };
  if (!latest) info.error = "无法连接 npm registry";
  cached = info;
  lastCheckedAt = Date.now();
  console.log(`[update] pi ${current ?? "?"} → latest ${latest ?? "?"}${info.hasUpdate ? " (update available)" : ""}`);
  return info;
}

/** The pi version bundled with the app — the RPC protocol contract. Remote
 * pi must match this version, NOT npm latest: a newer remote pi can diverge
 * from the app's RPC protocol, and newer pi may require a runtime the app's
 * own Electron (Node 20) cannot satisfy — e.g. 0.84.3+ imports fs.globSync
 * (Node ≥22.13) and 0.84.2+ bundles undici needing markAsUncloneable (Bun
 * lacks it), so the bundle is pinned to the last version that runs on the
 * app's Node 20 (0.84.2).
 *
 * IMPORTANT: read the pi package the app SHIPS (its own node_modules —
 * main-process fs reads through app.asar) — NEVER the user's GLOBAL pi.
 * Global pi is free to chase npm latest (local `pi update`), and the remote
 * align target must stay on the bundle: aligning a server to 0.85.x both
 * diverges from the app's RPC protocol and asks the server's npm registry
 * for a version a lagging mirror may not have synced (npm ETARGET). */
let bundledPiVersionCache: string | null = null;
function getBundledPiVersion(): string | null {
  if (bundledPiVersionCache !== null) return bundledPiVersionCache;
  try {
    const pkgPath = join(bundledPiPackagePath(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      const v = parseVersion(pkg.version);
      if (v) bundledPiVersionCache = v;
    }
  } catch {
    /* fall through */
  }
  if (bundledPiVersionCache === null) {
    // Last resort: the app's own package.json pins the dependency exactly
    // ("@earendil-works/pi-coding-agent": "0.84.2" — no caret). Same
    // contract number even if node_modules is not on disk.
    try {
      const appPkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
        dependencies?: Record<string, unknown>;
      };
      const spec = appPkg.dependencies?.["@earendil-works/pi-coding-agent"];
      bundledPiVersionCache = typeof spec === "string" ? parseVersion(spec) : null;
    } catch {
      /* best effort */
    }
  }
  return bundledPiVersionCache;
}

/** Take the last semver-looking line from `pi --version` output: interactive
 * shells print banners first, and pi's own version line comes last. */
export function pickVersionFromOutput(output: string): string | null {
  return [...output.split(/\r?\n/)].reverse().map(parseVersion).find((v): v is string => v !== null) ?? null;
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

/** Check pi --version inside one remote/WSL execution target and compare it
 * against the app's bundled version. */
export async function checkRemotePiUpdate(target: RemoteUpdateTarget): Promise<RemoteUpdateInfo> {
  const cacheKey = target.kind === "wsl"
    ? `wsl:${target.wsl?.distro ?? target.label}`
    : `ssh:${target.remote?.user ?? ""}@${target.remote?.host ?? target.label}:${target.remote?.port ?? 22}[${target.remote?.agentDir ?? ""}]`;
  const previous = remoteCached.get(cacheKey);
  if (previous && Date.now() - previous.checkedAt < CHECK_TTL_MS) return previous.info;
  let current: string | null = null;
  let probeStderr = "";
  try {
    const output = target.kind === "wsl"
      ? await runWslVersion(target.wsl!)
      : target.remote?.password
        ? await runSsh2Version(target.remote)
        : await runSshVersion(target.remote!);
    current = pickVersionFromOutput(output);
  } catch (e) {
    probeStderr = e instanceof Error ? e.message : String(e);
  }
  const bundled = getBundledPiVersion();
  const info: RemoteUpdateInfo = {
    target: { kind: target.kind, label: target.label }, current, latest: bundled,
    hasUpdate: !!(current && bundled && current !== bundled),
    extensions: [],
  };
  if (!bundled) info.error = "无法确定应用配套的 pi 版本";
  else if (!current) info.error = friendlyRemoteProbeError(probeStderr);
  remoteCached.set(cacheKey, { checkedAt: Date.now(), info });
  console.log(`[update] ${target.label} pi ${current ?? "?"} → bundled ${bundled ?? "?"}${info.hasUpdate ? " (version mismatch)" : ""}${info.error ? ` error=${info.error.slice(0, 80)}` : ""}`);
  return info;
}

function collectVersion(child: ReturnType<typeof spawn>, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* best effort */ } reject(new Error("远程 pi 版本检查超时")); }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { stdout += d; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { stderr += d; });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr || "远程 pi 不可用")); });
  });
}

function runSshVersion(remote: RemoteOpts): Promise<string> {
  return runSshCommand(remote, "pi --version", 20000);
}

function runWslVersion(wsl: WslOpts): Promise<string> {
  return runWslCommand(wsl, "pi --version", 20000);
}

function runSsh2Version(remote: RemoteOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const timer = setTimeout(() => { conn.end(); reject(new Error("远程 pi 版本检查超时")); }, 20000);
    conn.on("error", (e) => { clearTimeout(timer); conn.end(); reject(e); });
    conn.once("ready", () => conn.exec(`bash -ic '${targetPiCommand(remote, remote.path, "pi --version")}'`,  (err, stream) => {
      if (err) { clearTimeout(timer); conn.end(); reject(err); return; }
      let out = ""; let error = "";
      stream.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      stream.stderr.on("data", (d: Buffer) => { error += d.toString("utf8"); });
      stream.once("close", (code?: number) => { clearTimeout(timer); conn.end(); code === 0 ? resolve(out) : reject(new Error(error || "远程 pi 不可用")); });
    }));
    const password = remote.password ?? "";
    conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => password));
    });
    // Match the existing rpc-session ssh2 transport's host-key stance.
    conn.connect({ host: remote.host, port: remote.port ?? 22, username: remote.user, password, tryKeyboard: true, hostVerifier: () => true, readyTimeout: 15000 });
  });
}

/** Align the remote/WSL pi to the app's bundled version (not npm latest).
 * Detects the remote install method (bun vs npm) so the pin lands in the
 * same location `pi` currently resolves from; extensions are updated
 * best-effort afterwards. The renderer only supplies a tab id. */
export async function runRemotePiUpdate(target: RemoteUpdateTarget): Promise<UpdateRunResult> {
  const bundled = getBundledPiVersion();
  if (!bundled) return { ok: false, output: "", error: "无法确定应用配套的 pi 版本" };
  const command = buildRemoteAlignCommand(bundled);
  let output = "";
  try {
    output = target.kind === "wsl"
      ? await runWslCommand(target.wsl!, command)
      : target.remote?.password
        ? await runSsh2Command(target.remote, command)
        : await runSshCommand(target.remote!, command);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const cleaned = stripShellNoise(raw);
    // ETARGET = the server's npm registry (often a mirror) does not carry
    // this version yet. With the pinned bundle the version is old enough for
    // any synced mirror; if it still fires, the mirror itself is stale.
    const hint = /ETARGET|notarget|No matching version/i.test(raw)
      ? "（服务器 npm 源无此版本——若配了镜像源通常是同步滞后：可等镜像同步，或临时用 --registry=https://registry.npmjs.org 直连官方源重试）"
      : "";
    return { ok: false, output: "", error: `远程安装失败：${cleaned}${hint}` };
  }
  // Post-install verification: the newest bundle needs undici's
  // markAsUncloneable, which old Node (<20.10) and every stable Bun lack —
  // the install can succeed while `pi` still crashes at startup. Run
  // `pi --version` and report a clear runtime fix instead of a false success.
  try {
    const versionOut = target.kind === "wsl"
      ? await runWslVersion(target.wsl!)
      : target.remote?.password
        ? await runSsh2Version(target.remote)
        : await runSshVersion(target.remote!);
    const current = [...versionOut.split(/\r?\n/)].reverse().map(parseVersion).find((v): v is string => v !== null) ?? null;
    if (!current || current !== bundled) {
      return { ok: false, output, error: `已安装，但远程 pi 无法启动（未检测到 ${bundled}）。请升级服务器 Node（≥20.10，建议 22 LTS）并确保 pi 用 npm 安装，或改用 bun 但保留旧版 pi。` };
    }
    remoteCached.clear();
    return { ok: true, output: (output + "\npi " + current).slice(-2000) };
  } catch (e) {
    return { ok: false, output, error: `已安装，但远程 pi 无法启动——服务器运行时过旧（新版 pi 的 undici 需要 Node ≥20.10 的 markAsUncloneable；所有稳定版 Bun 均不支持）。请升级服务器 Node 并用 npm 安装 pi 后重试。${e instanceof Error ? `（${e.message.split(/\r?\n/).filter((l) => /markAsUncloneable|TypeError/i.test(l))[0] ?? ""}）` : ""}` };
  }
}

/** Build the remote align command. No single quotes (it nests inside
 * `bash -ic '…'`) and no shell metacharacters from inputs. */
export function buildRemoteAlignCommand(version: string): string {
  return `P=$(command -v pi || true); case "$P" in */.bun/*) PM="bun install -g";; *) PM="npm install -g";; esac; $PM @earendil-works/pi-coding-agent@${version} && (pi update --extensions 2>/dev/null || true)`;
}

export function targetPiCommand(remote: RemoteOpts | undefined, cwd: string | undefined, command: string): string {
  const agentDir = remote?.agentDir?.trim();
  // Match pty's AgentDir constraints even though tabs were already validated.
  const agentEnv = agentDir && /^(?:~|~\/[-A-Za-z0-9_./]+|\/[-A-Za-z0-9_./]+)$/.test(agentDir) && !agentDir.includes("..")
    ? `export PI_CODING_AGENT_DIR='${agentDir}' && `
    : "";
  if (!cwd) return `${agentEnv}${command}`;
  // Paths are transferred as base64: no shell quoting edge cases and the
  // check/update target matches the tab's actual project working directory.
  const encodedCwd = Buffer.from(cwd, "utf8").toString("base64");
  // base64 has no shell metacharacters, so it can stay unquoted inside the
  // nested `bash -ic '…'` layer (inner single quotes would terminate it).
  return `P="$(printf %s ${encodedCwd} | base64 -d)"; case "$P" in "~") P="$HOME";; "~/"*) P="$HOME/\${P#\\~/}";; esac; cd "$P" && ${agentEnv}${command}`;
}

function runSshCommand(remote: RemoteOpts, command: string, timeoutMs = 300000): Promise<string> {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
  if (remote.port && remote.port !== 22) args.push("-p", String(remote.port));
  args.push(`${remote.user}@${remote.host}`, `bash -ic '${targetPiCommand(remote, remote.path, command)}'`);
  return collectVersion(spawn(findSshBin(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }), timeoutMs);
}

function runWslCommand(wsl: WslOpts, command: string, timeoutMs = 300000): Promise<string> {
  return collectVersion(spawn(findWslBin(), ["-d", wsl.distro, "--", "bash", "-ic", targetPiCommand(undefined, wsl.path, command)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }), timeoutMs);
}

function runSsh2Command(remote: RemoteOpts, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const timer = setTimeout(() => { conn.end(); reject(new Error("远程 pi 更新超时")); }, 300000);
    conn.on("error", (e) => { clearTimeout(timer); conn.end(); reject(e); });
    conn.once("ready", () => conn.exec(`bash -ic '${targetPiCommand(remote, remote.path, command)}'`, (err, stream) => {
      if (err) { clearTimeout(timer); conn.end(); reject(err); return; }
      let out = ""; let error = "";
      stream.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      stream.stderr.on("data", (d: Buffer) => { error += d.toString("utf8"); });
      stream.once("close", (code?: number) => { clearTimeout(timer); conn.end(); code === 0 ? resolve(out + (error ? `\n${error}` : "")) : reject(new Error(error || "远程 pi 更新失败")); });
    }));
    const password = remote.password ?? "";
    conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password)));
    conn.connect({ host: remote.host, port: remote.port ?? 22, username: remote.user, password, tryKeyboard: true, hostVerifier: () => true, readyTimeout: 20000 });
  });
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
