import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { isAbsolute, relative, sep, join, posix as posixPath, win32 as win32Path } from "node:path";
import { unlinkSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, rename, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import SftpClient from "ssh2-sftp-client";
import { Client as SshClient } from "ssh2";
import { readFileContent, writeFileContent, createDirectory, deletePath, renamePath, isValidName, type FileOpResult } from "./file-tree";
import { specForModel } from "../shared/model-specs";
import { lookupModelSpecs } from "./specs-lookup";
import {
  createTab, closeTab, closeAllTabs, getTab, listTabs, setActiveTab,
  resizeTab, writeTab, subscribeTab, getActiveTab, findSshBin,
  getRemoteBrowsePath, setRemoteBrowsePath, buildRemoteKey, setThemeMode,
  hasNodeInstalled, hasGlobalPiInstalled, installGlobalPi, getPiDetectionDiagnostics, warmPiDetection, invalidatePiDetection,
  onTabsChanged, setTabTitle, linkTabSession, listWslDistros,
  type TabInfo, type RemoteOpts, type WslOpts,
} from "./pty";
import {
  ensureLocalSettingsTheme, ensureLocalThemeFiles, syncThemesViaSftp,
  type RemoteThemeSyncResult,
} from "./theme-sync";
import type { ThemeMode } from "../shared/terminal-theme";
import type { ModelEditorSpec, PiApi, ProviderEditorConfig } from "../shared/model-config-types";
import { encodeCwd, listLocalProjects, parseSessionText, type SessionEntry } from "./session-list";
import { SessionIndex } from "./session-index";
import { ensureShippedExtensions } from "./extension-sync";
import {
  closeAllRpcSessions, closeRpcTab, createRpcTab, getRpcSession, listRpcSessions,
  setUiRequestHandler, switchRpcToTerminal, switchTerminalToRpc,
  type ExtensionUiRequest,
} from "./rpc-session";
import { checkPiUpdate, runPiUpdate } from "./update-check";
import { getFileDiff, listFileChanges, getFileHistory, diffTextOf, rollbackFileContent, listGitCommits, getFileAt, type FileVersionEvent } from "./diff-session";
import { FileTreeIndex } from "./file-tree-index";
import { startWatching, stopWatching, onFilePath, onStatus } from "./session-watcher";
import { getSettings, updateSettings, type AppSettings } from "./settings";
import { addLocalProject, addRemoteProject, addWslProject, addModel, updateModel, deleteModel, deleteProject, listModels, listProjects, syncModelToPi, checkPiModelSync } from "./projects";

interface RemoteModelListResponse {
  data?: Array<{ id?: string }>;
}
import { listRemoteHistory, saveRemoteHistory } from "./remote-history";

let mainWindow: BrowserWindow | null = null;
let remotePollTimer: NodeJS.Timeout | null = null;

type RemoteSessionCacheEntry = {
  expiresAt: number;
  sessions: SessionEntry[];
  hydrating: boolean;
  hydratedCount: number;
  hydrationPaused: boolean;
  priority: number;
  lastRequestedAt: number;
};

type RemoteFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: RemoteFileNode[];
};

type RemoteFileTreeCacheEntry = {
  expiresAt: number;
  nodes: RemoteFileNode[];
};

type SftpLease = {
  key: string;
  client: SftpClient;
  homeDir: string;
  lastUsedAt: number;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
  connectPromise: Promise<SftpLease> | null;
};

const REMOTE_SESSION_CACHE_TTL_MS = 12_000;
const REMOTE_FILE_TREE_CACHE_TTL_MS = 5_000;
const SFTP_IDLE_TTL_MS = 20_000;
const REMOTE_SESSION_EAGER_PARSE_LIMIT = 0;
const REMOTE_SESSION_HEAD_HYDRATE_LIMIT = 5;
const REMOTE_SESSION_HYDRATE_BATCH_SIZE = 4;
const REMOTE_SESSION_MAX_CONCURRENT_HYDRATIONS = 2;
const REMOTE_SESSION_READ_BYTE_LIMIT = 128 * 1024;
const remoteSessionCache = new Map<string, RemoteSessionCacheEntry>();
const remoteFileTreeCache = new Map<string, RemoteFileTreeCacheEntry>();
const sftpLeases = new Map<string, SftpLease>();

// Remote theme sync cache: skip re-uploading theme files on every connect.
const remoteThemeSyncAt = new Map<string, number>();
const REMOTE_THEME_SYNC_TTL_MS = 15 * 60 * 1000;
let activeRemoteHydrations = 0;

// --- Live local session list sync -----------------------------------------
// All local session listing/caching lives in SessionIndex (session-index.ts):
// the renderer's session:list invoke, the 4s active-cwd poll, and the
// session:local-updated push all cross the same seam.
const sessionIndex = new SessionIndex();
const fileTreeIndex = new FileTreeIndex();

function startLocalSessionsPoll(cwd: string): void {
  sessionIndex.startPolling(cwd);
}

function stopLocalSessionsPoll(): void {
  sessionIndex.stopPolling();
}

function emitRemoteSessionsUpdated(tabId: string, remoteCwd: string, sessions: SessionEntry[]): void {
  mainWindow?.webContents.send("session:remote-updated", { tabId, remoteCwd, sessions });
  syncRemoteTabTitles(tabId, remoteCwd, sessions);
}

/**
 * Sync remote tab titles (and blank-tab → session links) from a session
 * list. Called whenever remote sessions are fetched/hydrated, so a middle
 * tab's title follows its session label — the same rule as local tabs.
 */
function syncRemoteTabTitles(tabId: string, remoteCwd: string, sessions: SessionEntry[]): void {
  const origin = getTab(tabId);
  if (!origin) return;
  // WSL tabs are matched by distro + resolved path (they have no remoteKey);
  // SSH tabs by host key + browse path. Both follow the same rules below:
  // sync linked tabs' titles and link blank tabs to their session file.
  const isWsl = !!origin.wsl;
  if (!isWsl && !origin.remote) return;
  const sameProject = (t: TabInfo): boolean => {
    if (isWsl) {
      return !!t.wsl && t.wsl.distro === origin.wsl!.distro &&
        (t.wsl.path ?? "~") === remoteCwd;
    }
    return !!t.remote && t.remoteKey === origin.remoteKey &&
      (t.remoteBrowsePath ?? t.remote?.path ?? "~") === remoteCwd;
  };
  // Connection-only tabs (startPi:false, "· 连接") never run pi — exclude them
  // from both title sync and blank-tab linking. WSL tabs always run pi.
  const tabs = listTabs().filter((t) => sameProject(t) && t.remote?.startPi !== false);
  const linked = new Set(tabs.map((t) => t.sessionPath).filter((p): p is string => !!p));
  const labelFor = (s: SessionEntry): string | null => {
    const label = (s.name || s.firstMessage || "").trim();
    return label ? label.slice(0, 40) : null;
  };
  for (const t of tabs) {
    if (!t.sessionPath) continue;
    const s = sessions.find((x) => x.path === t.sessionPath);
    if (!s) continue;
    const label = labelFor(s);
    if (label) setTabTitle(t.id, label);
  }
  // Blank tabs ("+ 新建会话"): the newest unlinked session belongs to the
  // oldest blank tab, mirroring the local dir-watch heuristic.
  const blanks = tabs.filter((t) => !t.sessionPath).sort((a, b) => a.createdAt - b.createdAt);
  if (blanks.length > 0) {
    const unlinked = sessions
      .filter((s) => !linked.has(s.path) && s.mtime >= blanks[0].createdAt - 500)
      .sort((a, b) => b.mtime - a.mtime);
    for (const blank of blanks) {
      const s = unlinked.shift();
      if (!s) break;
      linkTabSession(blank.id, s.path, labelFor(s));
    }
  }
}

function stableRemoteKey(remote: RemoteOpts): string {
  return createHash("sha1")
    .update(JSON.stringify({
      host: remote.host,
      user: remote.user,
      port: remote.port ?? 22,
      path: remote.path ?? "~",
    }))
    .digest("hex");
}

function remoteSessionCacheKey(remote: RemoteOpts, remoteCwd: string): string {
  return `${stableRemoteKey(remote)}::sessions::${remoteCwd}`;
}

function remoteFileTreeCacheKey(remote: RemoteOpts, dirPath: string): string {
  return `${stableRemoteKey(remote)}::tree::${dirPath}`;
}

function getCachedRemoteSessions(key: string): RemoteSessionCacheEntry | null {
  const hit = remoteSessionCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    remoteSessionCache.delete(key);
    return null;
  }
  return hit;
}

function setCachedRemoteSessions(
  key: string,
  sessions: SessionEntry[],
  hydrating = false,
  hydratedCount = 0,
  hydrationPaused = false,
  priority = 0,
  lastRequestedAt = Date.now(),
): SessionEntry[] {
  remoteSessionCache.set(key, {
    expiresAt: Date.now() + REMOTE_SESSION_CACHE_TTL_MS,
    sessions,
    hydrating,
    hydratedCount,
    hydrationPaused,
    priority,
    lastRequestedAt,
  });
  return sessions;
}

function getCachedRemoteFileTree(key: string): RemoteFileNode[] | null {
  const hit = remoteFileTreeCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    remoteFileTreeCache.delete(key);
    return null;
  }
  return hit.nodes;
}

function setCachedRemoteFileTree(key: string, nodes: RemoteFileNode[]): RemoteFileNode[] {
  remoteFileTreeCache.set(key, { expiresAt: Date.now() + REMOTE_FILE_TREE_CACHE_TTL_MS, nodes });
  return nodes;
}

function invalidateRemoteCaches(remote: RemoteOpts): void {
  const prefix = stableRemoteKey(remote);
  for (const key of [...remoteSessionCache.keys()]) {
    if (key.startsWith(prefix)) remoteSessionCache.delete(key);
  }
  for (const key of [...remoteFileTreeCache.keys()]) {
    if (key.startsWith(prefix)) remoteFileTreeCache.delete(key);
  }
}

/** Drop only the file-tree cache entries for a remote (keeps session cache). */
function invalidateRemoteFileTree(remote: RemoteOpts): void {
  const prefix = stableRemoteKey(remote) + "::tree::";
  for (const key of [...remoteFileTreeCache.keys()]) {
    if (key.startsWith(prefix)) remoteFileTreeCache.delete(key);
  }
}

/** Drop the file-tree cache entries for a WSL distro. */
function invalidateWslFileTree(distro: string): void {
  const prefix = `wsl:${distro}:`;
  for (const key of [...remoteFileTreeCache.keys()]) {
    if (key.startsWith(prefix)) remoteFileTreeCache.delete(key);
  }
}

function setRemoteSessionHydrationPaused(key: string, paused: boolean): void {
  const hit = remoteSessionCache.get(key);
  if (!hit) return;
  hit.hydrationPaused = paused;
}

function markRemoteSessionPriority(key: string, priority: number): void {
  const now = Date.now();
  for (const [cacheKey, entry] of remoteSessionCache.entries()) {
    if (cacheKey === key) {
      entry.priority = priority;
      entry.lastRequestedAt = now;
      entry.hydrationPaused = false;
    } else if (entry.priority > priority) {
      entry.priority = priority;
    }
  }
}

async function destroySftpLease(lease: SftpLease): Promise<void> {
  if (lease.idleTimer) {
    clearTimeout(lease.idleTimer);
    lease.idleTimer = null;
  }
  sftpLeases.delete(lease.key);
  try {
    await lease.client.end();
  } catch {
    /* ignore */
  }
}

