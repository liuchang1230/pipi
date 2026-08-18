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
import { existsSync, readFileSync, readdirSync, statSync, watch, openSync, closeSync, readSync, mkdirSync, writeFileSync, cpSync, type FSWatcher } from "node:fs";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { delimiter, dirname, join, posix } from "node:path";
import { sessionDirFor } from "./session-list";
import { parseWslDistroList, type WslDistro } from "./wsl";
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
export interface ResolvedPiBin {
  file: string;
  args: string[];
}

/**
 * Prefer a globally installed `pi.cmd` so the app does not depend on a
 * project-local `@earendil-works/pi-coding-agent` package. conpty can be
 * finicky with batch shims, so we resolve the absolute executable path.
 *
 * Callers only reach this after ensurePiReady() succeeded, which auto-installs
 * the global pi from the bundled copy when it is missing — so a working global
 * pi (or an explicit notice) is guaranteed before we get here.
 */
function resolvePiBin(): ResolvedPiBin {
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

/** Path to the bundled pi package inside this app (works dev + packaged/asar). */
export function bundledPiPackagePath(): string {
  return join(app.getAppPath(), "node_modules", "@earendil-works", "pi-coding-agent");
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
  if (cachedPiOk === true) return true;
  // A cached FALSE must not be trusted blindly: the warm async probe can
  // fail transiently (startup load, AV scan, slow CLI boot) and would
  // otherwise poison the cache for the whole session — every local tab would
  // then claim "pi not found". Re-verify with the authoritative sync probe,
  // throttled so a genuinely-missing pi doesn't block the main thread on
  // every click.
  if (cachedPiOk === false && cachedPiCheckAt !== null && Date.now() - cachedPiCheckAt < PI_RECHECK_TTL_MS) {
    return false;
  }
  cachedPiCheckAt = Date.now();
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

/** Map npm install output lines to a short human stage for the progress dialog. */
export function classifyInstallStage(line: string): string | null {
  const l = line.toLowerCase();
  if (l.includes("npm error") || l.startsWith("npm err") || /^npm (er|error)/.test(l)) return "安装失败";
  if (l.includes("fetch") || l.includes("http ")) return "正在下载依赖…";
  if (l.includes("reify") || l.includes("ideal tree") || l.includes("resolving")) return "正在解析依赖…";
  if (l.includes("added ") || l.includes("changed ") || l.includes("removed") || l.includes("audit")) return "正在收尾…";
  if (l.includes("error")) return "正在重试下载…";
  return "正在安装…";
}

/**
 * Resolve a spawnable npm entry from the npm.cmd shim: prefer spawning
 * node.exe with npm-cli.js directly (cmd.exe /c quoting is fragile with
 * "Program Files" paths, and spawning .cmd via node's spawn fails with
 * EINVAL on some Node/Windows combos). Falls back to spawning the shim
 * itself with shell:true (works for PATH-resolved bare names).
 */
export function resolveNpmEntry(npmBin: string): { file: string; args: string[]; shell?: boolean } | null {
  if (!/\.(cmd|bat)$/i.test(npmBin)) return { file: npmBin, args: [] };
  const dir = dirname(npmBin);
  const cli = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  const node = join(dir, "node.exe");
  if (existsSync(cli) && existsSync(node)) return { file: node, args: [cli] };
  // nvm-style layout: <root>/lib/node_modules/npm/bin/npm-cli.js
  const cli2 = join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const node2 = findExe("node.exe", [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe"),
  ]);
  if (existsSync(cli2) && node2) return { file: node2, args: [cli2] };
  // Proxy shims (nvm-windows/Volta point npm.cmd elsewhere): let node's
  // shell:true resolve it via cmd.exe. Works for bare/PATH names; shims with
  // spaces in the path are rare here since cli/npm.cmd layouts are covered
  // above.
  return { file: npmBin, args: [], shell: true };
}

export interface GlobalPiInstallHandle {
  abort: () => void;
  promise: Promise<{ ok: true } | { ok: false; error: string }>;
}

/** npm global dir (where `pi.cmd` / the pi package live). */
export function npmGlobalDir(): string {
  return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"), "npm");
}

/** Global pi package dir (npm global layout). */
export function globalPiPackageDir(): string {
  return join(npmGlobalDir(), "node_modules", "@earendil-works", "pi-coding-agent");
}

/** The shims npm writes next to the package (pi / pi.cmd / pi.ps1). */
const PI_SHIMS: Array<{ fileName: string; content: string }> = [
  {
    fileName: "pi.cmd",
    content: `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*
`,
  },
  {
    fileName: "pi",
    content: `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case \`uname\` in
    *CYGWIN*|*MINGW*|*MSYS*) basedir=\`cygpath -w "$basedir"\`;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"
else
  exec node  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"
fi
`,
  },
  {
    fileName: "pi.ps1",
    content: `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe"  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" $args
  $ret=$LASTEXITCODE
} else {
  & "node$exe"  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" $args
  $ret=$LASTEXITCODE
}
exit $ret
`,
  },
];

/**
 * Recursively walk a package's dependency closure from the bundled
 * node_modules (app.asar in packaged builds; plain disk in dev) and return
 * the package-relative paths to copy (relative to node_modules), preserving
 * nested layout for version conflicts (e.g. A/node_modules/B).
 */
function collectPackageClosure(rootNM: string, entryName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  function walk(pkgName: string, baseDir: string): void {
    const key = baseDir ? `${baseDir}/${pkgName}` : pkgName;
    if (seen.has(key)) return;
    const pkgDir = join(rootNM, baseDir, pkgName);
    const pkgFile = join(pkgDir, "package.json");
    if (!existsSync(pkgFile)) return;
    seen.add(key);
    out.push(key);
    let pkg: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as typeof pkg;
    } catch {
      return;
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    for (const dep of Object.keys(deps)) {
      // npm flat layout: prefer the dep's own nested node_modules, else top-level.
      if (existsSync(join(pkgDir, "node_modules", dep, "package.json"))) {
        walk(dep, key + "/node_modules");
      } else {
        walk(dep, "");
      }
    }
  }
  walk(entryName, "");
  return out;
}

async function copyDirRecursive(src: string, dest: string, filter: (name: string) => boolean): Promise<void> {
  const fsp = await import("node:fs/promises");
  await fsp.mkdir(dest, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyDirRecursive(s, d, filter);
    } else if (filter(ent.name)) {
      await fsp.writeFile(d, await fsp.readFile(s));
    }
  }
}

/**
 * Install the GLOBAL pi from the app's bundled copy — no npm, no network, no
 * MSVC. Copies the pi package plus its full dependency closure (keeping npm's
 * flat/nested layout) into the npm global node_modules, then writes the
 * pi/pi.cmd/pi.ps1 shims. Returns what happened.
 */
export async function installGlobalPiFromBundled(): Promise<
  | { ok: true; action: "installed" | "noop" }
  | { ok: false; error: string }
> {
  const src = bundledPiPackagePath();
  const dest = globalPiPackageDir();
  try {
    const cliDest = join(dest, "dist", "cli.js");
    const needsCopy =
      !existsSync(cliDest) ||
      !existsSync(src) ||
      readFileSync(join(src, "dist", "cli.js"), "utf8").slice(0, 50) !== readFileSync(cliDest, "utf8").slice(0, 50);
    if (needsCopy) {
      const startedAt = Date.now();
      const rootNM = join(app.getAppPath(), "node_modules");
      const destNM = join(npmGlobalDir(), "node_modules");
      const closure = collectPackageClosure(rootNM, "@earendil-works/pi-coding-agent");
      console.log(`[pi] bundled closure: ${closure.length} packages`);
      for (const rel of closure) {
        // Async recursive copy: fs.cpSync does not work when the source is
        // inside app.asar (opendirSync isn't patched), but readdirSync/
        // readFileSync are — and readFileSync transparently reads
        // app.asar.unpacked (pi-tui's native module) for us. Async so the
        // ~19s first-time copy never blocks the main process / IPC.
        await copyDirRecursive(
          join(rootNM, rel),
          join(destNM, rel),
          (name: string) => !/\.(map|tsbuildinfo)$/.test(name),
        );
      }
      console.log(`[pi] bundled → global package copy: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
    // Shim write is ALWAYS ensured (a missing pi.cmd/pi/pi.ps1 is a broken
    // install even when the package dir is intact).
    for (const shim of PI_SHIMS) {
      writeFileSync(join(npmGlobalDir(), shim.fileName), shim.content, "utf8");
    }
    return { ok: true, action: needsCopy ? "installed" : "noop" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Streaming `npm install -g` with per-line output callback (for the
 * renderer's progress dialog). `--ignore-scripts` mirrors the original
 * behavior; `--no-audit --no-fund --loglevel=info` reduce tail latency and
 * make the fetch/reify stages visible in piped output.
 */
export function startGlobalPiInstall(onOutput?: (line: string) => void): GlobalPiInstallHandle {
  const npmBin = findExe("npm.cmd", [
    join(process.env.APPDATA ?? "", "npm", "npm.cmd"),
    "C:\\Program Files\\nodejs\\npm.cmd",
    "C:\\Program Files (x86)\\nodejs\\npm.cmd",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "npm.cmd"),
  ]);
  const entry = resolveNpmEntry(npmBin);
  let child: ReturnType<typeof spawn> | null = null;
  let settled = false;
  let resolveFn: (r: { ok: true } | { ok: false; error: string }) => void = () => {};
  let timer: NodeJS.Timeout | null = null;
  const finish = (r: { ok: true } | { ok: false; error: string }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveFn(r);
  };
  const promise = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    resolveFn = resolve;
    if (!entry) {
      // Shouldn't happen when npm is on PATH, but fail with a helpful error.
      finish({ ok: false, error: `无法定位 npm（${npmBin} 未找到 npm-cli.js），请检查 Node.js 安装` });
      return;
    }
    // Async + 180s cap: `npm install -g` used to block the main thread 10-60s+
    // (freezing every IPC channel, incl. terminal streaming) on the click path.
    child = spawn(
      entry.file,
      [...entry.args, "install", "-g", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=info", "@earendil-works/pi-coding-agent"],
      {
        windowsHide: true,
        shell: entry.shell,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: "安装超时（180 秒），请检查网络后重试" });
    }, 180000);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const onData = (d: Buffer) => {
      const s = d.toString("utf8");
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t) onOutput?.(t);
      }
    };
    child.stdout?.on("data", (d: Buffer) => {
      stdout.push(String(d));
      onData(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr.push(String(d));
      onData(d);
    });
    child.on("error", (e) => finish({ ok: false, error: e.message }));
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true });
      const err = (stderr.join("") + "\n" + stdout.join("")).trim() || `exit code ${code}`;
      finish({ ok: false, error: err.slice(-1200) });
    });
  });
  return {
    abort: () => {
      try {
        child?.kill();
      } catch {
        /* */
      }
      // Settle immediately (settled guard makes the late `close` a no-op) so
      // the UI never sits in "正在取消…" up to the 180s cap.
      finish({ ok: false, error: "已取消" });
    },
    promise,
  };
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
/** When the last authoritative (sync) pi probe ran; used to throttle the
 *  re-verification of a cached false (a transient failure must self-heal,
 *  but a genuinely missing pi shouldn't block the main thread every click). */
let cachedPiCheckAt: number | null = null;
const PI_RECHECK_TTL_MS = 5000;

/** Reset the detection caches (after auto-installing pi, so the freshly
 *  installed binary is picked up instead of the stale failure). */
export function invalidatePiDetection(): void {
  cachedPiBin = undefined;
  cachedNodeOk = null;
  cachedPiOk = null;
  cachedPiCheckAt = null;
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
  // Cache ONLY the success: a transient probe failure must NOT poison the
  // cache — leave it null so the next hasGlobalPiInstalled() runs the
  // authoritative sync probe on demand (the click path pays ~1.1s only when
  // the warm probe failed).
  child.once("exit", (code) => {
    if (code === 0) cachedPiOk = true;
  });
  child.once("error", () => {
    /* keep cachedPiOk = null → sync re-check on demand */
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
  // 1. npm 全局权威位置（`npm install -g` 的唯一目标目录，绝对路径不受
  //    PATH/where 选择影响）。
  const npmGlobalCandidates = [
    join(npmGlobalDir(), "pi.cmd"),
    join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "pi.cmd"),
  ];
  for (const c of npmGlobalCandidates) {
    if (existsSync(c)) {
      cachedPiBin = c;
      return c;
    }
  }
  // 2. where.exe（用户 PATH 里的 pi——自定义安装 / nvm 布局）。
  const fromWhere = findViaWhere("pi");
  if (fromWhere) {
    cachedPiBin = fromWhere;
    return fromWhere;
  }
  // 3. 其他常见位置。
  cachedPiBin = findExe("pi.cmd", [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "pi.cmd"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node-v22.19.0-win-x64", "pi.cmd"),
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

/** Promisified spawn capturing stdout+stderr as raw Buffers. Resolves on
 *  spawn-failure too (caller checks error/code) and never blocks the main
 *  thread. Optional timeout kills a hung child and resolves with a
 *  "ETIMEDOUT" code so the caller can fail fast instead of hanging forever. */
function execFileAsync(
  file: string,
  args: string[],
  timeoutMs?: number
): Promise<{ stdout: Buffer; stderr: Buffer; code: number | string | null; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
    child.stdout?.on("data", (d: Buffer) => outChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks), code: null, error });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks), code: timedOut ? "ETIMEDOUT" : code, error: undefined });
    });
  });
}


/** List installed WSL distributions (async — the old spawnSync blocked the
 *  main thread ~100-300ms on every model-config/remote-dialog open; a 15s cap
 *  so a cold-starting WSL service fails fast instead of hanging the IPC). */
export async function listWslDistros(): Promise<WslDistro[]> {
  const wslBin = findWslBin();
  const { stdout, code, error } = await execFileAsync(wslBin, ["-l", "-v"], 15000);
  if (error || code !== 0) return [];
  return parseWslDistroList(stdout);
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

/**
 * Resolve the real cli.js a pi shim points at. This is exactly what running
 * `pi` in a terminal does (pi.cmd → node cli.js); resolving it lets us verify
 * the install by spawning node.exe directly — node is an .exe, so there is no
 * cmd.exe /c quoting to get wrong (a pi.cmd under a path with spaces used to
 * make the old `cmd /c <path> --version` probe fail → false "pi missing").
 */
export function resolveCliJsFromShim(piBin: string): string | null {
  if (!/\.(cmd|bat)$/i.test(piBin)) return null;
  // Standard npm layout: <npmGlobalDir>\node_modules\@earendil-works\pi-coding-agent\dist\cli.js
  const standard = join(dirname(piBin), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (existsSync(standard)) return standard;
  // Custom layout: read the shim and find the cli.js it references.
  try {
    const content = readFileSync(piBin, "utf8");
    const m = content.match(/("[^"]*cli\.js"|[^\s"]*cli\.js)/i);
    if (m) {
      const cand = m[1].replace(/%dp0%/gi, dirname(piBin)).replace(/"/g, "").replace(/\\/g, "/");
      const abs = cand.startsWith("/") || /^[A-Za-z]:/.test(cand) ? cand : join(dirname(piBin), cand);
      if (existsSync(abs)) return abs;
    }
  } catch {
    /* unreadable shim → fall through */
  }
  return null;
}

function runPiVersion(piBin: string) {
  // Preferred: shim → cli.js → node.exe directly (= what a terminal does when
  // you run `pi`). Bypasses cmd.exe /c quoting entirely.
  const cli = resolveCliJsFromShim(piBin);
  const nodeBin = findExe("node.exe", [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe"),
  ]);
  if (cli && nodeBin) {
    return spawnSync(nodeBin, [cli, "--version"], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    });
  }
  // Fallback: run the shim/binary directly as before.
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

export interface WslOpts {
  distro: string;
  path?: string; // Linux path, default ~
}

export interface TabInfo {
  id: string;
  cwd: string;
  sessionPath?: string;
  title: string;
  /** Present for pty-backed tabs; undefined for RPC-backed tabs (registerExternalTab). */
  pty?: pty.IPty;
  cols: number;
  rows: number;
  remote?: RemoteOpts;
  remoteBrowsePath?: string;
  remoteKey?: string;
  wsl?: WslOpts;
  createdAt: number;
  /** True when the pty runs a plain interactive shell (no pi agent), e.g.
   *  after pi exits (/quit) or for startPi:false connection tabs. Stall
   *  auto-restart is DISABLED for these — a quiet shell may be running a
   *  long silent command, and killing it would lose work. */
  shellMode?: boolean;
  // Stall watchdog clocks (Windows ConPTY freeze after long lock/sleep).
  // Absent for non-pty (RPC/SDK) tabs — the watchdog only covers pty tabs.
  lastOutputAt?: number;
  pendingProbe?: boolean;
  probeTimer?: NodeJS.Timeout | null;
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
  /** Explicit tab id (RPC→pty fallback keeps its identity across the switch). */
  id?: string;
  /** Spawn size (default 80x24); used by in-place restarts to keep the pty
   *  aligned with the renderer without waiting for a resize event. */
  cols?: number;
  rows?: number;
}

export interface RemoteOpts {
  host: string;
  user: string;
  port?: number; // default 22
  path?: string; // remote working dir (default: home)
  password?: string;
  startPi?: boolean;
  /** Remote pi data dir override (default: ~/.pi/agent). Lets multiple
   *  colleagues sharing one SSH account keep isolated sessions/models. */
  agentDir?: string;
}

/**
 * Validate a user-supplied remote agentDir. Only `~`-prefixed or absolute
 * POSIX paths made of safe characters are accepted (no spaces/quotes/`..`),
 * so the value can be spliced into a `bash -ic '...'` string unquoted without
 * injection risk. Returns the trimmed value, or null when invalid/empty.
 */
export function sanitizeRemoteAgentDir(dir: string | undefined): string | null {
  if (!dir || !dir.trim()) return null;
  const d = dir.trim();
  if (d.includes("..")) return null;
  // Reject bash tilde-prefix forms that expand differently than our SFTP-side
  // expansion: `~user` (someone else's home), `~-`/`~+`/`~-N`/`~+N` (OLDPWD /
  // PWD-relative). Only plain `~` and `~/…` are supported.
  if (/^~[A-Za-z]/.test(d) || d.startsWith("~-") || d.startsWith("~+")) return null;
  if (/^~[A-Za-z0-9_\-./]*$/.test(d)) return d;
  if (/^\/[A-Za-z0-9_\-./]*$/.test(d)) return d;
  return null;
}

/**
 * Resolve the remote pi data dir for SFTP-side reads/writes: the per-user
 * override when set (with `~` expanded against the remote home), else the
 * default `~/.pi/agent`. Must mirror the shell-side expansion in the spawn
 * commands (bash expands `~` in `export PI_CODING_AGENT_DIR=~/…` the same way).
 */
export function remoteAgentDir(remote: Pick<RemoteOpts, "agentDir">, homeDir: string): string {
  if (remote.agentDir) {
    if (remote.agentDir === "~") return homeDir;
    if (remote.agentDir.startsWith("~/")) return posix.join(homeDir, remote.agentDir.slice(2));
    return remote.agentDir;
  }
  return posix.join(homeDir, ".pi", "agent");
}

export function buildRemoteKey(remote: Pick<RemoteOpts, "host" | "user" | "port" | "agentDir">): string {
  return `${remote.user}@${remote.host}:${remote.port ?? 22}${remote.agentDir ? `[${remote.agentDir}]` : ""}`;
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

// Windows ConPTY freeze: after a LONG lock/sleep, conhost's pipe can stall —
// output freezes and input is silently swallowed (known OS bug; VS Code and
// Windows Terminal hit the same wall and recover by restarting the terminal).
// Watchdog: when a pi tab has produced NO output for a long idle and the
// FIRST keystroke afterwards gets no echo within a short window, the pty is
// stalled — rebuild it in place (same tab id/session; pi resumes from JSONL).
const STALL_IDLE_MS = 3 * 60 * 1000; // zero-output idle that arms the probe
const STALL_PROBE_MS = 8000; // echo wait after the first post-idle input

/**
 * Pure stall-probe decision: arm the echo probe on the FIRST input after a
 * long zero-output idle, in a pi tab (never a plain shell — a silent shell
 * may be running a long quiet command). Exported for unit tests.
 */
export function shouldArmStallProbe(
  shellMode: boolean | undefined,
  pendingProbe: boolean | undefined,
  lastOutputAt: number | undefined,
  now: number,
  idleMs: number
): boolean {
  return !shellMode && !pendingProbe && (lastOutputAt ?? 0) > 0 && now - (lastOutputAt ?? 0) > idleMs;
}

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
  const t = tabs.get(id)!;
  t.lastOutputAt = Date.now();
  // Any output means the pty is alive — cancel a pending stall probe.
  if (t.pendingProbe) {
    t.pendingProbe = false;
    if (t.probeTimer) clearTimeout(t.probeTimer);
    t.probeTimer = null;
  }
  // WSL/remote fall back to a plain interactive shell when pi isn't installed
  // (`echo [远程服务器未检测到pi-agent…]`). Mark it so the stall watchdog
  // never auto-restarts (killing) a shell that may run a long quiet command.
  if (!t.shellMode && data.includes("未检测到pi-agent")) {
    t.shellMode = true;
  }
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
  t.shellMode = true; // pi is gone; this tab is now a plain interactive shell
  // A pending stall probe must not fire against the fresh shell (it would
  // restart the tab into pi).
  if (t.probeTimer) clearTimeout(t.probeTimer);
  t.probeTimer = null;
  t.pendingProbe = false;
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
    const cur = tabs.get(id);
    if (!cur || cur.pty !== term) return; // stale pty (replaced by restart)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, exitCode);
    }
  });
}

/**
 * Push a short notice into a tab's terminal stream (shown to the user).
 * Counts as pty activity, so it also refreshes the stall clock.
 */
function sendTabNotice(id: string, text: string): void {
  streamTabData(id, `\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
}

/**
 * Rebuild a tab's pty in place after the Windows ConPTY pipe stalled (known
 * conhost bug after a long session lock/sleep: output freezes, input is
 * swallowed — see STALL_* above). The tab keeps its id/title/session, so the
 * renderer's terminal buffer and subscriptions survive; pi resumes the same
 * session file on the fresh pty.
 */
export function restartTab(id: string): boolean {
  const t = tabs.get(id);
  if (!t || !t.pty) return false;
  const prevActive = activeId;
  const prevBrowsePath = t.remoteBrowsePath;
  const opts: CreateTabOptions = {
    id: t.id,
    cwd: t.cwd,
    sessionPath: t.sessionPath,
    title: t.title,
    remote: t.remote,
    wsl: t.wsl,
    cols: t.cols,
    rows: t.rows,
  };
  if (t.probeTimer) clearTimeout(t.probeTimer);
  t.probeTimer = null;
  t.pendingProbe = false;
  // Old watcher must not double-watch the session dir after createTab.
  stopSessionWatcher(id);
  // Kill BEFORE the synchronous createTab: node-pty's exit event is delivered
  // on a later tick, by which time tabs.get(id) is the NEW entry and the
  // onExit stale-guard (t.pty === term) swallows it.
  try {
    t.pty.kill();
  } catch {
    /* process may already be dead */
  }
  let newId: string;
  try {
    newId = createTab(opts);
  } catch (error) {
    console.error(
      `[pty] tab ${id}: restart spawn FAILED:`, error instanceof Error ? error.message : String(error)
    );
    return false;
  }
  if (newId !== id) return false;
  // Keep the remote file-tree root where it was (createRemoteTab resets it).
  const fresh = tabs.get(id);
  if (fresh?.remote && prevBrowsePath) fresh.remoteBrowsePath = prevBrowsePath;
  // Don't steal focus from another tab the user may be viewing.
  if (prevActive !== id) activeId = prevActive;
  // New pty spawns at the stored size; keep the renderer aligned even though
  // TerminalView does not remount (same tab id → no resize event).
  const cur = tabs.get(id);
  if (cur?.pty) {
    try {
      cur.pty.resize(t.cols, t.rows);
    } catch {
      /* ignore */
    }
  }
  sendTabNotice(id, "检测到终端长时间无响应，已自动重连（会话已保留）");
  emitTabsChanged();
  return true;
}

/** Create a new tab and spawn pi inside it. Returns the tab id. */
export function createTab(opts: CreateTabOptions): string {
  const id = opts.id ?? `tab-${nextId++}`;

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
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
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

  const tab: TabInfo = {
    id,
    cwd: opts.cwd,
    sessionPath: opts.sessionPath,
    title,
    pty: term,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    createdAt: Date.now(),
    lastOutputAt: Date.now(),
  };
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
    // A stale exit (the pty was replaced by restartTab) must neither respawn
    // a shell onto the NEW pty nor announce an exit to the renderer.
    if (!t || t.pty !== term) return;
    // pi exited cleanly (e.g. `/quit`) — drop into an interactive local shell
    // in the SAME tab so the terminal stays usable instead of going blank.
    // The pty must still be THIS tab's pty: a close-kill followed by a
    // same-id re-register (terminal→chat switch respawns the tab with the
    // SDK backend) would otherwise respawn a shell onto the NEW tab record
    // and leak the process.
    if (!t.remote && !t.wsl && exitCode === 0) {
      respawnShellInTab(id);
      return;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:exit:${id}`, exitCode);
    }
  });

  return id;
}

/**
 * True when a pty tab's underlying process is still running. node-pty's
 * typings omit `exitCode`, but the runtime exposes it (windowsPtyAgent.get
 * exitCode — undefined until the process exits). The "alive" semantic for
 * tab:alive — a registered-but-crashed ssh.exe must NOT report connected.
 */
export function isPtyTabAlive(tab: TabInfo): boolean {
  const pty = tab.pty as { exitCode?: number } | undefined;
  return !!pty && pty.exitCode === undefined;
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
  if (!t?.pty || cols < 1 || rows < 1) return false;
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
  if (!t?.pty) return false;
  const now = Date.now();
  // Skip arming for the app's own CSI color-scheme answers/pushes — these are
  // system writes (pi's `CSI ?996n` query answer / theme flip), not user
  // keystrokes, and must not masquerade as "user typed into a stalled pty".
  const isSystemCsi = data === "\x1b[?997;1n" || data === "\x1b[?997;2n";
  // First input after a long zero-output idle in a pi tab: arm a short echo
  // probe. A healthy idle pty echoes the keystroke within ms (any output
  // cancels the probe); a ConPTY-stalled pty stays silent → the probe
  // rebuilds the tab. Shell tabs are exempt (a silent shell may be running
  // a long quiet command — restarting would kill it).
  if (!isSystemCsi && shouldArmStallProbe(t.shellMode, t.pendingProbe, t.lastOutputAt, now, STALL_IDLE_MS)) {
    t.pendingProbe = true;
    t.probeTimer = setTimeout(() => {
      const cur = tabs.get(id);
      if (!cur || !cur.pendingProbe) return; // output arrived → healthy
      cur.pendingProbe = false;
      cur.probeTimer = null;
      console.log(
        `[pty] tab ${id}: no echo after ${STALL_IDLE_MS / 60000}min silence — ConPTY stall, restarting`
      );
      restartTab(id);
    }, STALL_PROBE_MS);
  }
  try {
    t.pty.write(data);
  } catch (error) {
    // Broken input pipe (conpty died / pipe torn after sleep) — rebuild the
    // tab instead of silently swallowing keystrokes.
    console.error(`[pty] tab ${id}: write failed, restarting:`, error instanceof Error ? error.message : String(error));
    restartTab(id);
    return false;
  }
  return true;
}

/**
 * Register a non-pty (RPC-backed) tab in the shared registry so
 * getTab/listTabs/active-tracking/title-watchers treat it like any other tab.
 * The caller owns the RPC process lifecycle (rpc-session.ts).
 */
export function registerExternalTab(tab: TabInfo): void {
  tabs.set(tab.id, tab);
  activeId = tab.id;
}

/** Remove a non-pty tab from the shared registry (no process kill). */
export function unregisterExternalTab(id: string): boolean {
  if (!tabs.has(id)) return false;
  tabs.delete(id);
  if (activeId === id) {
    activeId = tabs.size > 0 ? [...tabs.keys()][tabs.size - 1] : null;
  }
  return true;
}

/** Kill and remove a tab. Returns false if not found. */
export function closeTab(id: string): boolean {
  const t = tabs.get(id);
  if (!t) return false;
  flushTabStream(id);
  stopSessionWatcher(id);
  if (t.probeTimer) clearTimeout(t.probeTimer);
  t.probeTimer = null;
  t.pendingProbe = false;
  if (t.pty) {
    try {
      t.pty.kill();
    } catch {
      /* process may already be dead */
    }
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
  if (!t?.pty) return () => {};
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
  // (or resume a session). Falls back to interactive bash with a clear
  // notice when pi is not installed in the distro.
  const inner = linuxSessionPath
    ? sessionArg(linuxSessionPath)
    : `if command -v pi >/dev/null 2>&1; then pi; else echo [\u8fdc\u7a0b\u670d\u52a1\u5668\u672a\u68c0\u6d4b\u5230pi-agent\uff0c\u5df2\u5207\u6362\u5230\u666e\u901ashell]; fi; exec bash -i`;

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
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
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
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    wsl: opts.wsl,
    createdAt: Date.now(),
    lastOutputAt: Date.now(),
  };
  tabs.set(id, tab);
  activeId = id;
  setSessionWatcher(tab); // no-op for wsl (session sync via WSL UNC paths)

  term.onData((data) => {
    streamTabData(id, data);
  });
  term.onExit(({ exitCode }) => {
    flushTabStream(id);
    const cur = tabs.get(id);
    if (!cur || cur.pty !== term) return; // stale pty (replaced by restart)
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
    // Keepalive robustness: tolerate 3 missed keepalive replies (~90s) before
    // declaring the server dead, and send TCP-level keepalives so NAT/firewall
    // idle-reapers on the path can't silently drop the session.
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
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
  // Optional per-user pi data dir: keeps sessions/models isolated when several
  // people share one SSH account. Validated at tab:create; `~` expands on the
  // remote shell during the assignment (safe charset → no quoting needed).
  const agentDirEnv = r.agentDir ? ` export PI_CODING_AGENT_DIR=${r.agentDir};` : "";
  const shellPath = cdArg(r.path || "~");
  const inner = r.startPi === false
    ? `exec bash -i`
    : opts.sessionPath
      // sessionArg already ends with the `pi ...` invocation.
      ? sessionArg(opts.sessionPath)
      : `if command -v pi >/dev/null 2>&1; then pi; else echo [\u8fdc\u7a0b\u670d\u52a1\u5668\u672a\u68c0\u6d4b\u5230pi-agent\uff0c\u5df2\u5207\u6362\u5230\u666e\u901ashell]; fi; exec bash -i`;
  const remoteCmd = `cd ${shellPath} && bash -ic '${modeEnv}${agentDirEnv} ${inner}'`;
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
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
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
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    remote: opts.remote,
    remoteBrowsePath: r.path || "~",
    remoteKey: buildRemoteKey(r),
    createdAt: Date.now(),
    lastOutputAt: Date.now(),
    shellMode: r.startPi === false ? true : undefined,
  };
  tabs.set(id, tab);
  if (r.startPi !== false) activeId = id;
  setSessionWatcher(tab); // no-op for remote (sync happens via SFTP in index.ts)

  term.onData((data) => {
    streamTabData(id, data);
  });
  term.onExit(({ exitCode }) => {
    flushTabStream(id);
    const cur = tabs.get(id);
    if (!cur || cur.pty !== term) return; // stale pty (replaced by restart)
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
