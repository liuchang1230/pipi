/**
 * PTY + tab management for the embedded pi terminal.
 *
 * Each tab owns a `node-pty` process running `pi` (the pi-coding-agent CLI)
 * in a fixed cwd, plus an optional explicit session file. The renderer talks
 * to a tab by id over IPC; data is streamed both ways.
 *
 * pi auto-saves to ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl, so
 * killing a pty on tab close never loses conversation history — the session
 * can always be resumed later.
 */
import { app, BrowserWindow } from "electron";
import * as pty from "node-pty";
import { existsSync, readFileSync, readdirSync, statSync, watch, openSync, closeSync, readSync, type FSWatcher } from "node:fs";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { sessionDirFor } from "./session-list";
import { themeEnv } from "./theme-sync";
import { TERMINAL_THEMES, type ThemeMode } from "../shared/terminal-theme";

/**
 * App-owned theme mode. The renderer reports it via `theme:set-mode`;
 * every subsequent pty spawn (local or remote) is told to render with
 * this mode, overriding whatever the host terminal/server would detect.
 */
let currentThemeMode: ThemeMode = "dark";

export function setThemeMode(mode: ThemeMode): void {
  if (mode === "dark" || mode === "light") currentThemeMode = mode;
}

function sessionDisplayName(sessionPath?: string): string | null {
  if (!sessionPath) return null;
  try {
    const lines = readFileSync(sessionPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if ((entry.type === "session" || entry.type === "session_info") && typeof entry.name === "string" && entry.name.trim()) {
        return entry.name.trim();
      }
      if (entry.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        if (typeof content === "string" && content.trim()) return content.trim().slice(0, 40);
        if (Array.isArray(content)) {
          const text = content.find((b: { type?: string; text?: string }) => b.type === "text")?.text;
          if (text?.trim()) return text.trim().slice(0, 40);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
// --- Session-title watching -------------------------------------------------
// Keep a tab's title in sync with its session file so the middle tab bar
// shows the same label as the left session list (first user message, or the
// session name after a rename / pi `/name`). For blank tabs (new session via
// "+"), pi lazily creates the session JSONL at boot; we watch the session
// dir to discover and link that file, then watch the file for name updates.
// Remote tabs are handled in index.ts via SFTP list sync.

const titleWatchers = new Map<string, FSWatcher>();
const titleTimers = new Map<string, NodeJS.Timeout>();
let tabsChangedListener: (() => void) | null = null;

/** Main process registers this so pty.ts can push `tabs:update` events. */
export function onTabsChanged(listener: () => void): void {
  tabsChangedListener = listener;
}

function emitTabsChanged(): void {
  tabsChangedListener?.();
}

interface TitleEntry {
  type?: string;
  name?: string;
  message?: { role?: string; content?: unknown };
}

/** Parse the sidebar-style label (name → first user message) from JSONL text. */
function parseSessionTitle(text: string): string | null {
  let name: string | null = null;
  let firstUser: string | null = null;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    let e: TitleEntry;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if ((e.type === "session" || e.type === "session_info") && typeof e.name === "string" && e.name.trim()) {
      name = e.name.trim();
    } else if (e.type === "message" && e.message?.role === "user" && !firstUser) {
      const c = e.message.content;
      if (typeof c === "string" && c.trim()) {
        firstUser = c.trim().slice(0, 40);
      } else if (Array.isArray(c)) {
        const t = c.find((b: { type?: string; text?: string }) => b.type === "text")?.text;
        if (typeof t === "string" && t.trim()) firstUser = t.trim().slice(0, 40);
      }
    }
  }
  return name ?? firstUser;
}

/** Read the current session label from a session file (bounded read). */
function sessionTitleFromFile(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  try {
    const st = statSync(filePath);
    if (st.size === 0) return null;
    // The header (rename writes `name` there) and the first user message live
    // at the start; pi `/name` session_info entries append at the end.
    // Read ONLY those ranges — a full readFileSync of a multi-MB tool-output
    // session would block the main process on the tab-creation click path.
    const cap = 64 * 1024;
    const headBytes = Math.min(st.size, cap);
    const tailBytes = st.size > headBytes ? Math.min(st.size, cap) : 0;
    const fd = openSync(filePath, "r");
    try {
      const head = Buffer.alloc(headBytes);
      const headLen = readSync(fd, head, 0, headBytes, 0);
      let tail = "";
      if (tailBytes > 0) {
        const tailBuf = Buffer.alloc(tailBytes);
        const tailLen = readSync(fd, tailBuf, 0, tailBytes, st.size - tailBytes);
        tail = tailBuf.subarray(0, tailLen).toString("utf8");
      }
      return parseSessionTitle(head.subarray(0, headLen).toString("utf8") + "\n" + tail);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // file may be transiently locked while pi appends
  }
}

/** Re-read a linked session file and bump the tab title when it changed. */
function updateTabTitleFromSession(id: string): void {
  const t = tabs.get(id);
  if (!t || !t.sessionPath) return;
  const label = sessionTitleFromFile(t.sessionPath);
  if (!label || label === t.title) return;
  t.title = label;
  emitTabsChanged();
}

/**
 * Link the session file pi created for a blank tab. The newest unlinked
 * .jsonl in the session dir belongs to the oldest still-blank tab, so with
 * several tabs the assignment stays deterministic.
 */
function maybeLinkBlankTab(id: string): void {
  const t = tabs.get(id);
  if (!t || t.sessionPath) return;
  let files: string[];
  let dir: string;
  try {
    dir = sessionDirFor(t.cwd);
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }
  const linked = new Set([...tabs.values()].map((x) => x.sessionPath).filter((p): p is string => !!p));
  const candidates = files
    .map((f) => join(dir, f))
    .filter((p) => !linked.has(p))
    .filter((p) => {
      // Only files pi touched after this tab opened can be its session;
      // stale unlinked files (leftover sessions) must not get hijacked.
      try {
        return statSync(p).mtimeMs >= t.createdAt - 500;
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
  const blanks = [...tabs.values()]
    .filter((x) => !x.sessionPath && !x.remote && !x.wsl)
    .sort((a, b) => a.createdAt - b.createdAt);
  const mine = candidates[blanks.findIndex((x) => x.id === id)];
  if (!mine) return;
  t.sessionPath = mine;
  const label = sessionTitleFromFile(mine);
  if (label) t.title = label;
  setSessionWatcher(t); // switch dir-watch → file-watch so renames still update
  emitTabsChanged();
}

/** Start (or restart) the title watcher for a tab. Remote tabs: no-op. */
function setSessionWatcher(tab: TabInfo): void {
  stopSessionWatcher(tab.id);
  if (tab.remote || tab.wsl) return;
  if (!tab.sessionPath) {
    const dir = sessionDirFor(tab.cwd);
    try {
      const watcher = watch(dir, { persistent: false }, () => maybeLinkBlankTab(tab.id));
      titleWatchers.set(tab.id, watcher);
      maybeLinkBlankTab(tab.id); // files pi created before the watch armed
    } catch {
      // Session dir not created yet (pi creates it lazily) — watch the parent
      // and re-arm once the dir shows up.
      try {
        const parent = dirname(dir);
        const watcher = watch(parent, { persistent: false }, () => {
          // Tab may have been closed while we waited for the dir to appear.
          if (!tabs.has(tab.id)) return;
          if (existsSync(dir)) setSessionWatcher(tab);
        });
        titleWatchers.set(tab.id, watcher);
      } catch {
        /* nothing more we can do */
      }
    }
    return;
  }
  try {
    const watcher = watch(tab.sessionPath, { persistent: false }, () => {
      if (titleTimers.has(tab.id)) clearTimeout(titleTimers.get(tab.id)!);
      titleTimers.set(
        tab.id,
        setTimeout(() => {
          titleTimers.delete(tab.id);
          updateTabTitleFromSession(tab.id);
        }, 300),
      );
    });
    titleWatchers.set(tab.id, watcher);
    updateTabTitleFromSession(tab.id); // names written before the watch armed
  } catch {
    /* file may be locked or already gone — initial title stands */
  }
}

function stopSessionWatcher(id: string): void {
  const w = titleWatchers.get(id);
  if (w) {
    try {
      w.close();
    } catch {
      /* */
    }
    titleWatchers.delete(id);
  }
  const timer = titleTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    titleTimers.delete(id);
  }
}

/** Override a tab's title (used by remote session sync) and notify. */
export function setTabTitle(id: string, title: string): boolean {
  const t = tabs.get(id);
  if (!t || !title || t.title === title) return false;
  t.title = title;
  emitTabsChanged();
  return true;
}

/** Link a blank tab to the session file pi created for it. */
export function linkTabSession(id: string, sessionPath: string, title?: string | null): boolean {
  const t = tabs.get(id);
  if (!t || t.sessionPath) return false;
  t.sessionPath = sessionPath;
  if (title) t.title = title;
  setSessionWatcher(t);
  emitTabsChanged();
  return true;
}

/** Resolve the `pi` entry point.
 *
 * Prefer a globally installed `pi.cmd` so the app does not depend on a
 * project-local `@earendil-works/pi-coding-agent` package. conpty can be
 * finicky with batch shims, so we resolve the absolute executable path.
 */
function resolvePiBin(): { file: string; args: string[] } {
  const globalPi = findPiBin();
  if (/\.cmd$/i.test(globalPi)) {
    const escaped = globalPi.replace(/\//g, "\\");
    return { file: "cmd.exe", args: ["/d", "/c", escaped] };
  }
  return { file: globalPi, args: [] };
}

export function getGlobalPiBin(): string {
  return findPiBin();
}

export function hasNodeInstalled(): boolean {
  if (cachedNodeOk !== null) return cachedNodeOk;
  const nodeBin = findExe("node.exe", [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node.exe"),
  ]);
  const result = spawnSync(nodeBin, ["--version"], { stdio: "pipe", windowsHide: true });
  cachedNodeOk = !result.error && result.status === 0;
  return cachedNodeOk;
}

export function hasGlobalPiInstalled(): boolean {
  if (cachedPiOk !== null) return cachedPiOk;
  cachedPiOk = getPiDetectionDiagnostics().ok;
  return cachedPiOk;
}

export function getPiDetectionDiagnostics(): {
  ok: boolean;
  piBin: string;
  piEnv: string | undefined;
  status: number | null;
  error?: string;
  stdout: string;
  stderr: string;
} {
  const piBin = findPiBin();
  const result = runPiVersion(piBin);
  return {
    ok: !result.error && result.status === 0,
    piBin,
    piEnv: process.env.PI_CODING_AGENT,
    status: result.status,
    error: result.error?.message,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function installGlobalPi(): { ok: true } | { ok: false; error: string } {
  const npmBin = findExe("npm.cmd", [
    join(process.env.APPDATA ?? "", "npm\\npm.cmd"),
    "C:\\Program Files\\nodejs\\npm.cmd",
    "C:\\Program Files (x86)\\nodejs\\npm.cmd",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\npm.cmd"),
  ]);
  const result = spawnSync(
    npmBin,
    ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"],
    { encoding: "utf8", stdio: "pipe", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error?.message || result.stderr || result.stdout || `exit code ${result.status}` };
  }
  return { ok: true };
}

/** Find an absolute global `pi` executable for conpty (cached). */
// --- pi/node detection cache ------------------------------------------------
// Detection spawns child processes that BLOCK the main process: where.exe,
// node --version, and especially `pi --version` (~1.1s on Windows — it boots
// the whole pi CLI). These are environment facts that don't change during the
// app's lifetime; the session-click path (tab:create → ensurePiReady →
// resolvePiBin) used to pay 3-4 sync spawns before the pty even spawned.
// Cache the results and warm them at startup (see warmPiDetection).
let cachedPiBin: string | undefined;
let cachedNodeOk: boolean | null = null;
let cachedPiOk: boolean | null = null;

/** Reset the detection caches (after auto-installing pi, so the freshly
 *  installed binary is picked up instead of the stale failure). */
export function invalidatePiDetection(): void {
  cachedPiBin = undefined;
  cachedNodeOk = null;
  cachedPiOk = null;
}

/** Compute the detection caches in the background (best-effort, no dialogs).
 *  The cheap spawns (where.exe, node --version, ~100ms total) run sync;
 *  `pi --version` boots the whole pi CLI (~1.1s) so it is probed with an
 *  async spawn — the main process never blocks, and by the time the user
 *  clicks a session the cache is warm (zero spawns on the click path). */
export function warmPiDetection(): void {
  try {
    findPiBin();
    hasNodeInstalled();
  } catch {
    /* detection is best-effort; ensurePiReady surfaces real problems */
  }
  const piBin = cachedPiBin;
  if (!piBin) return;
  const child = spawnVersionProbe(piBin);
  child.once("exit", (code) => {
    cachedPiOk = code === 0;
  });
  child.once("error", () => {
    cachedPiOk = false;
  });
}

/** Async version probe (the sync `pi --version` blocks ~1.1s on Windows). */
function spawnVersionProbe(piBin: string): ChildProcess {
  if (/\.cmd$/i.test(piBin)) {
    const escaped = piBin.replace(/\//g, "\\");
    return spawn("cmd.exe", ["/d", "/c", escaped, "--version"], { stdio: "ignore", windowsHide: true });
  }
  return spawn(piBin, ["--version"], { stdio: "ignore", windowsHide: true });
}

function findPiBin(): string {
  if (cachedPiBin !== undefined) return cachedPiBin;
  const fromWhere = findViaWhere("pi");
  if (fromWhere) {
    cachedPiBin = fromWhere;
    return fromWhere;
  }

  cachedPiBin = findExe("pi.cmd", [
    join(process.env.APPDATA ?? "", "npm\\pi.cmd"),
    join(process.env.USERPROFILE ?? "", "AppData\\Roaming\\npm\\pi.cmd"),
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\pi.cmd"),
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node-v22.19.0-win-x64\\pi.cmd"),
  ]);
  return cachedPiBin;
}

/** Find an absolute `ssh` binary for conpty. */
export function findSshBin(): string {
  // Windows OpenSSH is more reliable with conpty than Git's bundled ssh.
  const winSsh = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
  if (existsSync(winSsh)) return winSsh;
  return findExe("ssh.exe", []);
}

/** Find the Windows `wsl.exe` binary. */
export function findWslBin(): string {
  const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
  if (existsSync(sys32)) return sys32;
  return findExe("wsl.exe", []);
}

/** List installed WSL distributions. */
export function listWslDistros(): WslDistro[] {
  const wslBin = findWslBin();
  const result = spawnSync(wslBin, ["-l", "-v"], {
    encoding: "buffer",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return [];
  // wsl.exe outputs UTF-16LE when stdout is not a console; detect and decode.
  let stdout = "";
  if (result.stdout && result.stdout.length > 0) {
    // Check for UTF-16LE BOM or interleaved null bytes
    if (result.stdout[0] === 0xff && result.stdout[1] === 0xfe) {
      stdout = result.stdout.toString("utf16le");
    } else if (result.stdout.length > 2 && result.stdout[1] === 0x00) {
      stdout = result.stdout.toString("utf16le");
    } else {
      stdout = result.stdout.toString("utf8");
    }
  }
  const lines = stdout.split(/\r?\n/);
  const distros: WslDistro[] = [];
  for (const line of lines) {
    // Format: "* Ubuntu-22.04    Running    2" or "  docker-desktop    Stopped    2"
    const m = line.match(/^(\*?)\s+(\S+)\s+(Running|Stopped)\s+(\d+)/i);
    if (!m) continue;
    distros.push({
      name: m[2],
      default: m[1] === "*",
      running: m[3].toLowerCase() === "running",
      version: parseInt(m[4]) || 2,
    });
  }
  return distros;
}

/** Generic: find an executable's absolute path. */
function findExe(name: string, commonFallbacks: string[]): string {
  // 1. process.execPath if it matches.
  if (process.execPath && process.execPath.toLowerCase().endsWith(name.toLowerCase())) {
    return process.execPath;
  }
  // 2. Search PATH.
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    const cand = join(dir, name);
    if (existsSync(cand)) return cand;
  }
  // 3. Common install locations.
  for (const c of commonFallbacks) {
    if (c && existsSync(c)) return c;
  }
  // 4. Fallback to bare name.
  return name.replace(/\.(exe|cmd)$/i, "");
}

function findViaWhere(command: string): string | null {
  const result = spawnSync("where.exe", [command], { encoding: "utf8", stdio: "pipe", windowsHide: true });
  if (result.error || result.status !== 0) return null;

  const candidates = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferred = candidates.find((line) => /\.(cmd|exe)$/i.test(line));
  return preferred || candidates[0] || null;
}

function runPiVersion(piBin: string) {
  if (/\.cmd$/i.test(piBin)) {
    const escaped = piBin.replace(/\//g, "\\");
    return spawnSync("cmd.exe", ["/d", "/c", escaped, "--version"], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    });
  }

  return spawnSync(piBin, ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
}

export interface WslDistro {
  name: string;
  default: boolean;
  running: boolean;
  version: number;
}

export interface WslOpts {
  distro: string;
  path?: string; // Linux path, default ~
}

export interface TabInfo {
  id: string;
  cwd: string;
  sessionPath?: string;
  title: string;
  pty: pty.IPty;
  cols: number;
  rows: number;
  remote?: RemoteOpts;
  remoteBrowsePath?: string;
  remoteKey?: string;
  wsl?: WslOpts;
  createdAt: number;
}

let nextId = 1;
const tabs = new Map<string, TabInfo>();
let activeId: string | null = null;

export interface CreateTabOptions {
  cwd: string;
  sessionPath?: string; // resume a specific session file
  continueRecent?: boolean; // when true, pi -c (continue most recent)
  remote?: RemoteOpts; // SSH into a remote server instead of local pi
  wsl?: WslOpts; // WSL distro direct connection (no SSH)
  title?: string;
  themeMode?: ThemeMode; // per-tab override; default = app theme mode
}

export interface RemoteOpts {
  host: string;
  user: string;
  port?: number; // default 22
  path?: string; // remote working dir (default: home)
  password?: string;
  startPi?: boolean;
}

export function buildRemoteKey(remote: Pick<RemoteOpts, "host" | "user" | "port">): string {
  return `${remote.user}@${remote.host}:${remote.port ?? 22}`;
}

/** findExe, but returns null instead of the bare-name fallback when missing. */
function findExeOrNull(name: string, fallbacks: string[]): string | null {
  const found = findExe(name, fallbacks);
  const bare = name.replace(/\.(exe|cmd)$/i, "");
  return found === bare ? null : found;
}

/** Pick a local interactive shell: pwsh → powershell → cmd. */
function resolveShellBin(): { file: string; args: string[] } {
  const pwsh = findExeOrNull("pwsh.exe", [join(process.env.LOCALAPPDATA ?? "", "Microsoft\\WindowsApps\\pwsh.exe")]);
  if (pwsh) return { file: pwsh, args: ["-NoLogo"] };
  const ps = findExeOrNull("powershell.exe", [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]);
  if (ps) return { file: ps, args: ["-NoLogo"] };
  return { file: "cmd.exe", args: ["/d", "/k"] };
}

/**
 * Replace the (exited) pi process in a tab with an interactive local shell,
 * keeping the tab alive so the user can keep typing (e.g. after `/quit`).
 */
// --- Terminal output streaming --------------------------------------------
// pty output is coalesced per tab: chunks are buffered and flushed at most
// every 5ms (or when a batch exceeds 64KB), so heavy output — pi startup, long
// tool output — never floods the renderer with one IPC message per chunk.
const STREAM_FLUSH_MS = 5;
const STREAM_MAX_BATCH = 64 * 1024;

class TabStream {
  private buffer = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly tabId: string) {}

  push(data: string): void {
    this.buffer += data;
    if (this.buffer.length >= STREAM_MAX_BATCH) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), STREAM_FLUSH_MS);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const chunk = this.buffer;
    this.buffer = "";
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:data:${this.tabId}`, chunk);
    }
  }
}

const tabStreams = new Map<string, TabStream>();

function streamTabData(id: string, data: string): void {
  // A pty can emit a trailing chunk between closeTab and process death; the
  // tab is gone, so drop it instead of recreating a zombie stream.
  if (!tabs.has(id)) return;
  let s = tabStreams.get(id);
  if (!s) {
    s = new TabStream(id);
    tabStreams.set(id, s);
  }
  s.push(data);
}

function flushTabStream(id: string): void {
  const s = tabStreams.get(id);
  if (s) {
    s.flush();
    tabStreams.delete(id);
  }
}

function respawnShellInTab(id: string): void {
  const t = tabs.get(id);
  if (!t) return;
  const { file, args } = resolveShellBin();
  let term: pty.IPty;
  try {
    console.log(`[pty] tab ${id}: pi exited, respawning shell: ${file} ${args.join(" ")}`);
    term = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: t.cols,
      rows: t.rows,
      cwd: t.cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      useConpty: true,
    });
  } catch (e) {
    console.error(`[pty] shell respawn FAILED:`, e instanceof Error ? e.message : String(e));
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, -1);
    }
    return;
  }
  t.pty = term;
  // The pi session is no longer live in this tab; detach it so re-opening the
  // session from the sidebar spawns a fresh pi instead of reusing this shell,
  // and stop watching the old (dead) session file.
  if (t.sessionPath) {
    stopSessionWatcher(id);
    t.sessionPath = undefined;
    emitTabsChanged();
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(`tab:data:${id}`, "\r\n\x1b[2m[pi 已退出，进入终端 — 输入 exit 关闭此页签]\x1b[0m\r\n");
  }
  term.onData((data) => {
    streamTabData(id, data);
  });
  term.onExit(({ exitCode }) => {
    flushTabStream(id);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, exitCode);
    }
  });
}

/** Create a new tab and spawn pi inside it. Returns the tab id. */
export function createTab(opts: CreateTabOptions): string {
  const id = `tab-${nextId++}`;

  if (opts.wsl) {
    return createWslTab(id, opts);
  }

  if (opts.remote) {
    return createRemoteTab(id, opts);
  }

  const { file, args: binArgs } = resolvePiBin();
  const piArgs = [...binArgs];
  if (opts.sessionPath) {
    piArgs.push("--session", opts.sessionPath);
  } else if (opts.continueRecent === true) {
    piArgs.push("-c"); // continue most recent session for this cwd
  }
  // Title = project basename for blank sessions; resumed sessions use the
  // session file basename so different history tabs are distinguishable.
  const base = opts.cwd.replace(/\\/g, "/").split("/").pop() || opts.cwd;
  // Range-read title (head+tail only) — never a full readFileSync of a
  // multi-MB tool-output session on the click path.
  const sessionBase = sessionTitleFromFile(opts.sessionPath ?? "")
    ?? opts.sessionPath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/i, "");
  const title = opts.title || (opts.sessionPath ? (sessionBase || `${base} ↻`) : base);

  let term: pty.IPty;
  try {
    const mode = opts.themeMode ?? currentThemeMode;
    term = pty.spawn(file, piArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...themeEnv(mode),
      },
      useConpty: true,
    });
    console.log(`[pty] spawned tab ${id}: ${file} ${piArgs.join(" ")}`);
  } catch (e) {
    console.error(`[pty] spawn FAILED:`, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    throw e;
  }

  const tab: TabInfo = { id, cwd: opts.cwd, sessionPath: opts.sessionPath, title, pty: term, cols: 80, rows: 24, createdAt: Date.now() };
  tabs.set(id, tab);
  activeId = id;
  setSessionWatcher(tab);

  // Stream pty output to the renderer on a per-tab channel (coalesced).
  term.onData((data) => {
    streamTabData(id, data);
  });
  term.onExit(({ exitCode }) => {
    flushTabStream(id);
    const t = tabs.get(id);
    // pi exited cleanly (e.g. `/quit`) — drop into an interactive local shell
    // in the SAME tab so the terminal stays usable instead of going blank.
    // Closing the tab deletes it first, so a close-kill never respawns.
    if (t && !t.remote && !t.wsl && exitCode === 0) {
      respawnShellInTab(id);
      return;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, exitCode);
    }
  });

  return id;
}

export function getTab(id: string): TabInfo | undefined {
  return tabs.get(id);
}

export function listTabs(): TabInfo[] {
  return [...tabs.values()].map((t) => ({
    id: t.id,
    cwd: t.cwd,
    sessionPath: t.sessionPath,
    title: t.title,
    pty: t.pty,
    cols: t.cols,
    rows: t.rows,
    remote: t.remote,
    remoteBrowsePath: t.remoteBrowsePath,
    remoteKey: t.remoteKey,
    wsl: t.wsl,
    createdAt: t.createdAt,
  }));
}

export function getActiveTab(): TabInfo | null {
  return activeId ? tabs.get(activeId) ?? null : null;
}

export function setActiveTab(id: string): boolean {
  if (!tabs.has(id)) return false;
  activeId = id;
  return true;
}

/** Resize a tab's pty. */
export function resizeTab(id: string, cols: number, rows: number): boolean {
  const t = tabs.get(id);
  if (!t || cols < 1 || rows < 1) return false;
  try {
    t.pty.resize(cols, rows);
    t.cols = cols;
    t.rows = rows;
    return true;
  } catch {
    return false;
  }
}

/** Send user input to a tab's pty. */
export function writeTab(id: string, data: string): boolean {
  const t = tabs.get(id);
  if (!t) return false;
  t.pty.write(data);
  return true;
}

/** Kill and remove a tab. Returns false if not found. */
export function closeTab(id: string): boolean {
  const t = tabs.get(id);
  if (!t) return false;
  flushTabStream(id);
  stopSessionWatcher(id);
  try {
    t.pty.kill();
  } catch {
    /* process may already be dead */
  }
  tabs.delete(id);
  if (activeId === id) {
    activeId = tabs.size > 0 ? [...tabs.keys()][tabs.size - 1] : null;
  }
  return true;
}

/** Kill all tabs (on app quit). */
export function closeAllTabs(): void {
  for (const id of [...tabs.keys()]) closeTab(id);
}

/** Subscribe to a tab's data and exit events. Returns an unsubscribe fn. */
export function subscribeTab(
  id: string,
  onData: (data: string) => void,
  onExit: (code: number, signal?: number) => void
): () => void {
  const t = tabs.get(id);
  if (!t) return () => {};
  const d = t.pty.onData(onData);
  const e = t.pty.onExit(({ exitCode, signal }) => onExit(exitCode, signal));
  return () => {
    d.dispose();
    e.dispose();
  };
}

export function getRemoteBrowsePath(id: string): string | null {
  const t = tabs.get(id);
  return t?.remote ? (t.remoteBrowsePath ?? t.remote.path ?? "~") : null;
}

export function setRemoteBrowsePath(id: string, path: string): boolean {
  const t = tabs.get(id);
  if (!t?.remote) return false;
  t.remoteBrowsePath = path;
  return true;
}

/** POSIX single-quote escape for ONE shell layer: `'` → `'\''`. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a `cd` argument for the REMOTE login shell. Single quotes prevent
 * `$`/backtick/`;` expansion (JSON.stringify's double quotes did not).
 * `~`-prefixed paths keep the leading `~` unquoted so tilde expansion runs.
 */
function cdArg(p: string): string {
  if (p === "~") return "~";
  if (p.startsWith("~/")) return `~/${sq(p.slice(2))}`;
  return sq(p);
}

/**
 * A session path crosses TWO shell layers: the remote login shell's
 * `bash -ic '...'` string, then the inner bash that parses `pi --session ...`.
 * base64 contains no quotes/metacharacters, so it survives both layers
 * verbatim; the inner shell decodes it into a double-quoted variable.
 */
function sessionArg(sessionPath: string): string {
  const b64 = Buffer.from(sessionPath, "utf8").toString("base64");
  // `base64 -d` (GNU/busybox) or `-D` (macOS). Empty result → no --session.
  // This whole string lives INSIDE the `bash -ic '...'` level, so it is
  // re-parsed by the inner bash: `\${...:+...}` arrives as literal `${...}`.
  // `; exec bash -i` (NOT `||`): pi exits 0 on a clean /quit, so `||` would
  // skip the shell and leave the terminal dead. `;` always falls through to
  // an interactive bash, so quitting pi drops the user into a real terminal.
  return (
    ` export PIPI_S="$(printf %s '${b64}' | base64 -d 2>/dev/null || printf %s '${b64}' | base64 -D 2>/dev/null)";` +
    ` pi \${PIPI_S:+--session "$PIPI_S"}; exec bash -i`
  );
}

/** Convert a \\\\wsl$\\<distro>\\... session path back to the Linux path pi
 *  expects inside the distro (e.g. /home/lc/.pi/agent/sessions/…). Returns the
 *  input unchanged if it's not a UNC path for this distro. */
function wslSessionToLinux(distro: string, sessionPath: string): string {
  // UNC paths are `\\wsl$\<distro>\...` (single backslashes); the prefix
  // template needs TWO leading backslashes (UNC) + single separators, else
  // pi receives the raw Windows path inside the distro.
  const prefix = `\\\\wsl$\\${distro}\\`;
  if (sessionPath.startsWith(prefix)) {
    return "/" + sessionPath.slice(prefix.length).replace(/\\/g, "/");
  }
  return sessionPath;
}

/** Create a tab that enters a WSL distro directly and runs pi inside it. */
function createWslTab(id: string, opts: CreateTabOptions): string {
  const w = opts.wsl!;
  const wslPath = w.path || "~";
  const mode = opts.themeMode ?? currentThemeMode;
  const modeEnv =
    `export TERM=xterm-256color COLORTERM=truecolor COLORFGBG="${TERMINAL_THEMES[mode].colorfgbg}";`;

  // pi runs INSIDE the distro, so a session path must be a Linux path, not a
  // \\wsl$\\ UNC path (the sidebar hands us UNC paths for WSL sessions).
  const linuxSessionPath = opts.sessionPath
    ? wslSessionToLinux(w.distro, opts.sessionPath)
    : undefined;

  // Build the inner command: change to the target dir, then start pi
  // (or resume a session). Falls back to interactive bash if pi is not
  // installed in the distro.
  const inner = linuxSessionPath
    ? sessionArg(linuxSessionPath)
    : `pi; exec bash -i`;

  const wslBin = findWslBin();
  const wslArgs = [
    "-d", w.distro,
    "--", "bash", "-ic",
    `cd ${cdArg(wslPath)} && ${modeEnv} ${inner}`,
  ];

  const sessionBase = sessionTitleFromFile(opts.sessionPath ?? "")
    ?? opts.sessionPath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/i, "");
  const title = opts.title || sessionBase || w.distro;

  let term: pty.IPty;
  try {
    console.log(`[pty] wsl tab ${id}: ${wslBin} ${wslArgs.join(" ")}`);
    term = pty.spawn(wslBin, wslArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      useConpty: true,
    });
    console.log(`[pty] wsl tab ${id}: wsl -d ${w.distro} -> ${wslPath}`);
  } catch (e) {
    console.error(`[pty] wsl spawn FAILED:`, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    throw e;
  }

  const tab: TabInfo = {
    id,
    cwd: opts.cwd,
    sessionPath: opts.sessionPath,
    title,
    pty: term,
    cols: 80,
    rows: 24,
    wsl: opts.wsl,
    createdAt: Date.now(),
  };
  tabs.set(id, tab);
  activeId = id;
  setSessionWatcher(tab); // no-op for wsl (session sync via WSL UNC paths)

  term.onData((data) => {
    streamTabData(id, data);
  });
  term.onExit(({ exitCode }) => {
    flushTabStream(id);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, exitCode);
    }
    stopSessionWatcher(id);
    tabs.delete(id);
    if (activeId === id) {
      activeId = tabs.size > 0 ? [...tabs.keys()][tabs.size - 1] : null;
    }
  });

  return id;
}

/** Create a tab that SSHs into a remote server and runs pi there. */
function createRemoteTab(id: string, opts: CreateTabOptions): string {
  const r = opts.remote!;
  const port = String(r.port ?? 22);
  const sshArgs = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-t",
    "-p", port,
    `${r.user}@${r.host}`,
  ];
  // Build the remote command.
  // `bash -i` = interactive → sources .bashrc → pi on PATH.
  // `bash -l` only sources .bash_profile which many servers don't have.
  // Env overrides are exported INSIDE the `bash -ic` string so a remote
  // .bashrc cannot clobber them; COLORFGBG steers pi's theme detection to
  // the app-chosen mode (matching the local tab's xterm palette).
  const mode = opts.themeMode ?? currentThemeMode;
  const modeEnv =
    `export TERM=xterm-256color COLORTERM=truecolor COLORFGBG="${TERMINAL_THEMES[mode].colorfgbg}";`;
  const shellPath = cdArg(r.path || "~");
  const inner = r.startPi === false
    ? `exec bash -i`
    : opts.sessionPath
      // sessionArg already ends with the `pi ...` invocation.
      ? sessionArg(opts.sessionPath)
      : `pi; exec bash -i`;
  const remoteCmd = `cd ${shellPath} && bash -ic '${modeEnv} ${inner}'`;
  sshArgs.push(remoteCmd);

  const sessionBase = sessionTitleFromFile(opts.sessionPath ?? "")
    ?? opts.sessionPath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/i, "");
  // Blank remote tabs get a path-basename placeholder (like local tabs); the
  // real session label arrives once pi writes the session file (SFTP sync).
  const remoteBase = (r.path || "~").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || r.user;
  const title = opts.title || sessionBase || (r.startPi === false ? `${r.user}@${r.host} · 连接` : remoteBase === "~" ? `${r.user}@${r.host}` : remoteBase);

  let term: pty.IPty;
  try {
    const sshBin = findSshBin();
    console.log(`[pty] remote tab ${id}: ${sshBin} ${sshArgs.join(" ")}`);
    // Use process.cwd() for the local spawn context, not the remote path.
    term = pty.spawn(sshBin, sshArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      useConpty: true,
    });
    console.log(`[pty] remote tab ${id}: ssh ${r.user}@${r.host}:${port} -> ${shellPath}`);
  } catch (e) {
    console.error(`[pty] remote spawn FAILED:`, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    throw e;
  }

  const tab: TabInfo = {
    id,
    cwd: opts.cwd,
    sessionPath: opts.sessionPath,
    title,
    pty: term,
    cols: 80,
    rows: 24,
    remote: opts.remote,
    remoteBrowsePath: r.path || "~",
    remoteKey: buildRemoteKey(r),
    createdAt: Date.now(),
  };
  tabs.set(id, tab);
  if (r.startPi !== false) activeId = id;
  setSessionWatcher(tab); // no-op for remote (sync happens via SFTP in index.ts)

  term.onData((data) => {
    streamTabData(id, data);
  });
  term.onExit(({ exitCode }) => {
    flushTabStream(id);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, exitCode);
    }
    stopSessionWatcher(id);
    tabs.delete(id);
    if (activeId === id) {
      activeId = tabs.size > 0 ? [...tabs.keys()][tabs.size - 1] : null;
    }
  });

  return id;
}