function scheduleSftpLeaseCleanup(lease: SftpLease): void {
  if (lease.idleTimer) clearTimeout(lease.idleTimer);
  lease.idleTimer = setTimeout(() => {
    if (lease.refCount > 0) return;
    void destroySftpLease(lease);
  }, SFTP_IDLE_TTL_MS);
}

async function getSftpLease(remote: RemoteOpts): Promise<SftpLease> {
  const key = stableRemoteKey(remote);
  const existing = sftpLeases.get(key);
  if (existing) {
    if (existing.connectPromise) return existing.connectPromise;
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    return existing;
  }

  const lease: SftpLease = {
    key,
    client: new SftpClient(),
    homeDir: "~",
    lastUsedAt: Date.now(),
    refCount: 0,
    idleTimer: null,
    connectPromise: null,
  };
  sftpLeases.set(key, lease);
  lease.connectPromise = (async () => {
    try {
      await lease.client.connect({
        host: remote.host,
        port: remote.port ?? 22,
        username: remote.user,
        password: remote.password,
        readyTimeout: 15000,
      });
      lease.homeDir = await lease.client.realPath(".");
      lease.lastUsedAt = Date.now();
      lease.connectPromise = null;
      return lease;
    } catch (error) {
      sftpLeases.delete(key);
      try { await lease.client.end(); } catch { /* ignore */ }
      throw error;
    }
  })();
  return lease.connectPromise;
}

// --- WSL path helpers --------------------------------------------------------

/** Convert a Linux path inside a WSL distro to a Windows UNC path.
 *  NOTE: callers must pre-resolve `~` (via resolveWslPath / getWslHome) before
 *  calling this; the `~` special-casing below is a defensive fallback only. */
