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
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import { join } from "node:path";
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
  const nodeBin = findExe("node.exe", [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node.exe"),
  ]);
  const result = spawnSync(nodeBin, ["--version"], { stdio: "pipe", windowsHide: true });
  return !result.error && result.status === 0;
}

export function hasGlobalPiInstalled(): boolean {
  const diag = getPiDetectionDiagnostics();
  return diag.ok;
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

/** Find an absolute global `pi` executable for conpty. */
function findPiBin(): string {
  const fromWhere = findViaWhere("pi");
  if (fromWhere) return fromWhere;

  return findExe("pi.cmd", [
    join(process.env.APPDATA ?? "", "npm\\pi.cmd"),
    join(process.env.USERPROFILE ?? "", "AppData\\Roaming\\npm\\pi.cmd"),
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\pi.cmd"),
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node-v22.19.0-win-x64\\pi.cmd"),
  ]);
}

/** Find an absolute `ssh` binary for conpty. */
export function findSshBin(): string {
  // Windows OpenSSH is more reliable with conpty than Git's bundled ssh.
  const winSsh = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
  if (existsSync(winSsh)) return winSsh;
  return findExe("ssh.exe", []);
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
}

let nextId = 1;
const tabs = new Map<string, TabInfo>();
let activeId: string | null = null;

export interface CreateTabOptions {
  cwd: string;
  sessionPath?: string; // resume a specific session file
  continueRecent?: boolean; // when true, pi -c (continue most recent)
  remote?: RemoteOpts; // SSH into a remote server instead of local pi
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

/** Create a new tab and spawn pi inside it. Returns the tab id. */
export function createTab(opts: CreateTabOptions): string {
  const id = `tab-${nextId++}`;

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
  const sessionBase = sessionDisplayName(opts.sessionPath)
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

  const tab: TabInfo = { id, cwd: opts.cwd, sessionPath: opts.sessionPath, title, pty: term, cols: 80, rows: 24 };
  tabs.set(id, tab);
  activeId = id;

  // Stream pty output to the renderer on a per-tab channel.
  term.onData((data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:data:${id}`, data);
    }
  });
  term.onExit(({ exitCode }) => {
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
  return (
    ` export PIPI_S="$(printf %s '${b64}' | base64 -d 2>/dev/null || printf %s '${b64}' | base64 -D 2>/dev/null)";` +
    ` pi \${PIPI_S:+--session "$PIPI_S"} || exec bash -i`
  );
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
      : `pi || exec bash -i`;
  const remoteCmd = `cd ${shellPath} && bash -ic '${modeEnv} ${inner}'`;
  sshArgs.push(remoteCmd);

  const sessionBase = sessionDisplayName(opts.sessionPath)
    ?? opts.sessionPath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/i, "");
  const title = opts.title || sessionBase || (r.startPi === false ? `${r.user}@${r.host} · 连接` : `${r.user}@${r.host}`);

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
  };
  tabs.set(id, tab);
  if (r.startPi !== false) activeId = id;

  term.onData((data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:data:${id}`, data);
    }
  });
  term.onExit(({ exitCode }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, exitCode);
    }
    tabs.delete(id);
    if (activeId === id) {
      activeId = tabs.size > 0 ? [...tabs.keys()][tabs.size - 1] : null;
    }
  });

  return id;
}