function wslToWinPath(distro: string, linuxPath: string): string {
  // Normalize: strip trailing slash, handle ~ prefix
  let p = linuxPath.trim();
  if (p === "~") p = "/home";
  else if (p.startsWith("~/")) p = "/home/" + p.slice(2);
  // Build UNC path: \\wsl$\<distro>\<linux_path>
  const parts = p.replace(/\//g, "\\").replace(/^\\/, "");
  return `\\\\wsl$\\${distro}\\${parts}`.replace(/\\+$/, "");
}

/** Get the WSL user's home directory via `wsl.exe`. Cached per distro — but
 *  only successful results are cached, so a cold-start timeout/failure is
 *  retried on the next call instead of poisoning the session with a wrong
 *  fallback home. */
const wslHomeCache = new Map<string, string>();
function getWslHome(distro: string): string {
  const cached = wslHomeCache.get(distro);
  if (cached) return cached;
  const { spawnSync } = require("node:child_process");
  const result = spawnSync("wsl.exe", ["-d", distro, "--", "bash", "-c", "echo $HOME"], {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout: 5000,
  });
  const home = (result.stdout ?? "").trim();
  if (home) {
    wslHomeCache.set(distro, home);
    return home;
  }
  // Fallback that is NOT cached — next call retries wsl.exe.
  return `/home/${distro.split("-")[0].toLowerCase()}`;
}

/** Resolve a WSL path that may start with ~ to an absolute Linux path. */
function resolveWslPath(distro: string, linuxPath: string): string {
  let p = linuxPath.trim();
  if (p === "~" || p === "") return getWslHome(distro);
  if (p.startsWith("~/")) return getWslHome(distro) + "/" + p.slice(2);
  return p;
}

// --- WSL session scan (direct \\\\wsl$ UNC filesystem reads) ---
// WSL sessions are plain files on the local disk, so the 4s title poll can
// read them directly — the WSL counterpart of the SSH poll (SFTP) and the
// local fs.watch title sync in pty.ts. Snapshot-based incremental parsing
// mirrors pollLocalSessionsOnce: only files whose (mtime, size) changed are
// re-read, so the poll never re-parses a whole session dir every 4s.
const wslSessionSnapshots = new Map<string, Array<{ path: string; mtime: number; size: number }>>();
const wslSessionLists = new Map<string, SessionEntry[]>();

async function wslScanSessionDir(
  distro: string,
  linuxCwd: string,
  incremental: boolean,
): Promise<{ sessions: SessionEntry[]; changed: boolean }> {
  const resolved = resolveWslPath(distro, linuxCwd);
  const winHome = wslToWinPath(distro, getWslHome(distro));
  const encoded = encodeCwd(resolved);
  const sessionDir = join(winHome, ".pi", "agent", "sessions", encoded);
  const snapKey = `wsl:${distro}:${sessionDir}`;
  const { readdir, readFile, stat } = await import("node:fs/promises");
  let snap: Array<{ path: string; mtime: number; size: number }>;
  try {
    if (!existsSync(sessionDir)) return { sessions: [], changed: false };
    snap = (await readdir(sessionDir))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const full = join(sessionDir, f);
        const st = statSync(full);
        return { path: full, mtime: st.mtimeMs, size: st.size };
      });
  } catch {
    return { sessions: [], changed: false };
  }
  snap.sort((a, b) => b.mtime - a.mtime);

  if (!incremental) {
    // One-shot full scan (sidebar expand): read + parse every file.
    const entries: SessionEntry[] = [];
    for (const f of snap) {
      try {
        const [st, content] = await Promise.all([stat(f.path), readFile(f.path, "utf8")]);
        const e = parseSessionText(content, f.path, { mtime: st.mtimeMs, size: st.size });
        if (e) entries.push(e);
      } catch {
        // skip unreadable files
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    return { sessions: entries, changed: true };
  }

  // Incremental: reuse cached entries for unchanged files.
  const prev = wslSessionSnapshots.get(snapKey);
  wslSessionSnapshots.set(snapKey, snap);
  const sameWslSnapshot = (a: Array<{ path: string; mtime: number; size: number }>, b: Array<{ path: string; mtime: number; size: number }>): boolean => {
    if (a.length !== b.length) return false;
    const byPath = new Map(b.map((s) => [s.path, s]));
    return a.every((s) => {
      const o = byPath.get(s.path);
      return !!o && o.mtime === s.mtime && o.size === s.size;
    });
  };
  if (prev && sameWslSnapshot(prev, snap)) {
    return { sessions: wslSessionLists.get(snapKey) ?? [], changed: false };
  }
  // Only a change in the FILE SET (new/deleted sessions) counts as a change
  // for the renderer; mtime drift on an actively-written session is routine.
  const prevPaths = new Set((prev ?? []).map((x) => x.path));
  const curPaths = new Set(snap.map((x) => x.path));
  const pathSetChanged = prevPaths.size !== curPaths.size || [...prevPaths].some((p) => !curPaths.has(p));
  const prevSessions = new Map((wslSessionLists.get(snapKey) ?? []).map((s) => [s.path, s]));
  const next: SessionEntry[] = [];
  for (const f of snap) {
    const oldSnap = prev?.find((x) => x.path === f.path);
    const cached = prevSessions.get(f.path);
    if (oldSnap && cached && oldSnap.mtime === f.mtime && oldSnap.size === f.size) {
      next.push(cached);
      continue;
    }
    try {
      const [st, content] = await Promise.all([stat(f.path), readFile(f.path, "utf8")]);
      const parsed = parseSessionText(content, f.path, { mtime: st.mtimeMs, size: st.size });
      next.push(parsed ?? cached ?? { path: f.path, sessionId: "", mtime: f.mtime, size: f.size, messageCount: 0, firstMessage: "", name: null });
    } catch {
      next.push(cached ?? { path: f.path, sessionId: "", mtime: f.mtime, size: f.size, messageCount: 0, firstMessage: "", name: null });
    }
  }
  wslSessionLists.set(snapKey, next);
  return { sessions: next, changed: pathSetChanged };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "pipi",
    // 用户提供的 图标.png 作为窗口图标（覆盖旧的 icon.ico/icon.png）。
    // 图标来自 图标1.png（scripts/make-icon.mjs 生成）：Windows 用多尺寸
    // ico（16-256px，任务栏/标题栏/大图标模式都清晰），其他平台用 256px png。
    icon: join(__dirname, `../../resources/icon.${process.platform === "win32" ? "ico" : "png"}`),
    width: 1280,
    height: 820,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Prevent renderer throttling when window is idle.
  // Without this, xterm.js timers drop to ~1 Hz after inactivity, freezing scroll.
  mainWindow.webContents.setBackgroundThrottling(false);
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// --- Active-tab tracking: the sidebar follows the active tab's cwd. ----
function emitTabs() {
  // listTabs() includes RPC-backed tabs in the shared registry — exclude
  // them here; listRpcSessions() emits them with mode "rpc". Otherwise the
  // renderer gets the same tab twice (pty + rpc) and renders BOTH panes.
  const ptyTabs = listTabs().filter((t) => t.pty).map((t) => ({
    id: t.id,
    cwd: t.cwd,
    sessionPath: t.sessionPath,
    title: t.title,
    isRemote: !!(t.remote || t.wsl),
    remoteKey: t.remoteKey,
    remoteHost: t.remote?.host,
    remoteUser: t.remote?.user,
    remotePort: t.remote?.port ?? 22,
    // Local tabs always run pi; remote tabs do unless startPi:false.
    pi: t.remote ? t.remote.startPi !== false : true,
    isWsl: !!t.wsl,
    wslDistro: t.wsl?.distro,
    mode: "pty" as const,
  }));
  const rpcTabs = listRpcSessions().map((s) => {
    const t = getTab(s.id);
    return {
      id: s.id,
      cwd: t?.cwd ?? "",
      sessionPath: t?.sessionPath,
      title: t?.title ?? "",
      isRemote: !!(t?.remote || t?.wsl),
      remoteKey: t?.remoteKey,
      remoteHost: t?.remote?.host,
      remoteUser: t?.remote?.user,
      remotePort: t?.remote?.port ?? 22,
      isWsl: !!t?.wsl,
      wslDistro: t?.wsl?.distro,
      pi: true,
      mode: "rpc" as const,
    };
  });
  mainWindow?.webContents.send("tabs:update", [...ptyTabs, ...rpcTabs]);
}

// pty.ts watches local session files and bumps tab titles; keep the renderer
// in sync whenever that happens (also covers remote SFTP title sync below).
onTabsChanged(() => emitTabs());

function emitActive() {
  const t = getActiveTab();
  if (t) {
    const cwd = t.wsl ? (t.wsl.path || "~") : t.remote ? (t.remoteBrowsePath || t.remote.path || "~") : t.cwd;
    // Attach a warm cached session list for local tabs so the renderer can
    // skip the session:list round-trip entirely (see SessionIndex.cached).
    const sessions = t.remote || t.wsl ? undefined : sessionIndex.cached(cwd);
    mainWindow?.webContents.send("tabs:active", {
      id: t.id,
      cwd,
      isRemote: !!(t.remote || t.wsl),
      sessions: sessions ?? undefined,
    });
    if (t.remote || t.wsl) {
      stopWatching();
      stopLocalSessionsPoll();
    } else {
      startWatching(t.cwd);
      startLocalSessionsPoll(t.cwd);
    }
    return;
  }
  stopWatching();
  stopLocalSessionsPoll();
  mainWindow?.webContents.send("tabs:active", { id: null, cwd: "", isRemote: false });
}

// Windows 任务栏图标归属：没有 AppUserModelID 时 dev 模式的 electron.exe
// 会归到 Electron 组、图标显示为默认（用户反馈"图标小/不正常"）。
// 必须在 ready 之前设置。
if (process.platform === "win32") {
  app.setAppUserModelId("com.pipi.desktop");
}

app.whenReady().then(async () => {
  // Ship app-bundled pi extensions (static working indicator etc.) BEFORE any
  // tab can spawn pi, so every pi process auto-discovers them.
  ensureShippedExtensions();

  // Extension UI sub-protocol → forwarded to the renderer, which renders
  // select/confirm/input/editor as native dialogs (UiDialog in ChatPane) and
  // answers via tab:rpc-ui-response.
  setUiRequestHandler((tabId, req) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:rpc-ui-request:${tabId}`, req);
    }
  });

  // Renderer answers for extension UI dialogs (value/confirmed/cancelled).
  ipcMain.handle("tab:rpc-ui-response", (_e, tabId: string, response: Record<string, unknown>) => {
    return getRpcSession(tabId)?.send({ type: "extension_ui_response", ...response }) ?? false;
  });

  // Forward SessionIndex change events to the renderer (replaces the old
  // pollLocalSessionsOnce emit). Only emitted when a list actually changed.
  sessionIndex.onAnyChange((cwd, sessions) => {
    mainWindow?.webContents.send("session:local-updated", { cwd, sessions });
  });

  async function showAppMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  }

  async function ensurePiReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!hasNodeInstalled()) {
      await showAppMessageBox({
        type: "warning",
        title: "未检测到 Node.js",
        message: "使用 AI 终端前，需要先安装 Node.js 18 或更高版本。",
        buttons: ["确定"],
        defaultId: 0,
      });
      return { ok: false, reason: "node-missing" };
    }

    if (hasGlobalPiInstalled() || process.env.PI_CODING_AGENT === "true") {
      return { ok: true };
    }

    const piDiag = getPiDetectionDiagnostics();
    console.error("[pi-detect] failed", piDiag);

    const result = await showAppMessageBox({
      type: "question",
      title: "未检测到 pi agent",
      message: "使用 AI 终端前，需要先安装 pi agent。是否现在自动安装？",
      detail: `将执行：npm install -g --ignore-scripts @earendil-works/pi-coding-agent\n\n诊断信息：\npiBin=${piDiag.piBin}\nPI_CODING_AGENT=${piDiag.piEnv ?? ""}\nstatus=${piDiag.status ?? "null"}\nerror=${piDiag.error ?? ""}\nstdout=${piDiag.stdout.trim()}\nstderr=${piDiag.stderr.trim()}`,
      buttons: ["立即安装", "取消"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response !== 0) {
      return { ok: false, reason: "install-cancelled" };
    }

    const installing = await showAppMessageBox({
      type: "info",
      title: "正在安装",
      message: "正在安装 pi agent，请稍候。",
      buttons: ["确定"],
      defaultId: 0,
    });
    void installing;

    const install = await installGlobalPi();
    if (!install.ok) {
      await showAppMessageBox({
        type: "error",
        title: "安装失败",
        message: "自动安装 pi agent 失败。",
        detail: `请手动执行：npm install -g --ignore-scripts @earendil-works/pi-coding-agent\n\n${install.error}`,
        buttons: ["确定"],
        defaultId: 0,
      });
      return { ok: false, reason: "install-failed" };
    }

    await showAppMessageBox({
      type: "info",
      title: "安装成功",
      message: "pi agent 已安装完成，现在可以使用 AI 终端。",
      buttons: ["确定"],
      defaultId: 0,
    });
    // The detection caches were populated while pi was absent (bare-name
    // fallback, piOk=false). Drop them so the freshly installed binary is
    // picked up, then re-warm in the background.
    invalidatePiDetection();
    warmPiDetection();
    return { ok: true };
  }

  // --- Terminal / tabs ---
  ipcMain.handle("tab:create", async (_e, opts: { cwd: string; sessionPath?: string; continueRecent?: boolean; remote?: { host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean }; wsl?: { distro: string; path?: string }; themeMode?: ThemeMode }) => {
    if (!opts.remote && !opts.wsl) {
      const ready = await ensurePiReady();
      if (!ready.ok) {
        throw new Error(ready.reason);
      }
    }
    // Remote / WSL tabs always spawn from process.cwd(); also fix cwd if the
    // renderer accidentally passes a remote path (e.g. "/home/user").
    if (opts.remote || opts.wsl || opts.cwd.startsWith("/") || opts.cwd.startsWith("~")) {
      opts.cwd = process.cwd();
    }
    // Resolve WSL ~ paths to absolute Linux paths before spawning.
    if (opts.wsl) {
      opts.wsl = { ...opts.wsl, path: resolveWslPath(opts.wsl.distro, opts.wsl.path || "~") };
    }
    // Push the app-controlled themes to the remote BEFORE pi starts, so the
    // very first session already renders with the app's theme. Best-effort:
    // key-based connections without a password skip the sftp sync and the
    // remote simply keeps its own config. Re-sync at most every few minutes.
    if (opts.remote?.password) {
      const syncKey = stableRemoteKey(opts.remote);
      const lastSync = remoteThemeSyncAt.get(syncKey) ?? 0;
      if (Date.now() - lastSync > REMOTE_THEME_SYNC_TTL_MS) {
        try {
          const lease = await getSftpLease(opts.remote);
          const result: RemoteThemeSyncResult = await syncThemesViaSftp(lease.client, lease.homeDir);
          lease.lastUsedAt = Date.now();
          if (result.ok) {
            remoteThemeSyncAt.set(syncKey, Date.now());
            console.log(`[theme] remote synced ${result.uploaded.length} file(s) -> ${syncKey}`);
          } else {
            console.error(`[theme] remote sync partial/failed (${syncKey}):`, result.error ?? "unknown");
          }
        } catch (error) {
          console.error(`[theme] remote sync failed (${syncKey}):`, error);
        }
      }
    }
    // All pi tabs run headless RPC (ChatPane) — local, WSL, and remote;
    // only plain-shell connection tabs (startPi:false) keep the pty TUI.
    const id = opts.remote && opts.remote.startPi === false ? createTab(opts) : createRpcTab(opts);
    if (opts.remote) saveRemoteHistory(opts.remote);
    emitTabs();
    emitActive();
    return id;
  });
  // App-owned theme mode; the renderer reports its dark/light toggle so
  // every new pty (local + remote) renders with the app's choice.
  ipcMain.handle("theme:set-mode", (_e, mode: ThemeMode) => {
    setThemeMode(mode);
    return true;
  });
  ipcMain.handle("tab:close", async (_e, id: string) => {
    // RPC tabs are owned by rpc-session; pty tabs by pty.ts.
    const tab = getTab(id);
    const remote = tab?.remote;
    if (getRpcSession(id)) {
      closeRpcTab(id);
    } else {
      closeTab(id);
    }
    if (remote) {
      invalidateRemoteCaches(remote);
      const lease = sftpLeases.get(stableRemoteKey(remote));
      if (lease && lease.refCount === 0) await destroySftpLease(lease);
    }
    emitTabs();
    emitActive();
    return true;
  });
  ipcMain.handle("tab:activate", (_e, id: string) => {
    const ok = setActiveTab(id);
    if (ok) emitActive();
    return ok;
  });
  ipcMain.handle("tab:write", (_e, id: string, data: string) => writeTab(id, data));
  ipcMain.handle("tab:resize", (_e, id: string, cols: number, rows: number) => resizeTab(id, cols, rows));
  ipcMain.handle("tab:list", () => [
    ...listTabs().filter((t) => t.pty).map((t) => ({
      id: t.id, cwd: t.cwd, sessionPath: t.sessionPath, title: t.title,
      isRemote: !!(t.remote || t.wsl),
      isWsl: !!t.wsl,
      wslDistro: t.wsl?.distro,
      pi: t.remote ? t.remote.startPi !== false : true,
      mode: "pty" as const,
    })),
    ...listRpcSessions().map((s) => {
      const t = getTab(s.id);
      return {
        id: s.id,
        cwd: t?.cwd ?? "",
        sessionPath: t?.sessionPath,
        title: t?.title ?? "",
        isRemote: !!(t?.remote || t?.wsl),
        remoteKey: t?.remoteKey,
        remoteHost: t?.remote?.host,
        remoteUser: t?.remote?.user,
        remotePort: t?.remote?.port ?? 22,
        isWsl: !!t?.wsl,
        wslDistro: t?.wsl?.distro,
        pi: true,
        mode: "rpc" as const,
      };
    }),
  ]);

  // --- File tree + viewer (left/right panels) ---
  ipcMain.handle("file:list", async (_e, payload?: { tabId?: string; dirPath?: string; rootPath?: string; noCache?: boolean }) => {
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    const dirPath = payload?.dirPath;
    // rootPath = explicit LOCAL preview root (sidebar project click). It is
    // authoritative: never route it through a remote/WSL tab even if one is
    // active — previews browse the local filesystem, period.
    if (!payload?.rootPath) {
      if (t?.wsl) {
        const targetDir = dirPath ?? payload?.rootPath ?? t.wsl.path ?? "~";
        const resolved = resolveWslPath(t.wsl.distro, targetDir);
        const cacheKey = `wsl:${t.wsl.distro}:${resolved}`;
        const cached = getCachedRemoteFileTree(cacheKey);
        if (cached) return cached;
        return setCachedRemoteFileTree(cacheKey, await wslListFiles(t.wsl.distro, resolved));
      }
      if (t?.remote) {
        const targetDir = dirPath ?? payload?.rootPath ?? t.remoteBrowsePath ?? t.remote.path ?? "~";
        const cacheKey = remoteFileTreeCacheKey(t.remote, targetDir);
        const cached = getCachedRemoteFileTree(cacheKey);
        if (cached) return cached;
        return setCachedRemoteFileTree(cacheKey, await remoteListFiles(t.remote, targetDir));
      }
    }
    // No resolvable root (no tab / no explicit root): return an empty tree
    // instead of silently falling back to the app's own directory — that
    // fallback made the tree show the software's files under a wrong header.
    const root = payload?.rootPath ?? dirPath ?? t?.cwd;
    if (!root) return [];
    // noCache = force-fresh listing (auto-follow tree sync): pi writes do NOT
    // go through our mutation handlers, so the TTL cache would hide files pi
    // just created. Click-path listings (tab switch / preview) stay cached.
    // Local-only by construction: the renderer skips auto-follow tree
    // refreshes for remote/WSL/preview origins, so the flag never fires here
    // for those (their 5s TTL adapters keep serving as before).
    if (payload?.noCache) return fileTreeIndex.refresh(root);
    const cachedTree = fileTreeIndex.cached(root);
    if (cachedTree) return cachedTree;
    return fileTreeIndex.refresh(root);
  });
  ipcMain.handle("file:resolve-link", (_e, payload: { tabId?: string; rootPath?: string; currentPath?: string; href: string }) => {
    const rawHref = (payload.href || "").trim();
    if (!rawHref) return { ok: false as const };
    if (/^(https?|mailto):/i.test(rawHref)) return { ok: false as const };
    const cleanHref = rawHref.replace(/[?#].*$/, "");
    let decoded = cleanHref;
    try {
      decoded = decodeURIComponent(cleanHref);
    } catch {
      /* keep raw */
    }
    if (/^file:/i.test(decoded)) {
      try {
        decoded = new URL(decoded).pathname;
        if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
      } catch {
        return { ok: false as const };
      }
    }
    const currentDir = payload.currentPath ? posixPath.dirname(payload.currentPath.replace(/\\/g, "/")) : ".";
    const t = payload.tabId ? getTab(payload.tabId) : getActiveTab();
    /** Shared path normalization for link targets: `~/` expands to home
     *  (resolved later by the read handlers), absolute paths stay absolute,
     *  relative paths join the current file's dir; `..` traversal is
     *  rejected for all targets so a bad link degrades to a dead click
     *  instead of an error pane. */
    function resolveLinkPath(target: string, allowTilde: boolean): string | null {
      let p = target.replace(/\\/g, "/");
      if (allowTilde && p.startsWith("~/")) {
        p = `~/${p.slice(2)}`;
      } else if (p.startsWith("/")) {
        p = posixPath.normalize(p);
      } else {
        p = posixPath.normalize(posixPath.join(currentDir, p));
      }
      if (!p || p === "." || p.split("/").includes("..")) return null;
      return p;
    }
    if (!payload.rootPath) {
      if (t?.remote) {
        const relPath = resolveLinkPath(decoded, true);
        if (!relPath) return { ok: false as const };
        return { ok: true as const, relPath, tabId: t.id };
      }
      if (t?.wsl) {
        const relPath = resolveLinkPath(decoded, true);
        if (!relPath) return { ok: false as const };
        return { ok: true as const, relPath, tabId: t.id };
      }
    }
    const root = payload.rootPath ?? t?.cwd;
    if (!root) return { ok: false as const };
    let relPath: string;
    if (isAbsolute(decoded) || /^[A-Za-z]:[\\/]/.test(decoded)) {
      const fromRoot = relative(root, decoded).split(sep).join("/");
      if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return { ok: false as const };
      relPath = fromRoot;
    } else {
      const joined = resolveLinkPath(decoded, false);
      if (!joined) return { ok: false as const };
      relPath = joined;
    }
    return { ok: true as const, relPath, tabId: payload.rootPath ? undefined : t?.id, rootPath: payload.rootPath };
  });

  ipcMain.handle("file:read", async (_e, payload: { tabId?: string; rootPath?: string; relPath: string }) => {
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    const relPath = payload.relPath;
    // Local preview root is authoritative (see file:list).
    if (!payload.rootPath) {
      if (t?.wsl) {
        const fullPath = wslFullPath(t, relPath);
        try {
          const buf = await readFile(fullPath);
          const isBin = buf.subarray(0, Math.min(8192, buf.length)).includes(0);
          return {
            content: isBin ? "[二进制文件]" : buf.toString("utf8"),
            bytes: buf.length,
            isBinary: isBin,
          };
        } catch (err) {
          return { content: `⚠️ 读取失败: ${err instanceof Error ? err.message : String(err)}`, bytes: 0, isBinary: false, error: String(err) };
        }
      }
      if (t?.remote) {
        return remoteReadFile(t.remote, relPath, t.remoteBrowsePath ?? t.remote.path ?? "~");
      }
    }
    return readFileContent(payload.rootPath ?? t?.cwd ?? process.cwd(), relPath).catch((err) => ({
      content: `⚠️ 读取失败: ${err instanceof Error ? err.message : String(err)}`,
      bytes: 0,
      isBinary: false,
      error: String(err),
    }));
  });

  // --- File mutations (write / mkdir / delete / rename) — local / WSL / SFTP ---
  type FileMutationResult = { ok: true } | { ok: false; error: string };

  function validateRel(relPath: string): string | null {
    if (!relPath) return "路径不能为空";
    // Reject traversal on BOTH separators: WSL paths are converted to Windows
    // (\\wsl$\...) where backslash-encoded .. would escape the browse dir
    // onto the host filesystem (\mnt\c).
    if (relPath.split(/[\\/]/).includes("..")) return "路径不能包含 ..";
    if (relPath.startsWith("\\\\")) return "路径不能以 \\ 开头";
    return null;
  }

  function remoteFullPath(relPath: string, baseDir: string, homeDir: string): string {
    const base = resolveRemotePath(baseDir, homeDir);
    const full = relPath.startsWith("/")
      ? posixPath.normalize(relPath)
      : resolveRemotePath(posixPath.join(baseDir, relPath), homeDir);
    // Mutations stay inside the browse dir (tree paths are children of it;
    // the synthetic ".." entry would otherwise be deletable/renamable).
    if (full !== base && !full.startsWith(base === "/" ? "/" : base + "/")) {
      throw new Error(`路径越界: ${relPath}`);
    }
    return full;
  }

  function wslBaseDirFor(t: TabInfo): string {
    return resolveWslPath(t.wsl!.distro, t.wsl!.path || "~");
  }

  function wslFullPath(t: TabInfo, relPath: string): string {
    const distro = t.wsl!.distro;
    const baseWin = wslToWinPath(distro, wslBaseDirFor(t));
    const rawWin = relPath.startsWith("/")
      ? wslToWinPath(distro, relPath)
      : `${baseWin}\\${relPath.replace(/\//g, "\\")}`;
    const win = win32Path.normalize(rawWin);
    const baseNorm = win32Path.normalize(baseWin);
    if (win !== baseNorm && !win.startsWith(baseNorm + "\\")) {
      throw new Error(`路径越界: ${relPath}`);
    }
    return win;
  }

  async function remoteWrite(client: SftpClient, full: string, content: string): Promise<void> {
    await client.mkdir(posixPath.dirname(full), true);
    // put() treats a string as a LOCAL file path → must pass a Buffer for raw content.
    await client.put(Buffer.from(content, "utf8"), full);
  }

  async function remoteDelete(client: SftpClient, full: string): Promise<void> {
    const kind = await client.exists(full);
    if (!kind) throw new Error(`路径不存在: ${full}`);
    if (kind === "d") await client.rmdir(full, true);
    else await client.delete(full);
  }

  async function remoteRename(client: SftpClient, full: string, newName: string): Promise<void> {
    if (!isValidName(newName)) throw new Error("名称不合法（不能包含 / 或 \\）");
    const target = `${posixPath.dirname(full)}/${newName}`;
    if (target !== full && (await client.exists(target))) {
      throw new Error(`目标已存在: ${newName}`);
    }
    if (target === full) return; // same name → no-op
    await client.rename(full, target);
  }

  function wslWrite(t: TabInfo, relPath: string, content: string): Promise<void> {
    const win = wslFullPath(t, relPath);
    const dir = win.substring(0, win.lastIndexOf("\\"));
    return mkdir(dir, { recursive: true }).then(() => writeFile(win, content, "utf8"));
  }

  async function wslDelete(t: TabInfo, relPath: string): Promise<void> {
    const win = wslFullPath(t, relPath);
    try {
      await access(win);
    } catch {
      throw new Error(`路径不存在: ${relPath}`);
    }
    await rm(win, { recursive: true, force: false });
  }

  async function wslRename(t: TabInfo, relPath: string, newName: string): Promise<void> {
    if (!isValidName(newName)) throw new Error("名称不合法（不能包含 / 或 \\）");
    const win = wslFullPath(t, relPath);
    const target = `${win.substring(0, win.lastIndexOf("\\"))}\\${newName}`;
    if (target !== win) {
      let exists = false;
      try {
        await access(target);
        exists = true;
      } catch {
        /* target free */
      }
      if (exists) throw new Error(`目标已存在: ${newName}`);
    }
    if (target === win) return; // same name → no-op
    await rename(win, target);
  }

  /** Shared dispatch for the four mutation handlers. */
  async function mutateFile(
    tabId: string | undefined,
    relPath: string,
    fn: (t: TabInfo) => Promise<void> | void
  ): Promise<FileMutationResult> {
    const bad = validateRel(relPath);
    if (bad) return { ok: false, error: bad };
    const t = tabId ? getTab(tabId) : getActiveTab();
    if (!t) return { ok: false, error: "找不到终端会话" };
    try {
      await fn(t);
      if (t.remote) invalidateRemoteFileTree(t.remote);
      else if (t.wsl) invalidateWslFileTree(t.wsl.distro);
      else fileTreeIndex.invalidate(t.cwd ?? process.cwd());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Local mutations in preview mode resolve against rootPath, not the tab cwd. */

  ipcMain.handle("file:write", async (_e, payload: { tabId?: string; rootPath?: string; relPath: string; content: string }) => {
    const relPath = payload.relPath;
    const content = payload.content ?? "";
    // Local preview root is authoritative; needs no tab at all.
    if (payload.rootPath) {
      const r = await writeFileContent(payload.rootPath, relPath, content);
      if (r.ok) fileTreeIndex.invalidate(payload.rootPath);
      return r;
    }
    return mutateFile(payload.tabId, relPath, async (t) => {
      if (t.wsl) {
        await wslWrite(t, relPath, content);
      } else if (t.remote) {
        await withSftp(t.remote, async (client, homeDir) => {
          await remoteWrite(client, remoteFullPath(relPath, t.remoteBrowsePath ?? t.remote!.path ?? "~", homeDir), content);
        });
      } else {
        const r = await writeFileContent(t.cwd ?? process.cwd(), relPath, content);
        if (!r.ok) throw new Error(r.error);
      }
    });
  });

  ipcMain.handle("file:mkdir", async (_e, payload: { tabId?: string; rootPath?: string; relPath: string }) => {
    const relPath = payload.relPath;
    if (payload.rootPath) {
      const r = await createDirectory(payload.rootPath, relPath);
      if (r.ok) fileTreeIndex.invalidate(payload.rootPath);
      return r;
    }
    return mutateFile(payload.tabId, relPath, async (t) => {
      if (t.wsl) {
        await mkdir(wslFullPath(t, relPath), { recursive: true });
      } else if (t.remote) {
        await withSftp(t.remote, async (client, homeDir) => {
          await client.mkdir(remoteFullPath(relPath, t.remoteBrowsePath ?? t.remote!.path ?? "~", homeDir), true);
        });
      } else {
        const r = await createDirectory(t.cwd ?? process.cwd(), relPath);
        if (!r.ok) throw new Error(r.error);
      }
    });
  });

  ipcMain.handle("file:delete", async (_e, payload: { tabId?: string; rootPath?: string; relPath: string }) => {
    const relPath = payload.relPath;
    if (payload.rootPath) {
      const r = await deletePath(payload.rootPath, relPath);
      if (r.ok) fileTreeIndex.invalidate(payload.rootPath);
      return r;
    }
    return mutateFile(payload.tabId, relPath, async (t) => {
      if (t.wsl) {
        await wslDelete(t, relPath);
      } else if (t.remote) {
        await withSftp(t.remote, async (client, homeDir) => {
          await remoteDelete(client, remoteFullPath(relPath, t.remoteBrowsePath ?? t.remote!.path ?? "~", homeDir));
        });
      } else {
        const r = await deletePath(t.cwd ?? process.cwd(), relPath);
        if (!r.ok) throw new Error(r.error);
      }
    });
  });

  ipcMain.handle("file:rename", async (_e, payload: { tabId?: string; rootPath?: string; relPath: string; newName: string }) => {
    const relPath = payload.relPath;
    const newName = (payload.newName ?? "").trim();
    if (payload.rootPath) {
      const r = await renamePath(payload.rootPath, relPath, newName);
      if (r.ok) fileTreeIndex.invalidate(payload.rootPath);
      return r;
    }
    return mutateFile(payload.tabId, relPath, async (t) => {
      if (t.wsl) {
        await wslRename(t, relPath, newName);
      } else if (t.remote) {
        await withSftp(t.remote, async (client, homeDir) => {
          await remoteRename(client, remoteFullPath(relPath, t.remoteBrowsePath ?? t.remote!.path ?? "~", homeDir), newName);
        });
      } else {
        const r = await renamePath(t.cwd ?? process.cwd(), relPath, newName);
        if (!r.ok) throw new Error(r.error);
      }
    });
  });

  ipcMain.handle("remote:set-browse-path", (_e, tabId: string, path: string) => {
    const t = getTab(tabId);
    if (t?.wsl) {
      t.wsl.path = resolveWslPath(t.wsl.distro, path);
      if (getActiveTab()?.id === tabId) emitActive();
      return true;
    }
    const ok = setRemoteBrowsePath(tabId, path);
    if (ok && getActiveTab()?.id === tabId) emitActive();
    return ok;
  });
  ipcMain.handle("remote:get-browse-path", (_e, tabId: string) => {
    const t = getTab(tabId);
    return t?.wsl ? (t.wsl.path || "~") : getRemoteBrowsePath(tabId);
  });
  ipcMain.handle("remote:get-info", (_e, tabId: string) => {
    const t = getTab(tabId);
    if (t?.wsl) {
      return {
        host: t.wsl.distro,
        user: "",
        port: 0,
        path: t.wsl.path ?? "~",
        isWsl: true,
      };
    }
    if (!t?.remote) return null;
    return {
      host: t.remote.host,
      user: t.remote.user,
      port: t.remote.port,
      path: t.remoteBrowsePath ?? t.remote.path ?? "~",
      password: t.remote.password,
      startPi: t.remote.startPi,
    };
  });

  ipcMain.handle("tab:alive", (_e, tabId: string) => !!getTab(tabId) || !!getRpcSession(tabId));

  // --- RPC chat (local pi tabs) ---
  ipcMain.handle("tab:rpc-send", (_e, tabId: string, cmd: Record<string, unknown>) => {
    const session = getRpcSession(tabId);
    return session ? session.send(cmd) : false;
  });
  ipcMain.handle("tab:rpc-switch-terminal", (_e, tabId: string) => {
    const ok = switchRpcToTerminal(tabId);
    if (ok) {
      emitTabs();
      emitActive();
    }
    return ok;
  });
  ipcMain.handle("tab:rpc-switch-chat", (_e, tabId: string) => {
    const ok = switchTerminalToRpc(tabId);
    if (ok) {
      emitTabs();
      emitActive();
    }
    return ok;
  });

  // --- File changes (git diff over local/wsl/remote channels) ---
  ipcMain.handle("diff:list", (_e, tabId: string) => listFileChanges(tabId));
  ipcMain.handle("diff:get", (_e, tabId: string, path: string) => getFileDiff(tabId, path));
  ipcMain.handle("diff:history", (_e, tabId: string, path: string, events: unknown) =>
    getFileHistory(tabId, path, (events ?? []) as FileVersionEvent[]),
  );
  ipcMain.handle("diff:compare", (_e, a: string, b: string, path: string) => ({ diff: diffTextOf(a, b, path) }));
  ipcMain.handle("diff:write", (_e, tabId: string, path: string, content: string) => rollbackFileContent(tabId, path, content));
  ipcMain.handle("diff:commits", (_e, tabId: string, path: string) => listGitCommits(tabId, path));
  ipcMain.handle("diff:at", (_e, tabId: string, path: string, rev?: string) => getFileAt(tabId, path, rev));

  // --- pi / extension updates (RPC chat has no TUI update banner) ---
  ipcMain.handle("update:check", (_e, force?: boolean) => checkPiUpdate(force));
  ipcMain.handle("update:run", () => runPiUpdate());

  // --- WSL distro list ---
  ipcMain.handle("wsl:list-distros", () => listWslDistros());

  // --- Project list ---
  ipcMain.handle("project:list", () => listProjects());
  ipcMain.handle("project:add-local", (_e, cwd: string) => addLocalProject(cwd));
  ipcMain.handle("project:add-remote", (_e, remote: { host: string; user: string; port?: number; path: string; password?: string }) => addRemoteProject(remote));
  ipcMain.handle("project:add-wsl", (_e, distro: string, path: string) => addWslProject(distro, path));
  ipcMain.handle("project:delete", (_e, id: string) => deleteProject(id));
  ipcMain.handle("model:list", () => listModels());
  ipcMain.handle("model:add", async (_e, input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }) => {
    const specIds = [input.model, ...(input.availableModels ?? [])].map((s) => s.trim()).filter(Boolean);
    const overrides = await lookupModelSpecs(specIds);
    const saved = addModel(input);
    syncModelToPi(saved, overrides);
    return saved;
  });
  ipcMain.handle("model:update", async (_e, id: string, input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }) => {
    const specIds = [input.model, ...(input.availableModels ?? [])].map((s) => s.trim()).filter(Boolean);
    const overrides = await lookupModelSpecs(specIds);
    const saved = updateModel(id, input);
    syncModelToPi(saved, overrides);
    return saved;
  });
  ipcMain.handle("model:lookup-specs", async (_e, ids: string[]) => lookupModelSpecs(Array.isArray(ids) ? ids : []));
  ipcMain.handle("model:delete", (_e, id: string) => deleteModel(id));
  ipcMain.handle("model:check-sync", (_e, input: { provider: string; model: string }) => checkPiModelSync(input.provider, input.model));
  // --- Remote model configuration (SFTP write + SSH exec) ---
  function remoteModelsFilePath(homeDir: string): string {
    return posixPath.join(homeDir, ".pi", "agent", "models.json");
  }

  function remoteAuthFilePath(homeDir: string): string {
    return posixPath.join(homeDir, ".pi", "agent", "auth.json");
  }

  async function readRemoteJson(client: SftpClient, path: string): Promise<Record<string, unknown> | null> {
    try {
      const buf = (await client.get(path)) as Buffer;
      const parsed = JSON.parse(buf.toString("utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function writeRemoteJson(client: SftpClient, path: string, obj: unknown): Promise<void> {
    const dir = posixPath.dirname(path);
    try {
      await client.mkdir(dir, true);
    } catch {
      /* dir may already exist */
    }
    await client.put(Buffer.from(JSON.stringify(obj, null, 2), "utf8"), path);
  }

  function sshExec(remote: RemoteOpts, command: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const conn = new SshClient();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        conn.end();
        reject(new Error("SSH 执行超时"));
      }, timeoutMs);
      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
            return;
          }
          let stdout = "";
          let stderr = "";
          stream.on("data", (d: Buffer) => {
            stdout += d.toString("utf8");
          });
          stream.stderr.on("data", (d: Buffer) => {
            stderr += d.toString("utf8");
          });
          stream.on("close", (code?: unknown) => {
            conn.end();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ stdout, stderr, code: typeof code === "number" ? code : null });
            }
          });
        });
      });
      conn.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      conn.connect({
        host: remote.host,
        port: remote.port ?? 22,
        username: remote.user,
        password: remote.password,
        readyTimeout: 15000,
      });
    });
  }

  function parseRemoteModelList(text: string): string[] {
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      return [];
    }
    const obj = payload as { data?: unknown; models?: unknown } | null;
    const list = Array.isArray(obj?.data) ? obj.data : Array.isArray(obj?.models) ? obj.models : null;
    if (!list) return [];
    const ids = list
      .map((m) => {
        const entry = m as { id?: unknown } | string;
        return typeof entry === "string" ? entry : (entry?.id as string | undefined);
      })
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  ipcMain.handle("model:list-remote", async (_e, remote: RemoteOpts) => {
    try {
      return await withSftp(remote, async (client, homeDir) => {
        const obj = await readRemoteJson(client, remoteModelsFilePath(homeDir));
        const providers = (obj && typeof obj.providers === "object" && !Array.isArray(obj.providers) ? obj.providers : {}) as Record<string, { baseUrl?: string; apiKey?: string; api?: string; authHeader?: boolean; headers?: Record<string, string>; oauth?: string; compat?: Record<string, unknown>; models?: Array<Record<string, unknown> & { id?: string }> }>;
        return Object.entries(providers).map(([provider, cfg]) => ({
          id: `remote-${provider}`,
          name: provider,
          baseUrl: cfg?.baseUrl ?? "",
          model: cfg?.models?.[0]?.id ?? "",
          provider,
          apiKey: typeof cfg?.apiKey === "string" && cfg.apiKey.length > 0 && cfg.apiKey !== "placeholder" ? cfg.apiKey : undefined,
          providerConfig: {
            api: (cfg?.api as PiApi | undefined) ?? "openai-completions",
            headers: cfg?.headers,
            authHeader: cfg?.authHeader,
            oauth: cfg?.oauth,
            compat: cfg?.compat,
          },
          availableModels: (cfg?.models ?? []).map((m) => m?.id).filter((x): x is string => typeof x === "string"),
          modelSpecs: Object.fromEntries(
            (cfg?.models ?? [])
              .filter((m): m is Record<string, unknown> & { id?: string } => typeof m?.id === "string" && m.id.length > 0)
              .map((m) => { const { id: _id, ...rest } = m; return [m.id as string, rest as ModelEditorSpec]; }),
          ),
          createdAt: 0,
          updatedAt: 0,
        }));
      });
    } catch (error) {
      throw new Error(`读取远程模型配置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle("model:add-remote", async (_e, input: { remote: RemoteOpts; baseUrl: string; apiKey?: string; model: string; provider: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }) => {
    const providerId = input.provider.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!providerId) throw new Error("Provider 必填");
    if (!baseUrl) throw new Error("Base URL 必填");
    const modelIds = Array.from(new Set([input.model.trim(), ...(input.availableModels ?? [])].map((s) => s.trim()).filter(Boolean)));
    if (modelIds.length === 0) throw new Error("模型 ID 必填");
    const specIds = [input.model, ...(input.availableModels ?? [])].map((s) => s.trim()).filter(Boolean);
    const overrides = await lookupModelSpecs(specIds);
    return await withSftp(input.remote, async (client, homeDir) => {
      const modelsPath = remoteModelsFilePath(homeDir);
      const obj = (await readRemoteJson(client, modelsPath)) ?? {};
      const providers = (obj && typeof obj.providers === "object" && !Array.isArray(obj.providers) ? obj.providers : {}) as Record<string, unknown>;
      obj.providers = providers;
      // Preserve existing per-model fields on the remote side so an edit
      // never downgrades configured contextWindow/maxTokens; spec table
      // fills gaps for new/unknown models only.
      const prevProvider = (providers[providerId] ?? {}) as { models?: Array<Record<string, unknown> & { id?: string }> };
      const prevModels = Array.isArray(prevProvider.models) ? prevProvider.models : [];
      const models = modelIds.map((id) => {
        const prev = prevModels.find((m) => m?.id === id);
        const spec = specForModel(id);
        const manual = input.modelSpecs?.[id];
        return {
          ...prev,
          id,
          name: manual?.name ?? (prev?.name as string | undefined) ?? id,
          reasoning: manual?.reasoning ?? (prev?.reasoning as boolean | undefined) ?? /gpt-5|o1|o3|o4|deepseek-r|deepseek-v4|claude|gemini-2\.5/i.test(id),
          input: manual?.input ?? (prev?.input as Array<"text" | "image"> | undefined) ?? ["text"],
          contextWindow: manual?.contextWindow ?? (prev?.contextWindow as number | undefined) ?? overrides[id]?.contextWindow ?? spec.contextWindow,
          maxTokens: manual?.maxTokens ?? (prev?.maxTokens as number | undefined) ?? overrides[id]?.maxTokens ?? spec.maxTokens,
          cost: manual?.cost ?? (prev?.cost as Record<string, number> | undefined) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      });
      const prevProviderCfg = (providers[providerId] ?? {}) as Record<string, unknown>;
      providers[providerId] = {
        ...prevProviderCfg,
        baseUrl,
        api: input.providerConfig?.api ?? (prevProviderCfg.api as string | undefined) ?? "openai-completions",
        apiKey: input.apiKey?.trim() || "placeholder",
        authHeader: input.providerConfig?.authHeader ?? (prevProviderCfg.authHeader as boolean | undefined) ?? true,
        ...(input.providerConfig?.headers ? { headers: input.providerConfig.headers } : {}),
        ...(input.providerConfig?.oauth ? { oauth: input.providerConfig.oauth } : {}),
        ...(input.providerConfig?.compat ? { compat: input.providerConfig.compat } : {}),
        models,
      };
      await writeRemoteJson(client, modelsPath, obj);
      const trimmedKey = input.apiKey?.trim();
      if (trimmedKey && trimmedKey !== "placeholder") {
        const authPath = remoteAuthFilePath(homeDir);
        const auth = (await readRemoteJson(client, authPath)) ?? {};
        (auth as Record<string, unknown>)[providerId] = { type: "api_key", key: trimmedKey };
        await writeRemoteJson(client, authPath, auth);
      }
      return { ok: true, provider: providerId };
    });
  });

  ipcMain.handle("model:delete-remote", async (_e, input: { remote: RemoteOpts; provider: string }) => {
    const providerId = input.provider.trim();
    if (!providerId) return false;
    return await withSftp(input.remote, async (client, homeDir) => {
      const modelsPath = remoteModelsFilePath(homeDir);
      const obj = await readRemoteJson(client, modelsPath);
      if (obj && typeof obj.providers === "object" && !Array.isArray(obj.providers) && (obj.providers as Record<string, unknown>)[providerId] !== undefined) {
        const providers = obj.providers as Record<string, unknown>;
        delete providers[providerId];
        await writeRemoteJson(client, modelsPath, obj);
      }
      const authPath = remoteAuthFilePath(homeDir);
      const auth = await readRemoteJson(client, authPath);
      if (auth && (auth as Record<string, unknown>)[providerId] !== undefined) {
        const authObj = auth as Record<string, unknown>;
        delete authObj[providerId];
        await writeRemoteJson(client, authPath, auth);
      }
      return true;
    });
  });

  ipcMain.handle("model:discover-remote", async (_e, input: { remote: RemoteOpts; baseUrl: string; apiKey?: string }) => {
    const base = input.baseUrl.trim().replace(/\/+$/, "");
    if (!base) throw new Error("Base URL 必填");
    const key = (input.apiKey ?? "").trim();
    const url = `${base}/models`;
    const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const authArg = key ? `-H ${sq(`Authorization: Bearer ${key}`)} ` : "";
    let lastError = "";
    const curlCmd = `curl -fsS --connect-timeout 10 ${authArg}${sq(url)}`;
    const curl = await sshExec(input.remote, curlCmd, 45000);
    if (curl.code === 0 && curl.stdout.trim()) {
      const models = parseRemoteModelList(curl.stdout);
      if (models.length > 0) return models;
    }
    lastError = curl.stderr.trim() || `curl exit ${curl.code}`;
    const pyCmd =
      `python3 -c 'import sys,json,urllib.request` +
      `\nreq=urllib.request.Request(sys.argv[1],headers={"Authorization":"Bearer "+sys.argv[2]} if sys.argv[2] else {})` +
      `\nprint(json.dumps(json.load(urllib.request.urlopen(req,timeout=10))))' ${sq(url)} ${sq(key)}`;
    const py = await sshExec(input.remote, pyCmd, 45000);
    if (py.code === 0 && py.stdout.trim()) {
      const models = parseRemoteModelList(py.stdout);
      if (models.length > 0) return models;
    }
    throw new Error(`远程检索失败: ${py.stderr.trim() || lastError}`);
  });

  ipcMain.handle("model:discover", async (_e, input: { baseUrl: string; apiKey?: string }) => {
    const normalizedBaseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    const target = `${normalizedBaseUrl}/models`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (input.apiKey?.trim()) headers.Authorization = `Bearer ${input.apiKey.trim()}`;
    const res = await fetch(target, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`模型检索失败 (${res.status})${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    const payload = await res.json() as RemoteModelListResponse;
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  });
  ipcMain.handle("remote:list-history", () => listRemoteHistory());

  // --- Model transplant: copy local pi models/auth to WSL or remote ---
  function readLocalPiConfigs(): { modelsPath: string; authPath: string } {
    const localPiDir = join(require("node:os").homedir(), ".pi", "agent");
    return {
      modelsPath: join(localPiDir, "models.json"),
      authPath: join(localPiDir, "auth.json"),
    };
  }

  ipcMain.handle("model:transplant-to-wsl", async (_e, distro: string) => {
    try {
      const home = getWslHome(distro);
      const winHome = wslToWinPath(distro, home);
      const piDir = join(winHome, ".pi", "agent");
      const { modelsPath, authPath } = readLocalPiConfigs();
      if (!existsSync(modelsPath) && !existsSync(authPath)) {
        return { ok: false, error: "本地没有 ~/.pi/agent/models.json 或 auth.json", copied: [] };
      }
      mkdirSync(piDir, { recursive: true });
      const copied: string[] = [];
      if (existsSync(modelsPath)) {
        writeFileSync(join(piDir, "models.json"), readFileSync(modelsPath));
        copied.push("models.json");
      }
      if (existsSync(authPath)) {
        writeFileSync(join(piDir, "auth.json"), readFileSync(authPath));
        copied.push("auth.json");
      }
      return { ok: true, copied };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), copied: [] };
    }
  });

  ipcMain.handle("model:transplant-to-remote", async (_e, remote: RemoteOpts) => {
    try {
      const { modelsPath, authPath } = readLocalPiConfigs();
      if (!existsSync(modelsPath) && !existsSync(authPath)) {
        return { ok: false, error: "本地没有 ~/.pi/agent/models.json 或 auth.json", copied: [] };
      }
      return await withSftp(remote, async (client, homeDir) => {
        const piDir = posixPath.join(homeDir, ".pi", "agent");
        const copied: string[] = [];
        try { await client.mkdir(piDir, true); } catch { /* ok */ }
        if (existsSync(modelsPath)) {
          await client.put(readFileSync(modelsPath), posixPath.join(piDir, "models.json"));
          copied.push("models.json");
        }
        if (existsSync(authPath)) {
          await client.put(readFileSync(authPath), posixPath.join(piDir, "auth.json"));
          copied.push("auth.json");
        }
        return { ok: true, copied };
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), copied: [] };
    }
  });

  // --- Session list (left sidebar, pure fs) ---
  ipcMain.handle("session:list", async (_e, cwd?: string) => {
    const t = getActiveTab();
    // Only take the WSL branch for Linux-style paths (explicit cwd or the
    // tab's own WSL path). A caller passing a local Windows path (e.g. local
    // project sessions) must NOT be routed into \\wsl$ translation.
    if (t?.wsl && (cwd === undefined || cwd.startsWith("/") || cwd.startsWith("~"))) {
      const linuxCwd = cwd ?? t.wsl.path ?? "~";
      try {
        const r = await wslScanSessionDir(t.wsl.distro, linuxCwd, false);
        return r.sessions;
      } catch {
        return [];
      }
    }
    const dir = cwd ?? t?.cwd ?? process.cwd();
    // Serve from the SessionIndex cache when fresh; otherwise parse async
    // (cooperative, snapshot-incremental) so the click path never blocks the
    // main-process event loop.
    const cached = sessionIndex.cached(dir);
    if (cached) return cached;
    return sessionIndex.refresh(dir);
  });
  ipcMain.handle("session:list-projects", () => listLocalProjects());
  ipcMain.handle("session:set-remote-hydration-paused", (_e, tabId: string, remoteCwd: string, paused: boolean) => {
    const t = getTab(tabId);
    if (!t?.remote) return false;
    setRemoteSessionHydrationPaused(remoteSessionCacheKey(t.remote, remoteCwd), paused);
    return true;
  });
  ipcMain.handle("session:prioritize-remote", (_e, tabId: string, remoteCwd: string, priority = 2) => {
    const t = getTab(tabId);
    if (!t?.remote) return false;
    markRemoteSessionPriority(remoteSessionCacheKey(t.remote, remoteCwd), priority);
    void scheduleRemoteHydrationWork();
    return true;
  });
  ipcMain.handle("session:list-remote", async (_e, tabId: string, remoteCwd?: string) => {
    const t = getTab(tabId);
    if (!t?.remote && !t?.wsl) return { sessions: [], error: "远程标签页不存在或已断开" };
    const targetDir = remoteCwd ?? t.remoteBrowsePath ?? t.remote?.path ?? t.wsl?.path ?? "~";
    if (t?.wsl) {
      // WSL sessions are plain files under \\\\wsl$\\<distro>\\home\\<user>\\.pi\\agent\\sessions\\…
      try {
        const r = await wslScanSessionDir(t.wsl.distro, targetDir, false);
        return { sessions: r.sessions, diagnostics: undefined };
      } catch (e) {
        return { sessions: [], error: e instanceof Error ? e.message : String(e) };
      }
    }
    const remote = t.remote as RemoteOpts;
    const cacheKey = remoteSessionCacheKey(remote, targetDir);
    // Capture the entry BEFORE getCachedRemoteSessions (which deletes it on
    // expiry) so hydrated fields survive a re-list instead of resetting the
    // sidebar to "0 条" while re-hydration runs.
    const previous = remoteSessionCache.get(cacheKey);
    const cached = getCachedRemoteSessions(cacheKey);
    if (cached) {
      markRemoteSessionPriority(cacheKey, 2);
      if (!cached.hydrating) {
        void scheduleRemoteHydrationWork();
      }
      // Soft diagnostics: a missing session dir is routine and must not tear
      // down the shared SFTP lease (that would kill in-flight file ops).
      const diagnostics = await remoteSessionDiagnosticsSoft(remote, targetDir);
      return { sessions: cached.sessions, diagnostics };
    }
    const initial = await remoteListSessionsSoft(remote, targetDir);
    if (!initial.ok) {
      return { sessions: [], error: initial.error };
    }
    const sessions = mergeRemoteSessionEntries(initial.sessions, previous);
    // Carry hydration progress when the file SET is unchanged (mtime drift on
    // an actively-written session must not restart hydration from zero).
    const hydratedCount = previous && sameSessionPaths(previous.sessions, sessions) ? previous.hydratedCount : 0;
    setCachedRemoteSessions(cacheKey, sessions, false, hydratedCount, false, 2, Date.now());
    void scheduleRemoteHydrationWork();
    return { sessions, diagnostics: initial.diagnostics };
  });
  ipcMain.handle("session:delete", async (_e, payload: { path: string; tabId?: string }) => {
    // 本地文件优先：路径在本机存在就直接本地删除，
    // 避免批量删除受“当前活动标签页是远程”影响而误走 SFTP。
    if (existsSync(payload.path)) {
      try {
        unlinkSync(payload.path);
        sessionIndex.invalidateFile(payload.path);
        return { ok: true };
      } catch (err) {
        // 例如 Windows 上文件正被 pi 进程占用时抛出 EPERM/EBUSY
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    if (t?.wsl && !existsSync(payload.path)) {
      // WSL session paths are UNC (\\wsl$\<distro>\…) — use them as-is. The
      // Linux-path translation below only covers legacy/edge callers.
      const isUnc = /^\\\\wsl\$\\/i.test(payload.path);
      const winPath = isUnc ? payload.path : wslToWinPath(t.wsl.distro, resolveWslPath(t.wsl.distro, payload.path));
      try {
        if (existsSync(winPath)) { unlinkSync(winPath); return { ok: true }; }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (t?.remote) {
      try {
        await withSftp(t.remote, async (client) => {
          await client.delete(payload.path);
        });
        invalidateRemoteCaches(t.remote);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: false, error: "文件不存在（可能已被删除）" };
  });

  ipcMain.handle("session:rename", async (_e, path: string, name: string) => {
    try {
      // Async read/write: a multi-MB session JSONL must never be read+written
      // synchronously on the main thread (it froze ALL IPC, incl. terminal
      // streaming, for hundreds of ms on slow disks).
      const raw = await readFile(path, "utf8");
      const idx = raw.indexOf("\n");
      if (idx < 0) return { ok: false, error: "empty session file" };
      let header;
      try { header = JSON.parse(raw.slice(0, idx)); } catch {
        return { ok: false, error: "invalid header JSON" };
      }
      header.name = name || undefined;
      const rest = raw.slice(idx);
      await writeFile(path, JSON.stringify(header) + rest, "utf8");
      sessionIndex.invalidateFile(path);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Project directory picker (opens a new tab in the chosen dir) ---
  ipcMain.handle("dialog:select-dir", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "选择项目目录",
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // --- Auto-follow: pi's file operations → right panel ---
  onFilePath(({ path, kind }) => {
    mainWindow?.webContents.send("file:autofollow", { path, kind });
  });
  onStatus((status) => {
    mainWindow?.webContents.send("file:autofollow-status", status);
  });

  // --- App settings (auto-follow preferences) ---
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, patch: Partial<AppSettings>) => updateSettings(patch));

  // --- Remote file operations (SFTP) ---
  async function withSftp<T>(remote: RemoteOpts, fn: (client: SftpClient, homeDir: string) => Promise<T>): Promise<T> {
    const lease = await getSftpLease(remote);
    lease.refCount += 1;
    lease.lastUsedAt = Date.now();
    if (lease.idleTimer) {
      clearTimeout(lease.idleTimer);
      lease.idleTimer = null;
    }
    try {
      return await fn(lease.client, lease.homeDir);
    } catch (error) {
      await destroySftpLease(lease);
      throw error;
    } finally {
      lease.refCount = Math.max(0, lease.refCount - 1);
      lease.lastUsedAt = Date.now();
      if (sftpLeases.get(lease.key) === lease) scheduleSftpLeaseCleanup(lease);
    }
  }

  function resolveRemotePath(inputPath: string | undefined, homeDir: string): string {
    const raw = (inputPath || "~").trim();
    if (raw === "~") return homeDir;
    if (raw.startsWith("~/")) return posixPath.join(homeDir, raw.slice(2));
    if (raw.startsWith("/")) return posixPath.normalize(raw);
    return posixPath.normalize(posixPath.join(homeDir, raw));
  }

  /** Single-level WSL directory listing (mirrors remoteListFiles: fast, lazy).
   *  Returns Linux-style paths so the renderer can browse with the same
   *  navigation logic as SSH remotes. Cached by the caller (5s TTL). */
  async function wslListFiles(distro: string, linuxPath: string) {
    try {
      const winPath = wslToWinPath(distro, linuxPath);
      const items = await import("node:fs/promises").then((m) => m.readdir(winPath, { withFileTypes: true }));
      const entries = items.map((item) => ({
        name: item.name,
        path: posixPath.join(linuxPath, item.name),
        type: (item.isDirectory() ? "directory" : "file") as "directory" | "file",
        children: item.isDirectory() ? [] : undefined,
      }));
      if (linuxPath !== "/") {
        const parent = posixPath.dirname(linuxPath) || "/";
        if (parent !== linuxPath) {
          entries.unshift({ name: "..", path: parent, type: "directory" as const, children: [] });
        }
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return entries;
    } catch (e) {
      return [{
        name: `（WSL 浏览失败: ${e instanceof Error ? e.message : String(e)}）`,
        path: "",
        type: "file" as const,
      }];
    }
  }

  async function remoteListFiles(remote: RemoteOpts, dirPath?: string) {    try {
      return await withSftp(remote, async (client, homeDir) => {
        const dir = resolveRemotePath(dirPath ?? remote.path, homeDir);
        const items = await client.list(dir);
        const entries = items.map((item: { name: string; type: string }) => ({
          name: item.name,
          path: posixPath.join(dir, item.name),
          type: (item.type === "d" ? "directory" : "file") as "directory" | "file",
          children: item.type === "d" ? [] : undefined,
        }));
        if (dir !== "/") {
          const parent = posixPath.dirname(dir) || "/";
          if (parent !== dir) {
            entries.unshift({ name: "..", path: parent, type: "directory" as const, children: [] });
          }
        }
        return entries;
      });
    } catch (e) {
      return [{
        name: `（远程浏览失败: ${e instanceof Error ? e.message : String(e)}）`,
        path: "",
        type: "file" as const,
      }];
    }
  }

  async function hydrateRemoteSessionsInBackground(
    tabId: string,
    remote: RemoteOpts,
    remoteCwd: string,
    cacheKey: string,
    currentSessions: SessionEntry[],
  ): Promise<void> {
    const cacheEntry = remoteSessionCache.get(cacheKey);
    if (!cacheEntry || cacheEntry.hydrating || cacheEntry.hydrationPaused) return;
    const initialTargetCount = Math.min(REMOTE_SESSION_HEAD_HYDRATE_LIMIT, currentSessions.length);
    const nextTargetCount = cacheEntry.hydratedCount < initialTargetCount
      ? initialTargetCount
      : Math.min(currentSessions.length, cacheEntry.hydratedCount + REMOTE_SESSION_HYDRATE_BATCH_SIZE);
    if (nextTargetCount <= cacheEntry.hydratedCount) return;
    cacheEntry.hydrating = true;
    activeRemoteHydrations += 1;
    try {
      const hydrated = await hydrateRemoteSessionsRange(remote, remoteCwd, currentSessions, cacheEntry.hydratedCount, nextTargetCount);
      const latest = remoteSessionCache.get(cacheKey);
      // A fresh listing may have landed while we were reading (the title poll
      // or a renderer listRemote). Don't clobber it with our stale snapshot —
      // abort and let the new entry re-hydrate instead. Compare the file SET
      // (paths), not mtimes: an active session is written continuously, so
      // mtime drift is normal and must not cancel hydration.
      if (!latest || !sameSessionPaths(currentSessions, latest.sessions)) return;
      setCachedRemoteSessions(
        cacheKey,
        hydrated,
        false,
        nextTargetCount,
        latest?.hydrationPaused ?? false,
        latest?.priority ?? 0,
        latest?.lastRequestedAt ?? Date.now(),
      );
      emitRemoteSessionsUpdated(tabId, remoteCwd, hydrated);
    } catch {
      const latest = remoteSessionCache.get(cacheKey);
      if (latest) latest.hydrating = false;
    } finally {
      activeRemoteHydrations = Math.max(0, activeRemoteHydrations - 1);
      const latest = remoteSessionCache.get(cacheKey);
      if (latest) latest.hydrating = false;
      void scheduleRemoteHydrationWork();
    }
  }

  async function scheduleRemoteHydrationWork(): Promise<void> {
    if (activeRemoteHydrations >= REMOTE_SESSION_MAX_CONCURRENT_HYDRATIONS) return;
    const candidates = [...remoteSessionCache.entries()]
      .filter(([, entry]) => !entry.hydrationPaused && !entry.hydrating && entry.hydratedCount < entry.sessions.length)
      .sort((a, b) => {
        const aNeedsHead = a[1].hydratedCount < Math.min(REMOTE_SESSION_HEAD_HYDRATE_LIMIT, a[1].sessions.length) ? 1 : 0;
        const bNeedsHead = b[1].hydratedCount < Math.min(REMOTE_SESSION_HEAD_HYDRATE_LIMIT, b[1].sessions.length) ? 1 : 0;
        if (aNeedsHead !== bNeedsHead) return bNeedsHead - aNeedsHead;
        if (a[1].priority !== b[1].priority) return b[1].priority - a[1].priority;
        return b[1].lastRequestedAt - a[1].lastRequestedAt;
      });
    for (const [cacheKey, entry] of candidates) {
      if (activeRemoteHydrations >= REMOTE_SESSION_MAX_CONCURRENT_HYDRATIONS) break;
      const [remoteKey, remoteCwd] = cacheKey.split("::sessions::");
      const tab = listTabs().find((item) => item.remote && stableRemoteKey(item.remote) === remoteKey);
      if (!tab?.remote || !remoteCwd) continue;
      void hydrateRemoteSessionsInBackground(tab.id, tab.remote, remoteCwd, cacheKey, entry.sessions);
    }
  }

  type RemoteSessionListResult =
    | { ok: true; sessions: SessionEntry[]; diagnostics: { resolvedCwd: string; sessionDir: string; fileCount: number } }
    | { ok: false; error: string };

  /** List + parse one remote session dir (metadata-only; eager limit 0). */
  async function listRemoteSessionDir(client: SftpClient, homeDir: string, remoteCwd: string): Promise<{ sessions: SessionEntry[]; diagnostics: { resolvedCwd: string; sessionDir: string; fileCount: number } }> {
    const resolvedCwd = resolveRemotePath(remoteCwd, homeDir);
    const sessionDir = posixPath.join(homeDir, ".pi", "agent", "sessions", encodeCwd(resolvedCwd));
    const items = await client.list(sessionDir);
    const files = items
      .filter((item: { name: string; type: string }) => item.type !== "d" && item.name.endsWith(".jsonl"))
      .sort((a: { modifyTime?: number }, b: { modifyTime?: number }) => (b.modifyTime ?? 0) - (a.modifyTime ?? 0));

    const eager = files.slice(0, REMOTE_SESSION_EAGER_PARSE_LIMIT);
    const deferred = files.slice(REMOTE_SESSION_EAGER_PARSE_LIMIT);

    const eagerParsed = await Promise.all(eager.map(async (item: { name: string; modifyTime?: number; size?: number }) => {
      const full = posixPath.join(sessionDir, item.name);
      try {
        const raw = await client.get(full);
        const text = (Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).subarray(0, REMOTE_SESSION_READ_BYTE_LIMIT).toString("utf8");
        const parsed = parseSessionText(text, full, {
          mtime: item.modifyTime ?? 0,
          size: item.size ?? Buffer.byteLength(text, "utf8"),
        });
        return parsed ?? fallbackRemoteSessionEntry(full, item);
      } catch {
        return fallbackRemoteSessionEntry(full, item);
      }
    }));

    const deferredParsed = deferred.map((item: { name: string; modifyTime?: number; size?: number }) => {
      const full = posixPath.join(sessionDir, item.name);
      return fallbackRemoteSessionEntry(full, item);
    });

    return {
      sessions: [...eagerParsed, ...deferredParsed].sort((a, b) => b.mtime - a.mtime),
      diagnostics: {
        resolvedCwd,
        sessionDir,
        fileCount: files.length,
      },
    };
  }

  /**
   * Non-destructive variant for the background title poll: errors (e.g. a
   * missing session dir, which is routine) are caught INSIDE the callback so
   * withSftp never tears down the shared lease — teardown would kill any
   * in-flight file-tree/read operation on the same connection.
   */
  async function remoteListSessionsSoft(remote: RemoteOpts, remoteCwd: string): Promise<RemoteSessionListResult> {
    try {
      return await withSftp(remote, async (client, homeDir) => {
        try {
          const result = await listRemoteSessionDir(client, homeDir, remoteCwd);
          return { ok: true as const, sessions: result.sessions, diagnostics: result.diagnostics };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
      });
    } catch (error) {
      // Connection-level failure — withSftp already cleaned up the lease.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function remoteSessionDiagnosticsSoft(remote: RemoteOpts, remoteCwd: string): Promise<{ resolvedCwd: string; sessionDir: string; fileCount: number } | undefined> {
    try {
      return await withSftp(remote, async (client, homeDir) => {
        try {
          const resolvedCwd = resolveRemotePath(remoteCwd, homeDir);
          const sessionDir = posixPath.join(homeDir, ".pi", "agent", "sessions", encodeCwd(resolvedCwd));
          const items = await client.list(sessionDir);
          const fileCount = items.filter((item: { name: string; type: string }) => item.type !== "d" && item.name.endsWith(".jsonl")).length;
          return { resolvedCwd, sessionDir, fileCount };
        } catch {
          return undefined;
        }
      });
    } catch {
      return undefined;
    }
  }

  async function hydrateRemoteSessionsRange(
    remote: RemoteOpts,
    remoteCwd: string,
    currentSessions: SessionEntry[],
    startIndex: number,
    endIndex: number,
  ): Promise<SessionEntry[]> {
    if (endIndex <= startIndex) return currentSessions;
    return withSftp(remote, async (client, homeDir) => {
      const sessionDir = posixPath.join(homeDir, ".pi", "agent", "sessions", encodeCwd(resolveRemotePath(remoteCwd, homeDir)));
      const hydratedRange = await Promise.all(currentSessions.slice(startIndex, endIndex).map(async (entry) => {
        try {
          const raw = await client.get(entry.path || posixPath.join(sessionDir, posixPath.basename(entry.path)));
          const text = (Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).subarray(0, REMOTE_SESSION_READ_BYTE_LIMIT).toString("utf8");
          return parseSessionText(text, entry.path, {
            mtime: entry.mtime,
            size: entry.size || Buffer.byteLength(text, "utf8"),
          }) ?? entry;
        } catch {
          return entry;
        }
      }));
      return [
        ...currentSessions.slice(0, startIndex),
        ...hydratedRange,
        ...currentSessions.slice(endIndex),
      ];
    });
  }

  function fallbackRemoteSessionEntry(
    fullPath: string,
    item: { name: string; modifyTime?: number; size?: number },
  ): SessionEntry {
    const base = item.name.replace(/\.jsonl$/i, "");
    const sessionId = base.match(/_([0-9a-f-]+)$/i)?.[1] ?? base;
    return {
      path: fullPath,
      sessionId,
      mtime: item.modifyTime ?? 0,
      size: item.size ?? 0,
      messageCount: 0,
      firstMessage: "",
      name: null,
    };
  }

  async function remoteReadFile(remote: RemoteOpts, filePath: string, baseDir: string) {
    try {
      if (/^[A-Za-z]:[\\/]/.test(filePath)) {
        throw new Error(`remote tab cannot open local path: ${filePath}`);
      }
      return await withSftp(remote, async (client, homeDir) => {
        const full = filePath.startsWith("/")
          ? posixPath.normalize(filePath)
          : resolveRemotePath(posixPath.join(baseDir, filePath), homeDir);
        const content = await client.get(full);
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
        const bytes = buffer.byteLength;
        const head = buffer.subarray(0, 8192);
        const isBinary = head.includes(0);
        return {
          content: isBinary ? "[二进制文件]" : buffer.toString("utf8"),
          bytes,
          isBinary,
          error: undefined as string | undefined,
        };
      });
    } catch (e) {
      return { content: `⚠️ 读取失败: ${e instanceof Error ? e.message : String(e)}`, bytes: 0, isBinary: false, error: String(e) };
    }
  }

  // Provision the app-controlled themes into pi's config BEFORE the window
  // opens so the very first local tab already renders with the app's palette
  // (pi hot-reloads these files and the settings auto-mapping on later edits).
  try {
    const written = ensureLocalThemeFiles();
    const settingsChanged = ensureLocalSettingsTheme();
    console.log(
      `[theme] local themes ${written.length ? `written: ${written.join(", ")}` : "up-to-date"}` +
        ` | settings theme ${settingsChanged ? "updated" : "up-to-date"}`
    );
  } catch (error) {
    console.error("[theme] local provisioning failed:", error);
  }

  createWindow();

  // Warm the pi/node detection caches in the background (spawnSync calls like
  // `pi --version` block the main process ~1s each). Done once at startup so
  // the FIRST session click doesn't pay for detection; the window paints
  // first and the warm-up runs 250ms later.
  setTimeout(() => warmPiDetection(), 250);

  // Open the initial tab: continue the most recent session for the cwd.
  emitTabs();
  emitActive();

  // While the user works in a remote pi tab, pi writes its session file on
  // the server. Light poll of the active remote project's session dir so new
  // sessions get linked to their tab (title + sidebar highlight) and renamed
  // sessions update tab titles — the remote counterpart of the local
  // fs.watch title sync in pty.ts. SSH uses a metadata-only SFTP listing;
  // WSL reads the same dirs directly via \\\\wsl$ UNC (incremental scan).
  remotePollTimer = setInterval(() => {
    void refreshActiveRemoteTabTitles();
  }, 4000);

  // Back off per server after failures (unreachable host / session dir not
  // created yet) so one dead server can't block polling for others and we
  // don't retry an SSH+SFTP connect every 4s in a tight loop.
  const remoteRefreshFailures = new Map<string, number>(); // remoteKey -> last failure time
  async function refreshActiveRemoteTabTitles(): Promise<void> {
    const t = getActiveTab();
    if (!t) return;
    if (t.wsl) {
      // WSL sessions are plain files on the local disk — no SFTP/lease
      // needed. Scan the session dir and run the same title + blank-tab
      // linking as the SSH branch below. Mirror SSH: re-emit (sidebar
      // refresh) only when the session FILE SET changed; otherwise just sync
      // titles. emitRemoteSessionsUpdated also syncs titles.
      const targetDir = t.wsl.path ?? "~";
      const r = await wslScanSessionDir(t.wsl.distro, targetDir, true);
      if (r.changed) emitRemoteSessionsUpdated(t.id, targetDir, r.sessions);
      else syncRemoteTabTitles(t.id, targetDir, r.sessions);
      return;
    }
    if (!t.remote || t.remote.startPi === false) return;
    const targetDir = t.remoteBrowsePath ?? t.remote.path ?? "~";
    const cacheKey = remoteSessionCacheKey(t.remote, targetDir);
    // IMPORTANT: read BEFORE getCachedRemoteSessions — that helper deletes the
    // entry from the Map once it expires, so this must capture it first to
    // carry names/hydration progress over.
    const previous = remoteSessionCache.get(cacheKey);
    const cached = getCachedRemoteSessions(cacheKey);
    if (cached) {
      // Cache is fresh (≤12s): sync titles from it and stop. Never re-list
      // here — that would downgrade the cache to metadata-only and restart
      // hydration, flashing "正在加载会话信息" on every session. (We do NOT
      // extend the TTL: letting it expire is what triggers the next re-list,
      // which discovers the session file pi creates for blank tabs.)
      syncRemoteTabTitles(t.id, targetDir, cached.sessions);
      return;
    }
    const remoteKey = t.remoteKey ?? buildRemoteKey(t.remote);
    const lastFailure = remoteRefreshFailures.get(remoteKey) ?? 0;
    if (Date.now() - lastFailure < 20_000) return;
    // previous (captured above) may be expired but still holds hydrated
    // names + progress; carry them over so the sidebar never loses labels.
    const fresh = await remoteListSessionsSoft(t.remote, targetDir);
    if (!fresh.ok) {
      remoteRefreshFailures.set(remoteKey, Date.now());
      return;
    }
    remoteRefreshFailures.delete(remoteKey);
    const merged = mergeRemoteSessionEntries(fresh.sessions, previous);
    // Path-set comparison: only new/deleted sessions count as a change for
    // the renderer. mtime drift on an actively-written session is routine
    // and must not re-emit the list (that was the "会话一直在刷新" loop).
    const changed = !previous || !sameSessionPaths(previous.sessions, fresh.sessions);
    // Reset hydration progress only when the file set changed (new/deleted
    // sessions — rare); mtime drift keeps the count so hydration never
    // restarts from zero while a session is simply being written.
    const hydratedCount = changed ? 0 : (previous?.hydratedCount ?? 0);
    setCachedRemoteSessions(cacheKey, merged, false, hydratedCount, false, 1, Date.now());
    void scheduleRemoteHydrationWork();
    if (changed) emitRemoteSessionsUpdated(t.id, targetDir, merged);
    else syncRemoteTabTitles(t.id, targetDir, merged);
  }

  /** Compare only the SET of session files (paths), ignoring mtime drift. */
  function sameSessionPaths(a: SessionEntry[], b: SessionEntry[]): boolean {
    if (a.length !== b.length) return false;
    const setA = new Set(a.map((s) => s.path));
    return b.every((s) => setA.has(s.path));
  }

  /**
   * Carry hydrated fields (name, firstMessage, messageCount, size) from a
   * previous cache entry onto a fresh metadata-only listing. Without this, an
   * expired cache re-list resets every remote session to "0 条" until
   * re-hydration completes (a multi-second flicker on every 12s TTL expiry).
   */
  function mergeRemoteSessionEntries(fresh: SessionEntry[], previous?: RemoteSessionCacheEntry): SessionEntry[] {
    if (!previous) return fresh;
    const oldByPath = new Map(previous.sessions.map((s) => [s.path, s]));
    return fresh.map((s) => {
      const old = oldByPath.get(s.path);
      if (!old) return s;
      return {
        ...s,
        name: s.name ?? old.name,
        firstMessage: s.firstMessage || old.firstMessage,
        messageCount: s.messageCount || old.messageCount,
        size: s.size || old.size,
        mtime: s.mtime || old.mtime,
      };
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  if (remotePollTimer) clearInterval(remotePollTimer);
  stopLocalSessionsPoll();
  closeAllTabs();
  closeAllRpcSessions();
  stopWatching();
  await Promise.all([...sftpLeases.values()].map((lease) => destroySftpLease(lease)));
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (remotePollTimer) clearInterval(remotePollTimer);
  stopLocalSessionsPoll();
  closeAllTabs();
  closeAllRpcSessions();
  stopWatching();
  await Promise.all([...sftpLeases.values()].map((lease) => destroySftpLease(lease)));
});

process.on("unhandledRejection", (err) => {
  console.error("[main] unhandledRejection:", err);
});
