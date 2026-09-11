import { app, BrowserWindow, ipcMain, dialog, powerMonitor, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { spawn } from "node:child_process";
import { isAbsolute, relative, sep, join, dirname, posix as posixPath, win32 as win32Path } from "node:path";
import { unlinkSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, rename, access, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import SftpClient from "ssh2-sftp-client";
import { Client as SshClient } from "ssh2";
import { readFileContent, writeFileContent, createDirectory, deletePath, renamePath, isValidName, imagePayloadOf, listDirChildren, readPreviewFromAbs, rasterImageMimeOf, isBinaryBuffer, resolveWithin, TEXT_PREVIEW_MAX_BYTES, TEXT_PREVIEW_HALF_BYTES, IMAGE_PREVIEW_MAX_BYTES, type FileOpResult } from "./file-tree";
import { specForModel } from "../shared/model-specs";
import { lookupModelSpecs } from "./specs-lookup";
import {
  createTab, closeTab, closeAllTabs, getTab, listTabs, setActiveTab,
  resizeTab, writeTab, subscribeTab, getActiveTab, findSshBin,
  getRemoteBrowsePath, setRemoteBrowsePath, buildRemoteKey, setThemeMode,
  hasGlobalPiInstalled, warmPiDetection, invalidatePiDetection,
  startGlobalPiInstall, classifyInstallStage, installGlobalPiFromBundled,
  onTabsChanged, setTabTitle, linkTabSession, listWslDistros, sanitizeRemoteAgentDir, remoteAgentDir,
  restartTab, isPtyTabAlive,
  type TabInfo, type RemoteOpts, type WslOpts,
} from "./pty";
import { ensureLocalSettingsTheme, ensureLocalThemeFiles, syncThemesViaSftp, agentDir, type RemoteThemeSyncResult } from "./theme-sync";
import type { ThemeMode } from "../shared/terminal-theme";
import type { ModelEditorSpec, PiApi, ProviderEditorConfig } from "../shared/model-config-types";
import { encodeCwd, listLocalProjects, parseSessionTextAsync, type SessionEntry } from "./session-list";
import { parseTreeFileAsync } from "./tree-from-file";
import { transcriptFromContent } from "./transcript-from-file";
import { sameSessionPaths } from "../shared/session-paths";
import { pickWslEventTab } from "./wsl-event-tab";
import { wslToWinPath, parseWslDistroList } from "./wsl";
import { SessionIndex, localTarget, wslTarget, type SessionTarget } from "./session-index";
import { ensureShippedExtensions, SHIPPED_EXTENSIONS, syncExtensionsViaSftp, buildSshInstallCommand, buildSshCatCommand } from "./extension-sync";
import { debugLog } from "./debug-log";
import { createSessionFileReader, type SessionFileTarget } from "./session-file-reader";
import { INTERNAL_RPC_ID_PREFIX } from "../shared/transcript";
import { isSftpMissingPathError } from "./sftp-errors";
import { describeConnectFailure, isSftpPathError, isSshAuthError } from "./sftp-failure";
import {
  closeAllRpcSessions, closeRpcTab, createRpcTab, getRpcSession, listRpcSessions,
  setUiRequestHandler, switchRpcToTerminal, switchTerminalToRpc,
  type ExtensionUiRequest,
} from "./rpc-session";
import {
  sdkSend, sdkUiResponse, sdkRequest, sdkOnExit, openSdkSession, closeSdkTab, getSdkTab, listSdkTabs, closeAllSdkSessions,
  switchSdkToTerminal, switchTerminalToSdk,
  ensureSdkWorkerStarted,
  setUiRequestHandler as setSdkUiRequestHandler,
} from "./chat-backend/sdk-host";
import { checkAppUpdate, checkPiUpdate, checkRemotePiUpdate, openAppUpdateDownload, runPiUpdate, runRemotePiUpdate, type RemoteUpdateTarget } from "./update-check";
import { getFileDiff, listFileChanges, getFileHistory, diffTextOf, rollbackFileContent, listGitCommits, getFileAt, type FileVersionEvent } from "./diff-session";
import { FileTreeIndex } from "./file-tree-index";
import { startWatching, stopWatching, onFilePath, onStatus } from "./session-watcher";
import { getSettings, updateSettings, type AppSettings } from "./settings";
import { addLocalProject, addRemoteProject, addWslProject, addModel, updateModel, deleteModel, deleteProject, listModels, listProjects, syncModelToPi, checkPiModelSync } from "./projects";

interface RemoteModelListResponse {
  data?: Array<{ id?: string }>;
}
import { listRemoteHistory, saveRemoteHistory, deleteRemoteHistory } from "./remote-history";

let mainWindow: BrowserWindow | null = null;

type WorkbenchCommand =
  | "project:open"
  | "remote:connect"
  | "session:new"
  | "session:close"
  | "view:toggle-viewer"
  | "view:toggle-theme"
  | "models:configure"
  | "help:shortcuts";

/**
 * Native menu adapter. The menu is deliberately small: it exposes only
 * workbench actions that have a clear effect in this product, while native
 * edit roles retain platform-standard text selection/copy/paste behavior.
 */
function sendWorkbenchCommand(command: WorkbenchCommand): void {
  mainWindow?.webContents.send("workbench:command", command);
}

function installWorkbenchMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "项目",
      submenu: [
        { label: "打开本地项目…", accelerator: "Ctrl+O", click: () => sendWorkbenchCommand("project:open") },
        { label: "连接远程服务器…", accelerator: "Ctrl+Shift+O", click: () => sendWorkbenchCommand("remote:connect") },
        { type: "separator" },
        { label: "新建会话", accelerator: "Ctrl+N", click: () => sendWorkbenchCommand("session:new") },
        { label: "关闭当前会话", accelerator: "Ctrl+W", click: () => sendWorkbenchCommand("session:close") },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "显示/隐藏文件面板", accelerator: "Ctrl+Shift+P", click: () => sendWorkbenchCommand("view:toggle-viewer") },
        { label: "切换深色/浅色主题", accelerator: "Ctrl+Shift+L", click: () => sendWorkbenchCommand("view:toggle-theme") },
        { label: "模型配置…", accelerator: "Ctrl+,", click: () => sendWorkbenchCommand("models:configure") },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "close" }],
    },
    {
      label: "帮助",
      submenu: [
        { label: "快捷键说明", accelerator: "Ctrl+/", click: () => sendWorkbenchCommand("help:shortcuts") },
        {
          label: "关于 pipi",
          click: () => void dialog.showMessageBox({
            type: "info", title: "关于 pipi", message: "pipi", detail: "远程 AI 编程工作台\n版本 " + app.getVersion(),
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
let remotePollTimer: NodeJS.Timeout | null = null;
/** App-bundled extension files re-shipped at startup; drained by the renderer via update:extensions-synced. */
let pendingExtensionSync: string[] = [];

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

const REMOTE_SESSION_CACHE_TTL_MS = 12_000;const REMOTE_FILE_TREE_CACHE_TTL_MS = 5_000;
// Idle TTL for the shared SFTP lease. 20s was too aggressive: every lease
// expiry destroys the connection (client-side clean close → sshd logs
// "Received disconnect :11"), and the next poll re-creates it — a fresh
// server login on every cycle. That churn showed up in server logs as
// "login, dies ~20s later, repeated every ~20s". 2 minutes keeps the
// connection warm across polls/hydration while still reclaiming idle conns.
const SFTP_IDLE_TTL_MS = 120_000;
/** Budget for the transcript provider's INTERNAL get_state probe. Small response
 *  (hundreds of bytes), so it stays far below HISTORY_REQUEST_TIMEOUT_MS: if pi
 *  cannot answer even this, the RPC fallback would not fare better. */
const TRANSCRIPT_STATE_TIMEOUT_MS = 12_000;
const REMOTE_SESSION_EAGER_PARSE_LIMIT = 0;
const REMOTE_SESSION_HEAD_HYDRATE_LIMIT = 5;
// Batch of 8 (up from 4): OpenSSH sftp-server serializes requests on one
// connection, so a batch of N files ≈ N×(head+tail) RTTs either way — bigger
// batches only cut the per-batch bookkeeping (lease round-trip, IPC emit,
// renderer map churn), not the wire time. 50 sessions ≈ 6 passes instead of
// 12. The 2-global-concurrent cap still bounds total in-flight reads.
const REMOTE_SESSION_HYDRATE_BATCH_SIZE = 8;
const REMOTE_SESSION_MAX_CONCURRENT_HYDRATIONS = 2;
const REMOTE_SESSION_READ_BYTE_LIMIT = 128 * 1024;
/** Tail window for oversize session files: pi appends session_info (rename)
 *  entries to the END of the JSONL — mirror pty.ts's local head+tail read. */
const REMOTE_SESSION_TAIL_READ_BYTES = 64 * 1024;
const remoteSessionCache = new Map<string, RemoteSessionCacheEntry>();
const remoteFileTreeCache = new Map<string, RemoteFileTreeCacheEntry>();
const sftpLeases = new Map<string, SftpLease>();
/** Latest connection profile seen per remoteKey. Background session
 *  hydration is keyed by remoteKey, so it needs the profile even when no tab
 *  exists for that server ("virtual target" flows — see resolveTarget). */
const remoteProfiles = new Map<string, RemoteOpts>();
function rememberRemoteProfile(remote: RemoteOpts | undefined): void {
  if (remote?.host && remote.user) remoteProfiles.set(stableRemoteKey(remote), remote);
}

// Remote theme sync cache: skip re-uploading theme files on every connect.
const remoteThemeSyncAt = new Map<string, number>();
const REMOTE_THEME_SYNC_TTL_MS = 15 * 60 * 1000;
let activeRemoteHydrations = 0;
// Last WSL session list emitted per distro (change-forwarder dedup: only a
// file-set change re-emits; mtime drift only syncs titles).
const wslLastEmittedSessions = new Map<string, SessionEntry[]>();

// --- Live session list sync (local + WSL) ----------------------------------
// All session listing/caching for filesystem-backed targets lives in
// SessionIndex (session-index.ts): the renderer's session:list / WSL branch
// of session:list-remote, the 4s active-cwd poll, the active-tab session
// cache and the change push all cross the same seam.
const sessionIndex = new SessionIndex();
// WSL home resolution is injected (async, non-blocking) so the click path
// never spawnSync's wsl.exe — mirrors the CONTEXT.md no-sync-spawn rule.
sessionIndex.setWslHomeResolver(getWslHomeAsync);
const fileTreeIndex = new FileTreeIndex();

function startSessionsPoll(target: SessionTarget, cwd: string): void {
  sessionIndex.startPolling(target, cwd);
}

function stopSessionsPoll(): void {
  sessionIndex.stopPolling();
}

/** The target for a tab's session list: WSL tabs map to their distro,
 *  everything filesystem-backed is local. (SSH/SFTP is a different
 *  transport — the remote cache + hydration pipeline, not this seam.) */
function sessionTargetForTab(t: TabInfo): SessionTarget {
  return t.wsl ? wslTarget(t.wsl.distro) : localTarget();
}

function emitRemoteSessionsUpdated(payload: {
  /** Present for tab-bound flows (WSL, active remote tab). */
  tabId?: string;
  /** Connection profile key — the tab-independent identity of a remote
   *  server. The renderer caches remote session lists by this when present. */
  remoteKey?: string;
  remoteCwd: string;
  sessions: SessionEntry[];
  hydratedCount?: number;
  totalCount?: number;
}): void {
  mainWindow?.webContents.send("session:remote-updated", payload);
  // Tab-bound flows also refresh the open tab's label; a pure profile flow
  // (no tab) has no label to sync.
  if (payload.tabId) syncRemoteTabTitles(payload.tabId, payload.remoteCwd, payload.sessions);
}

/**
 * Which tab a WSL SessionIndex change event belongs to. The 4s poll runs for
 * the ACTIVE WSL tab, so the polled scope is the strongest signal; with two
 * tabs of the same distro open, first-by-distro insertion order would
 * attribute the event to the wrong tabId (the sidebar's remoteSessions cache
 * and hydration-idle clear key on tabId). Fallback: exact path match, then
 * any tab of the distro. Pure core (pickWslEventTab) is unit-tested.
 */
function resolveWslEventTab(target: { kind: string; distro?: string }, cwd: string): TabInfo | undefined {
  if (target.kind !== "wsl") return undefined;
  const polled = sessionIndex.getPolledScope();
  const active = getActiveTab();
  const picked = pickWslEventTab(
    listTabs(),
    active && active.wsl?.distro === target.distro ? active : undefined,
    !!(polled && polled.target.kind === "wsl" && polled.target.distro === target.distro && polled.cwd === cwd),
    target.distro ?? "",
    cwd,
  );
  return picked ? getTab(picked.id) : undefined;
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
      // Different agentDir = different data space (shared-account isolation):
      // caches, leases and title links must not cross-contaminate.
      agentDir: remote.agentDir ?? "",
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

/** Recent remote CONNECT failures keyed by the readable profile key (no path:
 *  one broken server is one problem, however many projects it hosts). Without
 *  this, every caller — session-hydration batches, the 4s title poll, the 6s
 *  tree poll — retried a dead server independently, each attempt paying a full
 *  TCP + auth round trip: a connect storm that made the whole machine crawl
 *  while the UI showed "正在加载…". */
const sftpFailures = new Map<string, { at: number; error: string; auth: boolean }>();
const SFTP_FAILURE_COOLDOWN_MS = 20_000;
/** Auth failures stay "known-bad" much longer: retrying cannot help until a
 *  credential changes, and the user must be asked for a password instead. */
const SFTP_AUTH_FAILURE_COOLDOWN_MS = 60_000;

/** Push a remote connection state to the renderer (sidebar dot + login
 *  dialog). Emitted by the SFTP breaker and by remote:probe, so the dot is
 *  correct no matter which entry path discovered the failure. The password is
 *  deliberately NOT sent back — the renderer is about to ask for one. */
function emitRemoteStatus(
  remote: RemoteOpts,
  status: "connected" | "failed" | "disconnected",
  extra?: { needPassword?: boolean; error?: string },
): void {
  mainWindow?.webContents.send("remote:status", {
    remoteKey: buildRemoteKey(remote),
    status,
    needPassword: extra?.needPassword ?? false,
    error: extra?.error,
    profile: { host: remote.host, user: remote.user, port: remote.port ?? 22, agentDir: remote.agentDir },
  });
}

/** Default private keys for key-auth servers (best effort, in preference
 *  order). ssh2 accepts several and tries them in turn. */
async function defaultPrivateKeys(): Promise<Buffer[]> {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) return [];
  const keys: Buffer[] = [];
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    try {
      keys.push(await readFile(join(home, ".ssh", name)));
    } catch {
      /* key not present */
    }
  }
  return keys;
}

/** SSH auth material for a profile. The probe and the SFTP lease MUST use the
 *  same material: when the probe could authenticate but SFTP could not, the
 *  sidebar went green while every session/file read failed auth — the
 *  "connected but 正在加载会话信息 forever" bug. Password first (what the user
 *  typed), otherwise ssh-agent + the usual ~/.ssh keys. */
async function remoteAuthOptions(remote: RemoteOpts): Promise<Record<string, unknown>> {
  if (remote.password) return { password: remote.password };
  const auth: Record<string, unknown> = {
    agent: process.env.SSH_AUTH_SOCK || "\\\\.\\pipe\\openssh-ssh-agent",
  };
  const keys = await defaultPrivateKeys();
  if (keys.length) auth.privateKey = keys;
  return auth;
}

async function getSftpLease(remote: RemoteOpts): Promise<SftpLease> {
  // Every SFTP round-trip is a chance to learn/refresh this server's profile
  // (incl. a password the user just typed): keep it for background hydration.
  rememberRemoteProfile(remote);
  const key = stableRemoteKey(remote);
  const breakerKey = buildRemoteKey(remote);
  // Circuit breaker: a fresh failure short-circuits WITHOUT touching the
  // network, so a broken server cannot be hammered by every caller at once.
  const failure = sftpFailures.get(breakerKey);
  if (failure) {
    const cooldown = failure.auth ? SFTP_AUTH_FAILURE_COOLDOWN_MS : SFTP_FAILURE_COOLDOWN_MS;
    if (Date.now() - failure.at < cooldown) throw new Error(failure.error);
    sftpFailures.delete(breakerKey);
  }
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
        // Same auth material as remote:probe — otherwise a key-auth server
        // probes green and then fails every SFTP call.
        ...(await remoteAuthOptions(remote)),
        readyTimeout: 15000,
      });
      lease.homeDir = await lease.client.realPath(".");
      lease.lastUsedAt = Date.now();
      sftpFailures.delete(breakerKey);
      lease.connectPromise = null;
      return lease;
    } catch (error) {
      sftpLeases.delete(key);
      try { await lease.client.end(); } catch { /* ignore */ }
      // Never-open-breaker for a path error: that is not a connect problem.
      if (isSftpPathError(error)) throw error;
      const auth = isSshAuthError(error);
      const reason = describeConnectFailure(error);
      sftpFailures.set(breakerKey, { at: Date.now(), error: reason, auth });
      console.error(`[remote] connect failed (${breakerKey}):`, reason, auth ? "[auth]" : "");
      emitRemoteStatus(remote, auth ? "disconnected" : "failed", { needPassword: auth, error: reason });
      throw error;
    }
  })();
  return lease.connectPromise;
}

// --- WSL path helpers --------------------------------------------------------

/** Convert a Linux path inside a WSL distro to a Windows UNC path.
 *  NOTE: callers must pre-resolve `~` (via resolveWslPath / getWslHome) before
 *  calling this; the `~` special-casing below is a defensive fallback only.
 *  Already-UNC paths (e.g. sidebar session paths) pass through unchanged.
 *  Shared with wsl.ts (unit-tested there). */
// (implemented in ./wsl as wslToWinPath; re-exported for local call sites)

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

/** Async (non-blocking) variant of getWslHome for background provisioning:
 *  same cache, so a sync call earlier in the click path makes this resolve
 *  instantly; on timeout/error falls back to the same un-cached guess. Never
 *  blocks the main-process event loop (spawn, not spawnSync). */
function getWslHomeAsync(distro: string): Promise<string> {
  const cached = wslHomeCache.get(distro);
  if (cached) return Promise.resolve(cached);
  const fallback = `/home/${distro.split("-")[0].toLowerCase()}`;
  return new Promise((resolve) => {
    const proc = spawn("wsl.exe", ["-d", distro, "--", "bash", "-c", "echo $HOME"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
      resolve(fallback);
    }, 5000);
    proc.stdout?.on("data", (d: Buffer | string) => {
      out += d.toString();
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(fallback);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      const home = out.trim();
      if (home) wslHomeCache.set(distro, home);
      resolve(home || fallback);
    });
  });
}

/** Resolve a WSL path that may start with ~ to an absolute Linux path. */
function resolveWslPath(distro: string, linuxPath: string): string {
  let p = linuxPath.trim();
  if (p === "~" || p === "") return getWslHome(distro);
  if (p.startsWith("~/")) return getWslHome(distro) + "/" + p.slice(2);
  return p;
}

/**
 * Ship app-bundled pi extensions into a WSL distro's ~/.pi/agent/extensions
 * via the \\wsl$ UNC filesystem (the app already reads WSL sessions this
 * way — see SessionIndex's WSL adapter). RPC-backed WSL chat tabs navigate the
 * session tree through the pipi-tree-nav extension command, which must
 * exist on the DISTRO side; without it the navigation prompt falls through
 * to a normal LLM turn. Content-compared, so it is a no-op once in sync;
 * fully async (non-blocking home resolution + fs/promises), failures are
 * logged, never fatal.
 */
async function syncWslExtensions(distro: string): Promise<void> {
  try {
    const home = await getWslHomeAsync(distro);
    const winHome = wslToWinPath(distro, home);
    const extDir = join(winHome, ".pi", "agent", "extensions");
    await mkdir(extDir, { recursive: true });
    for (const { fileName, content } of SHIPPED_EXTENSIONS) {
      const target = join(extDir, fileName);
      let current: string | null = null;
      try {
        current = await readFile(target, "utf8");
      } catch {
        current = null; // not present yet → write
      }
      if (current === content) continue;
      await writeFile(target, content, "utf8");
      console.log(`[extensions] wrote WSL ${distro}: ${target}`);
    }
  } catch (e) {
    console.error(`[extensions] WSL ${distro} sync failed:`, e instanceof Error ? e.message : String(e));
  }
}

/** Last-shipped content digest per key-auth server: a re-connect with
 *  unchanged shipped extensions skips the ssh round-trip entirely; an app
 *  upgrade changes the digest and re-syncs on the next connect. */
const remoteKeyExtSyncHash = new Map<string, string>();

/**
 * Ship app-bundled pi extensions to a KEY-AUTH (passwordless) remote over
 * ssh.exe — the app holds no SFTP credentials for those servers, but ssh.exe
 * already carries the session (rpc-session.ts runs `pi --mode rpc` through
 * it). BatchMode=yes makes a server that actually requires a password fail
 * fast instead of hanging at a prompt; failures are logged, never fatal.
 * Runs in the background from tab:create (= the connect action), so "right
 * after the user connects" is exactly when the extension lands — the next
 * pi start picks it up. agentDir overrides are skipped (the remote command
 * would need to expand a custom data dir; rare enough to stay manual).
 */
/** Read a remote file over ssh.exe (key-auth remotes have no SFTP lease, but
 *  ssh.exe already carries the session). BatchMode fails fast on servers that
 *  actually need a password; returns "" on any failure (never throws). The
 *  remote path is base64-embedded via buildSshCatCommand, so quoting cannot
 *  break the Windows spawn → ssh.exe → bash chain. */
function sshCatRemoteFile(remote: RemoteOpts, remotePath: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve) => {
    const sshBin = findSshBin() ?? "ssh.exe";
    const proc = spawn(
      sshBin,
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        "-p", String(remote.port ?? 22),
        `${remote.user}@${remote.host}`,
        buildSshCatCommand(remotePath),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
      resolve("");
    }, timeoutMs);
    proc.stdout?.on("data", (d: Buffer | string) => {
      out += d.toString();
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : "");
    });
  });
}

function syncKeyAuthExtensions(remote: RemoteOpts): void {
  if (remote.agentDir) {
    console.log(`[extensions] key-auth remote with agentDir override — manual install required (${stableRemoteKey(remote)})`);
    return;
  }
  const digest = createHash("sha256")
    .update(SHIPPED_EXTENSIONS.map((e) => e.content).join("\u0000"))
    .digest("hex");
  const key = stableRemoteKey(remote);
  if (remoteKeyExtSyncHash.get(key) === digest) return;
  const sshBin = findSshBin() ?? "ssh.exe";
  const proc = spawn(
    sshBin,
    [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      "-p", String(remote.port ?? 22),
      `${remote.user}@${remote.host}`,
      buildSshInstallCommand(),
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }, 20000);
  proc.on("error", () => clearTimeout(timer));
  proc.on("exit", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      remoteKeyExtSyncHash.set(key, digest);
      console.log(`[extensions] key-auth remote synced -> ${key}`);
    } else {
      console.error(`[extensions] key-auth remote sync failed (${key}) exit=${code}`);
    }
  });
}

// --- WSL session listing lives in SessionIndex (session-index.ts) ---------
// WSL sessions are plain files on the local disk (\\wsl$ UNC), so the WSL
// backend is just another SessionIndex adapter behind the same seam as the
// local one: same snapshot-incremental scan, same cooperative parse, same
// 4s poll.

function createWindow() {
  installWorkbenchMenu();
  mainWindow = new BrowserWindow({
    title: "pipi",
    // 用户提供的 图标.png 作为窗口图标（覆盖旧的 icon.ico/icon.png）。
    // 图标来自 图标1.png（scripts/make-icon.mjs 生成）：Windows 用多尺寸
    // ico（16-256px，任务栏/标题栏/大图标模式都清晰），其他平台用 256px png。
    icon: join(__dirname, `../../resources/icon.${process.platform === "win32" ? "ico" : "png"}`),
    width: 1280,
    height: 820,
    // Hidden until the renderer has painted → no white-flash on launch.
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // If the renderer never paints (dev server down / broken build), show the
  // window anyway so the failure is visible instead of an invisible app.
  mainWindow.webContents.once("did-fail-load", () => mainWindow?.show());
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

/** Whether local tabs should use the in-process SDK backend. */
function sdkBackendEnabled(): boolean {
  if (process.env.PIPI_SDK_BACKEND === "0") return false;
  try {
    return getSettings().pipi?.backend !== "rpc";
  } catch {
    return true;
  }
}

/**
 * The directory a tab actually runs in. A remote/WSL tab's `cwd` is the LOCAL
 * path (the app-side directory a new tab would inherit), so labelling a session
 * with its project needs the remote side — without this the renderer showed
 * "agent" for a session living in /data/liuchang/CRSCU…`. Undefined when the
 * tab has no remote identity (local) or the directory is unknown/home.
 */
function tabProjectDir(t: TabInfo | null | undefined): string | undefined {
  if (!t) return undefined;
  if (t.remote) return t.remote.path || t.remoteBrowsePath || undefined;
  if (t.wsl) return t.wsl.path || undefined;
  return undefined;
}

function emitTabs() {
  // listTabs() includes RPC-backed tabs in the shared registry — exclude
  // them here; listRpcSessions() emits them with mode "rpc". Otherwise the
  // renderer gets the same tab twice (pty + rpc) and renders BOTH panes.
  const ptyTabs = listTabs().filter((t) => t.pty).map((t) => ({
    id: t.id,
    kind: t.kind,
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
    remoteDir: tabProjectDir(t),
    remoteAgentDir: t.remote?.agentDir,
    sshState: t.sshState,
    remoteReady: t.remoteReady,
    mode: "pty" as const,
  }));
  const rpcTabs = listRpcSessions().map((s) => {
    const t = getTab(s.id);
    return {
      id: s.id,
      kind: t?.kind ?? "agent",
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
      remoteDir: tabProjectDir(t),
      remoteAgentDir: t?.remote?.agentDir,
      remoteReady: t?.remoteReady,
      pi: true,
      mode: "rpc" as const,
    };
  });
  const sdkTabs = listSdkTabs().map((s) => {
    const t = getTab(s.tabId);
    return {
      id: s.tabId,
      cwd: t?.cwd ?? "",
      sessionPath: t?.sessionPath,
      title: t?.title ?? "",
      isRemote: false,
      remoteKey: undefined,
      remoteHost: undefined,
      remoteUser: undefined,
      remotePort: 22,
      isWsl: false,
      wslDistro: undefined,
      pi: true,
      mode: "sdk" as const,
    };
  });
  mainWindow?.webContents.send("tabs:update", [...ptyTabs, ...rpcTabs, ...sdkTabs]);
}

// pty.ts watches local session files and bumps tab titles; keep the renderer
// in sync whenever that happens (also covers remote SFTP title sync below).
onTabsChanged(() => emitTabs());

function emitActive() {
  const t = getActiveTab();
  if (t) {
    const cwd = t.wsl ? (t.wsl.path || "~") : t.remote ? (t.remoteBrowsePath || t.remote.path || "~") : t.cwd;
    // Select the profile before consulting the cache. Otherwise the first
    // activation after switching profiles can briefly expose the previous
    // profile's local sessions.
    if (!t.remote && !t.wsl) sessionIndex.setAgentDir(agentDir());
    // Attach a warm cached session list for local tabs so the renderer can
    // skip the session:list round-trip entirely (see SessionIndex.cached).
    // (WSL lists reach the renderer through session:remote-updated instead;
    // the renderer's isRemote activation branch doesn't consume sessions.)
    const sessions = t.remote || t.wsl ? undefined : sessionIndex.cached(sessionTargetForTab(t), cwd);
    mainWindow?.webContents.send("tabs:active", {
      id: t.id,
      cwd,
      isRemote: !!(t.remote || t.wsl),
      sessions: sessions ?? undefined,
    });
    if (t.remote) {
      stopWatching();
      stopSessionsPoll();
    } else if (t.wsl) {
      // WSL: no local fs.watch (the cwd is a dummy local path); the 4s poll
      // reads the distro's session dir through the SessionIndex seam.
      stopWatching();
      startSessionsPoll(sessionTargetForTab(t), cwd);
    } else {
      sessionIndex.setAgentDir(agentDir());
      startWatching(t.cwd, agentDir());
      startSessionsPoll(localTarget(), t.cwd);
    }
    return;
  }
  stopWatching();
  stopSessionsPoll();
  mainWindow?.webContents.send("tabs:active", { id: null, cwd: "", isRemote: false });
}

// Windows 任务栏图标归属：没有 AppUserModelID 时 dev 模式的 electron.exe
// 会归到 Electron 组、图标显示为默认（用户反馈"图标小/不正常"）。
// 必须在 ready 之前设置。
if (process.platform === "win32") {
  app.setAppUserModelId("com.pipi.desktop");
}

// Single-instance lock: a second launch must focus the existing window, not
// spawn a second main process (two instances would both poll sessions and
// fight over the SFTP lease pool).
/** Memory trend logging. The main process hosts the pre-warmed pi SDK worker
 *  (a worker_thread counts toward this process), the remote session/tree
 *  caches and every open tab's stream buffers; when users report "the machine
 *  lags / this app eats RAM" the numbers must be on disk, not guessed. Two
 *  minutes apart is enough for a trend without flooding the log. */
function logMemory(tag: string): void {
  try {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1048576);
    debugLog(
      "mem",
      `${tag} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB`,
    );
  } catch {
    /* logging must never break the app */
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
  logMemory("startup");
  const memTimer = setInterval(() => logMemory("tick"), 120_000);
  memTimer.unref?.();
  // Ship app-bundled pi extensions (static working indicator etc.) BEFORE any
  // tab can spawn pi, so every pi process auto-discovers them. The returned
  // list of actually-written files feeds the chat-page update notice.
  pendingExtensionSync = ensureShippedExtensions();
  if (pendingExtensionSync.length > 0) {
    console.log(`[extensions] updated: ${pendingExtensionSync.join(", ")}`);
  }

  // Pre-warm the SDK worker in the background (if enabled) so the FIRST local
  // tab open doesn't pay the ~1.1s SDK import; model runtime infra initializes
  // lazily on first open but the module graph is already hot.
  if (sdkBackendEnabled()) {
    // The pi SDK worker is NOT pre-warmed at startup any more: it is a
    // worker_thread (memory charged to the main process) loading the bundled
    // pi SDK + model runtime, and only a LOCAL tab switching to the chat view
    // needs it. It starts on first use instead — see the SDK branch of
    // tab:create — so remote-only work never pays for it.
    logMemory("startup");
  }

  // Extension UI sub-protocol → forwarded to the renderer, which renders
  // select/confirm/input/editor as native dialogs (UiDialog in ChatPane) and
  // answers via tab:rpc-ui-response.
  setUiRequestHandler((tabId, req) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:rpc-ui-request:${tabId}`, req);
    }
  });
  {
    setSdkUiRequestHandler((tabId, req) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(`tab:rpc-ui-request:${tabId}`, req);
      }
    });
  }

  // Renderer answers for extension UI dialogs (value/confirmed/cancelled).
  ipcMain.handle("tab:rpc-ui-response", (_e, tabId: string, response: Record<string, unknown>) => {
    if (getSdkTab(tabId)) return sdkUiResponse(tabId, response);
    return getRpcSession(tabId)?.send({ type: "extension_ui_response", ...response }) ?? false;
  });

  // Forward SessionIndex change events to the renderer. Local lists go to
  // session:local-updated (live sidebar counts); WSL lists reuse the
  // session:remote-updated channel (tabId of the polled WSL tab, so the
  // sidebar's distro matching and blank-tab linking keep working) — only
  // emitted when the session FILE SET changed, mirroring the remote rule:
  // mtime drift on an actively-written session must not flash the list.
  // File-set comparison lives in the consumer (sameSessionPaths), not in
  // the module: local consumers need every change, WSL consumers don't.
  sessionIndex.onAnyChange((target, cwd, sessions) => {
    if (target.kind === "wsl") {
      const tab = resolveWslEventTab(target, cwd);
      if (!tab) return;
      // Dedup per (distro, cwd): two projects of one distro poll
      // independently; mtime drift on one must not suppress the other.
      const dedupKey = `${target.distro} ${cwd}`;
      const prev = wslLastEmittedSessions.get(dedupKey);
      if (prev && sameSessionPaths(prev, sessions)) {
        syncRemoteTabTitles(tab.id, cwd, sessions);
        return;
      }
      wslLastEmittedSessions.set(dedupKey, sessions);
      emitRemoteSessionsUpdated({ tabId: tab.id, remoteCwd: cwd, sessions });
      return;
    }
    mainWindow?.webContents.send("session:local-updated", { cwd, sessions });
  });

  // --- pi agent install (manual only, from the renderer's notice bar) ----
  // `installInFlight` guards double installs when the user opens two tabs
  // while the local copy install is still running.
  let installInFlight: Promise<{ ok: boolean }> | null = null;

  function sendInstallEvent(channel: string, payload: unknown): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  /**
   * Install the global pi from the app's bundled copy (plain directory copy
   * + shim write — no npm, no network, seconds). Streams begin/result events
   * so the renderer's progress dialog shows the outcome.
   */
  async function runLocalPiInstall(): Promise<{ ok: boolean }> {
    if (installInFlight) return installInFlight;
    installInFlight = (async () => {
      sendInstallEvent("pi-install:begin", {});
      const r = await installGlobalPiFromBundled();
      sendInstallEvent("pi-install:result", { ok: r.ok, error: r.ok ? undefined : r.error, cancelled: false });
      return r.ok ? { ok: true } : { ok: false };
    })();
    try {
      return await installInFlight;
    } finally {
      installInFlight = null;
    }
  }

  ipcMain.handle("pi-install:cancel", () => {
    // Local copy installs finish in seconds and are not cancellable; kept
    // as a no-op so the renderer's cancel button never throws.
  });

  /**
   * Manual "install the global pi" action (from the renderer's notice bar;
   * never auto-triggered). On success, drop the stale detection caches and
   * re-warm so the freshly installed binary is picked up.
   */
  ipcMain.handle("pi-install:run", async (): Promise<{ ok: boolean }> => {
    const install = await runLocalPiInstall();
    if (install.ok) {
      invalidatePiDetection();
      warmPiDetection();
    }
    return install;
  });

  async function ensurePiReady(): Promise<{ ok: true; backend: "global" | "bundled-install" | "missing" }> {
    // A missing/broken global pi must never block a local tab: we can
    // re-install it locally from the app's bundled copy (plain directory
    // copy + shim write — no npm, no network), which also gives users the
    // `pi` command inside the terminal's shell.
    if (hasGlobalPiInstalled() || process.env.PI_CODING_AGENT === "true") {
      return { ok: true, backend: "global" };
    }
    // Authoritative re-check (bypass the startup-warm TTL cache) so a
    // transient warm-time failure doesn't trigger a needless reinstall.
    invalidatePiDetection();
    if (hasGlobalPiInstalled() || process.env.PI_CODING_AGENT === "true") {
      return { ok: true, backend: "global" };
    }
    // Reuse runLocalPiInstall: it streams begin/result events for the
    // renderer's progress dialog AND guards against a concurrent manual
    // install (double installs must never run).
    const installed = await runLocalPiInstall();
    if (installed.ok) {
      console.log("[pi-detect] global pi missing — auto-installed from bundled copy");
      invalidatePiDetection();
      if (hasGlobalPiInstalled() || process.env.PI_CODING_AGENT === "true") {
        return { ok: true, backend: "bundled-install" };
      }
    }
    console.warn("[pi-detect] global pi unavailable and auto-install failed");
    // Non-blocking notice (renderer shows it); no blocking install dialog.
    sendInstallEvent("pi-install:notice", { backend: "missing" });
    return { ok: true, backend: "missing" };
  }

  // --- Terminal / tabs ---
  ipcMain.handle("tab:create", async (_e, opts: { cwd: string; sessionPath?: string; continueRecent?: boolean; remote?: { host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean; agentDir?: string }; wsl?: { distro: string; path?: string }; themeMode?: ThemeMode }) => {
    // Default view is the TERMINAL (pty TUI) for all pi tabs — local, WSL,
    // and remote. The chat view is now opt-in (TabBar「聊天视图」): local
    // tabs switch to the in-process SDK backend, WSL/remote switch to
    // `pi --mode rpc`. Only plain-shell connection tabs (startPi:false)
    // skip pi entirely — they are createTab too, with a bare shell.
    // Local tabs: ensurePiReady never blocks — the bundled pi is the
    // fallback, so tabs always open. WSL/remote run pi INSIDE the
    // distro/remote host, so the local machine's pi is irrelevant.
    if (!opts.remote && !opts.wsl) {
      await ensurePiReady();
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
    // Validate the optional per-user remote data dir (keeps sessions/models
    // isolated when several people share one SSH account). Invalid values are
    // dropped silently — the remote falls back to ~/.pi/agent.
    if (opts.remote?.agentDir) {
      const clean = sanitizeRemoteAgentDir(opts.remote.agentDir);
      opts.remote = { ...opts.remote, agentDir: clean ?? undefined };
    }
    // Chat is the default for pi sessions: local tabs use the in-process SDK
    // when enabled; WSL/SSH use RPC inside their target OS. Plain SSH
    // connection tabs (startPi:false) remain real terminal shells. Low-level
    // createTab() remains the explicit terminal/recovery primitive.
    const plainShell = opts.remote?.startPi === false;
    let id: string;
    if (plainShell) {
      id = createTab(opts);
    } else if (opts.remote || opts.wsl) {
      id = createRpcTab(opts);
    } else if (sdkBackendEnabled()) {
      // First use starts the worker (and warms the SDK/model runtime in it).
      ensureSdkWorkerStarted(agentDir());
      id = openSdkSession({ ...opts, agentDir: agentDir() });
      logMemory("sdk-worker-start");
    } else {
      id = createRpcTab(opts);
    }
    // Remote provisioning runs in the BACKGROUND — never block tab
    // appearance on an SFTP round-trip (a dead/unreachable server used to
    // delay the terminal by up to the 15s SFTP timeout). Best-effort: the
    // running pi picks the synced theme/extension up next session.
    // Extensions are content-digest-gated per server (same pattern as
    // syncKeyAuthExtensions): an app update changes the digest and re-syncs
    // on the next connect; reconnects with unchanged shipped content skip
    // the SFTP round-trip entirely — it used to do 3 gets + puts on EVERY
    // password connect, exactly when the user first expands sessions.
    if (opts.remote?.password) {
      const syncKey = stableRemoteKey(opts.remote);
      const lastSync = remoteThemeSyncAt.get(syncKey) ?? 0;
      const themeDue = Date.now() - lastSync > REMOTE_THEME_SYNC_TTL_MS;
      const extDigest = createHash("sha256")
        .update(SHIPPED_EXTENSIONS.map((e) => e.content).join("\u0000"))
        .digest("hex");
      const remote = opts.remote; // narrowed for the async closure
      void (async () => {
        try {
          if (!themeDue && remoteKeyExtSyncHash.get(syncKey) === extDigest) return;
          const lease = await getSftpLease(remote);
          if (themeDue) {
            const result: RemoteThemeSyncResult = await syncThemesViaSftp(lease.client, lease.homeDir, remote.agentDir);
            if (result.ok) {
              remoteThemeSyncAt.set(syncKey, Date.now());
              console.log(`[theme] remote synced ${result.uploaded.length} file(s) -> ${syncKey}`);
            } else {
              console.error(`[theme] remote sync partial/failed (${syncKey}):`, result.error ?? "unknown");
            }
          }
          if (remoteKeyExtSyncHash.get(syncKey) !== extDigest) {
            const extResult = await syncExtensionsViaSftp(lease.client, lease.homeDir, remote.agentDir);
            if (extResult.ok) {
              remoteKeyExtSyncHash.set(syncKey, extDigest);
              console.log(`[extensions] remote synced ${extResult.uploaded.length} file(s) -> ${syncKey}`);
            } else {
              console.error(`[extensions] remote sync partial/failed (${syncKey}):`, extResult.error ?? "unknown");
            }
          }
          lease.lastUsedAt = Date.now();
        } catch (error) {
          console.error(`[remote] provisioning failed (${syncKey}):`, error);
        }
      })();
    }
    // Key-auth remotes: no SFTP credentials, but ssh.exe already carries the
    // session — ship extensions over a BatchMode ssh (fails fast if the
    // server actually needs a password). Same "connect → provision" timing
    // as the password path; content-digest gate keeps reconnects free.
    if (opts.remote && !opts.remote.password) {
      syncKeyAuthExtensions(opts.remote);
    }
    // WSL: same extension provisioning, via the \\wsl$ UNC filesystem.
    // (Theme sync deliberately skips WSL — the distro keeps its own settings;
    // extensions are needed for the tree-nav bridge, so ship them regardless.)
    if (opts.wsl) {
      void syncWslExtensions(opts.wsl.distro);
    }
    // Persist the server NODE (host/user/port/path) so it survives restarts,
    // but never a password: password persistence is opt-in via the UI's
    // "记住密码" checkbox. saveRemoteHistory is non-destructive, so this keeps
    // any already-remembered credential while adding none.
    if (opts.remote) saveRemoteHistory({ ...opts.remote, password: undefined });
    emitTabs();
    emitActive();
    return id;
  });
  // App-owned theme mode; the renderer reports its dark/light toggle so
  // every new pty (local + remote) renders with the app's choice. Live
  // switching of a RUNNING pi is driven by the renderer pushing pi's native
  // terminal color-scheme report (CSI ?997 n) through the pty — see
  // TerminalPane. The theme files stay canonical; no rewrite on toggle.

  ipcMain.handle("theme:set-mode", (_e, mode: ThemeMode) => {
    setThemeMode(mode);
    return true;
  });
  ipcMain.handle("tab:close", async (_e, id: string) => {
    // SDK tabs are owned by chat-backend/sdk-host; RPC tabs by rpc-session;
    // pty tabs by pty.ts.
    const tab = getTab(id);
    const remote = tab?.remote;
    if (getSdkTab(id)) {
      closeSdkTab(id);
    } else if (getRpcSession(id)) {
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
  // Input is a hot path. Unlike invoke/handle, send/on has no Promise and no
  // reply IPC for every key, so renderer event-loop pressure cannot build up
  // while pi is repainting its TUI or emitting a lot of terminal output.
  ipcMain.on("tab:input", (_e, id: string, data: string) => {
    if (typeof id === "string" && typeof data === "string") writeTab(id, data);
  });
  ipcMain.handle("tab:resize", (_e, id: string, cols: number, rows: number) => resizeTab(id, cols, rows));
  ipcMain.handle("tab:list", () => [
    ...listTabs().filter((t) => t.pty).map((t) => ({
      id: t.id, kind: t.kind, cwd: t.cwd, sessionPath: t.sessionPath, title: t.title,
      isRemote: !!(t.remote || t.wsl),
      isWsl: !!t.wsl,
      wslDistro: t.wsl?.distro,
      remoteDir: tabProjectDir(t),
      pi: t.remote ? t.remote.startPi !== false : true,
      sshState: t.sshState,
      mode: "pty" as const,
    })),
    ...listRpcSessions().map((s) => {
      const t = getTab(s.id);
      return {
        id: s.id,
        kind: t?.kind ?? "agent",
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
        remoteDir: tabProjectDir(t),
        // Parity with emitTabs' rpc mapping: a renderer reload while remote
        // sessions are live must still see the profile's agentDir (the
        // model-config hot-sync scoping and remote history keys read it).
        remoteAgentDir: t?.remote?.agentDir,
        pi: true,
        mode: "rpc" as const,
      };
    }),
    ...listSdkTabs().map((s) => {
      const t = getTab(s.tabId);
      return {
        id: s.tabId,
        kind: t?.kind ?? "agent",
        cwd: t?.cwd ?? "",
        sessionPath: t?.sessionPath,
        title: t?.title ?? "",
        isRemote: false,
        isWsl: false,
        pi: true,
        mode: "sdk" as const,
      };
    }),
  ]);

  // --- File tree + viewer (left/right panels) ---
  ipcMain.handle("file:list", async (_e, payload?: TargetRef & { dirPath?: string; rootPath?: string; noCache?: boolean }) => {
    const t = resolveTarget(payload);
    const dirPath = payload?.dirPath;
    // rootPath = explicit LOCAL preview root (sidebar project click). It is
    // authoritative: never route it through a remote/WSL tab even if one is
    // active — previews browse the local filesystem, period.
    if (!payload?.rootPath) {
      if (t?.wsl) {
        const targetDir = dirPath ?? payload?.rootPath ?? t.wsl.path ?? "~";
        const resolved = resolveWslPath(t.wsl.distro, targetDir);
        const cacheKey = `wsl:${t.wsl.distro}:${resolved}`;
        if (!payload?.noCache) {
          const cached = getCachedRemoteFileTree(cacheKey);
          if (cached) return cached;
        }
        return setCachedRemoteFileTree(cacheKey, await wslListFiles(t.wsl.distro, resolved));
      }
      if (t?.remote) {
        const targetDir = dirPath ?? payload?.rootPath ?? t.remoteBrowsePath ?? t.remote.path ?? "~";
        const cacheKey = remoteFileTreeCacheKey(t.remote, targetDir);
        if (!payload?.noCache) {
          const cached = getCachedRemoteFileTree(cacheKey);
          if (cached) return cached;
        }
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
    if (payload?.noCache) return fileTreeIndex.refresh(localTreeKey(root, "."), () => listDirChildren(root, "."));
    const cachedTree = fileTreeIndex.cached(localTreeKey(root, "."));
    if (cachedTree) return cachedTree;
    return fileTreeIndex.refresh(localTreeKey(root, "."), () => listDirChildren(root, "."));
  });

  /** List one directory's children for the shared lazy file tree. Local paths
   *  are root-relative; remote/WSL paths are absolute Linux paths. Each
   *  adapter returns directories with `children: undefined`, meaning they can
   *  be expanded in place instead of replacing the current tree root. */
  ipcMain.handle("file:list-dir", async (_e, payload?: TargetRef & { rootPath?: string; relDir: string; noCache?: boolean }) => {
    const t = resolveTarget(payload);
    if (!payload?.rootPath && t?.wsl && payload?.relDir) {
      const resolved = resolveWslPath(t.wsl.distro, payload.relDir);
      const cacheKey = `wsl:${t.wsl.distro}:${resolved}`;
      if (!payload?.noCache) {
        const cached = getCachedRemoteFileTree(cacheKey);
        if (cached) return cached;
      }
      return setCachedRemoteFileTree(cacheKey, await wslListFiles(t.wsl.distro, resolved));
    }
    if (!payload?.rootPath && t?.remote && payload?.relDir) {
      const cacheKey = remoteFileTreeCacheKey(t.remote, payload.relDir);
      if (!payload?.noCache) {
        const cached = getCachedRemoteFileTree(cacheKey);
        if (cached) return cached;
      }
      return setCachedRemoteFileTree(cacheKey, await remoteListFiles(t.remote, payload?.relDir));
    }
    const root = payload?.rootPath ?? t?.cwd;
    if (!root || !payload?.relDir) return [];
    const key = localTreeKey(root, payload.relDir);
    if (!payload.noCache) {
      const cached = fileTreeIndex.cached(key);
      if (cached) return cached;
    }
    return fileTreeIndex.refresh(key, () => listDirChildren(root, payload.relDir));
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

  /** Returns the actual remote command/cwd and its stdout/stderr for support.
   * Deliberately bounded to 8 KB so diagnostic data cannot freeze the UI. */
  ipcMain.handle("file:diagnose-mentions", async (_e, payload: { tabId?: string }) => {
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    if (!t) return { report: "@file diagnose\ntab unavailable", error: "tab unavailable" };
    const kind = t.remote ? "SSH" : t.wsl ? "WSL" : "local";
    if (!t.remote) return { report: `@file diagnose\nkind: ${kind}\ntab cwd: ${t.wsl?.path ?? t.cwd}\nUse the local/WSL search path; no SSH diagnostic required.` };
    const remote = t.remote;
    const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const shellCwd = (value: string) => value === "~" ? '"$HOME"' : value.startsWith("~/") ? `"$HOME"/${sq(value.slice(2))}` : sq(value);
    const command = `printf 'pwd='; pwd; printf '\\nHOME=%s\\n' "$HOME"; command -v fd || true; find . -path './.git' -prune -o -mindepth 1 -maxdepth 2 -print | head -n 20`;
    const remoteCommand = `cd -- ${shellCwd(remote.path || "~")} && ${command}`;
    try {
      let stdout = ""; let stderr = ""; let code: number | null = null;
      if (remote.password) {
        await new Promise<void>((resolve, reject) => {
          const conn = new SshClient();
          conn.on("ready", () => conn.exec(remoteCommand, (err, stream) => {
            if (err) { reject(err); return; }
            stream.setEncoding("utf8"); stream.stderr?.setEncoding("utf8");
            stream.on("data", (data: string) => { stdout += data; }); stream.stderr?.on("data", (data: string) => { stderr += data; });
            stream.on("close", (exit: number | undefined) => { code = exit ?? 0; conn.end(); resolve(); });
          }));
          conn.on("error", reject);
          conn.connect({ host: remote.host, port: remote.port ?? 22, username: remote.user, password: remote.password, readyTimeout: 10000 });
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(findSshBin(), ["-p", String(remote.port ?? 22), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `${remote.user}@${remote.host}`, remoteCommand]);
          child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
          child.stdout.on("data", (data: string) => { stdout += data; }); child.stderr.on("data", (data: string) => { stderr += data; });
          child.on("close", (exit) => { code = exit; resolve(); }); child.on("error", reject);
        });
      }
      const report = [`@file diagnose`, `kind: SSH`, `target: ${remote.user}@${remote.host}:${remote.port ?? 22}`, `configured cwd: ${remote.path || "~"}`, `command: ${remoteCommand}`, `exit: ${code}`, "--- stdout ---", stdout.slice(0, 8192) || "(empty)", "--- stderr ---", stderr.slice(0, 8192) || "(empty)"].join("\n");
      return { report, ...(code === 0 ? {} : { error: `remote command exited ${code}` }) };
    } catch (e) {
      return { report: `@file diagnose\nkind: SSH\ntarget: ${remote.user}@${remote.host}:${remote.port ?? 22}\nconfigured cwd: ${remote.path || "~"}\nerror: ${e instanceof Error ? e.message : String(e)}`, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Query-driven, Pi-like @file search. It uses fd on the machine where the
   * agent runs (and falls back to find when fd is absent), so candidates are
   * not limited by a browser-side recursive index. */
  ipcMain.handle("file:search-mentions", async (_e, payload: { tabId?: string; query?: string }) => {
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    if (!t) return { files: [], error: "tab unavailable" };
    const query = (payload?.query ?? "").replace(/[\r\n\0]/g, "").slice(0, 240);
    const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    // Shell single-quoting a literal `~` prevents home expansion. Remote and
    // WSL projects commonly use `~` / `~/project`, so turn those forms into
    // an explicit $HOME expression before constructing `cd`.
    const shellCwd = (value: string) => value === "~" ? '"$HOME"' : value.startsWith("~/") ? `"$HOME"/${sq(value.slice(2))}` : sq(value);
    const parse = (output: string) => output.split("\n").filter(Boolean).slice(0, 100).map((line) => ({
      path: line.endsWith("/") ? line.slice(0, -1) : line,
      type: line.endsWith("/") ? "directory" as const : "file" as const,
    }));
    const shell = `if command -v fd >/dev/null 2>&1; then fd --hidden --follow --exclude .git --max-results 100 --type f --type d ${query ? sq(query) : ""}; else find . -path './.git' -prune -o -path './.git/*' -prune -o -mindepth 1 \( -type d -printf '%P/\\n' -o -type f -printf '%P\\n' \) | ${query ? `grep -i -F -- ${sq(query)}` : "cat"} | head -n 100; fi`;
    // Windows-local projects use Windows cwd paths. Running `bash -lc cd
    // D:\\...` is invalid and previously made their result set always empty.
    const localSearch = async () => {
      const needle = query.toLocaleLowerCase();
      const files: Array<{ path: string; type: "file" | "directory" }> = [];
      const walk = async (dir: string, rel: string): Promise<void> => {
        if (files.length >= 100) return;
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (files.length >= 100 || entry.name === ".git") continue;
          if (!entry.isDirectory() && !entry.isFile()) continue;
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          const type = entry.isDirectory() ? "directory" as const : "file" as const;
          if (!needle || path.toLocaleLowerCase().includes(needle)) files.push({ path, type });
          if (entry.isDirectory()) await walk(join(dir, entry.name), path);
        }
      };
      await walk(t.cwd, "");
      return files;
    };
    try {
      let stdout = "";
      if (t.remote) {
        // Do not create a second SSH shell just for completion. It has a
        // different startup environment from the live pi process (notably
        // PATH/fd availability) and failures looked like "no matches". The
        // Search through SFTP, but fan out each directory level in parallel.
        // The old depth-first walk made an SSH round-trip per directory, so a
        // match in a second-level directory waited behind every sibling.
        const remote = t.remote;
        const needle = query.toLocaleLowerCase();
        const files: Array<{ path: string; type: "file" | "directory" }> = [];
        await withSftp(remote, async (client, homeDir) => {
          const root = resolveRemotePath(remote.path || "~", homeDir);
          let pending: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
          const maxDepth = 32;
          while (pending.length && files.length < 100) {
            const level = pending;
            pending = [];
            const listings = await Promise.all(level.map(async (dir) => {
              try { return { dir, entries: await client.list(dir.abs) }; } catch { return { dir, entries: [] as Awaited<ReturnType<typeof client.list>> }; }
            }));
            for (const { dir, entries } of listings) {
              const depth = dir.rel ? dir.rel.split("/").length : 0;
              for (const entry of entries) {
                if (files.length >= 100 || entry.name === "." || entry.name === ".." || entry.name === ".git") continue;
                const path = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
                const type = entry.type === "d" ? "directory" as const : "file" as const;
                if (!needle || path.toLocaleLowerCase().includes(needle)) files.push({ path, type });
                if (entry.type === "d" && depth < maxDepth) pending.push({ abs: posixPath.join(dir.abs, entry.name), rel: path });
              }
            }
          }
        });
        return { files };
      } else if (t.wsl) {
        stdout = await new Promise<string>((resolve, reject) => {
          const child = spawn("wsl.exe", ["-d", t.wsl!.distro, "--", "bash", "-lc", `cd -- ${shellCwd(t.wsl!.path || "~")} && ${shell}`]);
          let out = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (data: string) => { out += data; });
          child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`wsl exited ${code}`))); child.on("error", reject);
        });
      } else {
        return { files: await localSearch() };
      }
      return { files: parse(stdout) };
    } catch (e) {
      return { files: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** Legacy bounded project index used by the file tree. */
  ipcMain.handle("file:list-mentions", async (_e, payload: { tabId?: string }) => {
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    if (!t) return { files: [], error: "tab unavailable" };
    const files: Array<{ path: string; type: "file" | "directory" }> = [];
    const ignored = new Set([".git", "node_modules", "dist", "build", ".next", ".cache"]);
    const limit = 2_000;
    const walk = async (dir: string, rel: string, list: (p: string) => Promise<Array<{ name: string; type: "file" | "directory" }>>) => {
      if (files.length >= limit) return;
      let entries: Array<{ name: string; type: "file" | "directory" }>;
      try { entries = await list(dir); } catch { return; }
      for (const entry of entries) {
        if (files.length >= limit || ignored.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".gitignore") continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        files.push({ path: childRel, type: entry.type });
        if (entry.type === "directory" && childRel.split("/").length < 9) await walk(`${dir}/${entry.name}`, childRel, list);
      }
    };
    try {
      if (t.remote) {
        const remote = t.remote;
        await withSftp(remote, async (client, homeDir) => {
          const root = resolveRemotePath(remote.path ?? "~", homeDir);
          await walk(root, "", async (dir) => (await client.list(dir)).flatMap((item: { name: string; type: string }) =>
            item.name === "." || item.name === ".." ? [] : [{ name: item.name, type: item.type === "d" ? "directory" as const : "file" as const }],
          ));
        });
      } else if (t.wsl) {
        const wsl = t.wsl;
        const root = resolveWslPath(wsl.distro, wsl.path || "~");
        await walk(root, "", async (dir): Promise<Array<{ name: string; type: "file" | "directory" }>> =>
          (await readdir(wslToWinPath(wsl.distro, dir), { withFileTypes: true }))
            .flatMap((item): Array<{ name: string; type: "file" | "directory" }> => item.isDirectory() ? [{ name: item.name, type: "directory" }] : item.isFile() ? [{ name: item.name, type: "file" }] : []));
      } else {
        await walk(t.cwd, "", async (dir): Promise<Array<{ name: string; type: "file" | "directory" }>> =>
          (await readdir(dir, { withFileTypes: true }))
            .flatMap((item): Array<{ name: string; type: "file" | "directory" }> => item.isDirectory() ? [{ name: item.name, type: "directory" }] : item.isFile() ? [{ name: item.name, type: "file" }] : []));
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { files, ...(files.length >= limit ? { error: `仅显示前 ${limit} 个文件` } : {}) };
    } catch (e) {
      return { files: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("file:read", async (_e, payload: TargetRef & { rootPath?: string; relPath: string; mention?: boolean }) => {
    const t = resolveTarget(payload);
    const relPath = payload.relPath;
    // Local preview root is authoritative (see file:list).
    if (!payload.rootPath) {
      if (t?.wsl) {
        try {
          return await readPreviewFromAbs(wslFullPath(t, relPath), relPath);
        } catch (err) {
          return { content: `⚠️ 读取失败: ${err instanceof Error ? err.message : String(err)}`, bytes: 0, isBinary: false, error: String(err) };
        }
      }
      if (t?.remote) {
        // @-mentions always address the tab's project cwd, never the mutable
        // file-browser directory. This also enforces a project-root boundary.
        return remoteReadFile(t.remote, relPath, t.remote.path ?? "~", !!payload.mention);
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
    ref: TargetRef | undefined,
    relPath: string,
    fn: (t: TabInfo) => Promise<void> | void
  ): Promise<FileMutationResult> {
    const bad = validateRel(relPath);
    if (bad) return { ok: false, error: bad };
    const t = resolveTarget(ref);
    if (!t) return { ok: false, error: "找不到终端会话" };
    try {
      await fn(t);
      if (t.remote) invalidateRemoteFileTree(t.remote);
      else if (t.wsl) invalidateWslFileTree(t.wsl.distro);
      else invalidateLocalParent(t.cwd ?? process.cwd(), relPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Invalidate the cached listings that a mutation can have changed.
   *  With lazy per-dir caching, the DIRECTORY holding `relPath` changed — plus
   *  its ancestor chain (recursive mkdir/write creates intermediates, so the
   *  root and every level in between may have gained an entry). */
  function invalidateLocalParent(root: string, relPath: string): void {
    let cur = dirname(relPath);
    while (cur !== ".") {
      fileTreeIndex.invalidate(localTreeKey(root, cur));
      cur = dirname(cur);
    }
    fileTreeIndex.invalidate(localTreeKey(root, "."));
  }

  /** Cache key for a local dir listing: ROOT-aware — listings carry paths
   *  relative to their root, so keying by the absolute dir alone would let
   *  the same dir browsed under two roots serve wrong-relative paths. */
  function localTreeKey(root: string, relDir: string): string {
    return `${root}\u0000${relDir}`;
  }

  /** Local mutations in preview mode resolve against rootPath, not the tab cwd. */

  ipcMain.handle("file:write", async (_e, payload: TargetRef & { rootPath?: string; relPath: string; content: string }) => {
    const relPath = payload.relPath;
    const content = payload.content ?? "";
    // Local preview root is authoritative; needs no tab at all.
    if (payload.rootPath) {
      const r = await writeFileContent(payload.rootPath, relPath, content);
      if (r.ok) invalidateLocalParent(payload.rootPath, relPath);
      return r;
    }
    return mutateFile(payload, relPath, async (t) => {
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

  ipcMain.handle("file:mkdir", async (_e, payload: TargetRef & { rootPath?: string; relPath: string }) => {
    const relPath = payload.relPath;
    if (payload.rootPath) {
      const r = await createDirectory(payload.rootPath, relPath);
      if (r.ok) invalidateLocalParent(payload.rootPath, relPath);
      return r;
    }
    return mutateFile(payload, relPath, async (t) => {
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

  ipcMain.handle("file:delete", async (_e, payload: TargetRef & { rootPath?: string; relPath: string }) => {
    const relPath = payload.relPath;
    if (payload.rootPath) {
      const r = await deletePath(payload.rootPath, relPath);
      if (r.ok) invalidateLocalParent(payload.rootPath, relPath);
      return r;
    }
    return mutateFile(payload, relPath, async (t) => {
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

  ipcMain.handle("file:rename", async (_e, payload: TargetRef & { rootPath?: string; relPath: string; newName: string }) => {
    const relPath = payload.relPath;
    const newName = (payload.newName ?? "").trim();
    if (payload.rootPath) {
      const r = await renamePath(payload.rootPath, relPath, newName);
      if (r.ok) invalidateLocalParent(payload.rootPath, relPath);
      return r;
    }
    return mutateFile(payload, relPath, async (t) => {
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

  /** Reveal a file/folder in the OS file explorer (tree right-click →
   *  "打开文件所在位置"). LOCAL + WSL only: local nodes resolve against the
   *  tab cwd / preview root; WSL nodes map to \\wsl$\ UNC paths via
   *  wslFullPath (same helper WSL file ops use, with its escape guard).
   *  SSH nodes live on a remote disk — the renderer never offers the action
   *  for those origins, and the handler refuses them anyway (rootPath =
   *  explicit local preview root, tab route = non-remote or WSL tab only). */
  ipcMain.handle("file:reveal", (_e, payload?: TargetRef & { rootPath?: string; relPath?: string }) => {
    const relPath = payload?.relPath ?? "";
    // Tree node paths are posix root-relative and never contain NUL. Same
    // containment the sibling local ops enforce (resolveWithin) — this also
    // stops backslash-encoded "..\.." escapes on Windows and absolute/UNC
    // second arguments, which a segment filter alone would miss.
    if (!relPath || relPath.includes("\0")) return { ok: false, error: "无效路径" };
    let abs: string;
    if (payload?.rootPath) {
      // Explicit local preview root is authoritative: never route it through
      // a remote/WSL tab even if one is active (same rule as file:list).
      try {
        abs = resolveWithin(payload.rootPath, relPath);
      } catch {
        return { ok: false, error: "路径越界，无法定位" };
      }
    } else {
      const t = resolveTarget(payload);
      if (!t) return { ok: false, error: "找不到该文件所属的会话" };
      if (t.remote) return { ok: false, error: "远程文件不支持在系统资源管理器中定位" };
      try {
        abs = t.wsl
          ? wslFullPath(t, relPath)
          : resolveWithin(t.cwd ?? process.cwd(), relPath);
      } catch {
        return { ok: false, error: "路径越界，无法定位" };
      }
    }
    if (!existsSync(abs)) return { ok: false, error: "文件不存在（可能已被移动或删除）" };
    try {
      shell.showItemInFolder(abs);
    } catch {
      return { ok: false, error: "无法在资源管理器中定位该文件" };
    }
    return { ok: true };
  });

  /** Prove a server is reachable WITHOUT opening a tab: an ssh2 auth round
   *  strip plus an SFTP channel check (no shell, no pty, nothing for the user
   *  to look at). "ready" therefore means the DATA channel works, not merely
   *  that a shell could log in. `need-password` is the signal that drives the
   *  renderer's password dialog. */
  async function probeRemote(remote: RemoteOpts): Promise<{ status: "ready" | "need-password" | "failed"; error?: string }> {
    const auth = await remoteAuthOptions(remote);
    return new Promise((resolve) => {
      const conn = new SshClient();
      let settled = false;
      const finish = (result: { status: "ready" | "need-password" | "failed"; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          conn.end();
        } catch {
          /* already closed */
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: "failed", error: "连接超时（10s）" }), 12000);
      conn.on("ready", () => {
        // Auth passed — now prove the SFTP subsystem actually answers, so
        // "green" implies the sidebar can list sessions and files.
        conn.sftp((sftpErr, sftp) => {
          if (sftpErr) {
            finish({ status: "failed", error: `已登录但 SFTP 不可用：${sftpErr.message}` });
            return;
          }
          sftp.realpath(".", (pathErr: Error | undefined) => {
            finish(pathErr ? { status: "failed", error: `已登录但 SFTP 不可用：${pathErr.message}` } : { status: "ready" });
          });
        });
      });
      conn.on("error", (err: Error & { level?: string }) => {
        // With no saved password, ssh2 may report an unavailable Windows
        // agent instead of `client-authentication`. That still means the
        // profile has no usable credential and must open the password dialog.
        const authFailure = err.level === "client-authentication" || isSshAuthError(err);
        if (authFailure) {
          finish({
            status: "need-password",
            error: remote.password ? "认证失败（密码可能已变更）" : "需要输入 SSH 密码",
          });
          return;
        }
        finish({ status: "failed", error: err.message });
      });
      try {
        conn.connect({ host: remote.host, port: remote.port ?? 22, username: remote.user, readyTimeout: 10000, ...auth });
      } catch (err) {
        finish({ status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  ipcMain.handle("remote:probe", async (_e, remote: RemoteOpts) => {
    const result = await probeRemote(remote);
    debugLog("probe", `${remote.user}@${remote.host}:${remote.port ?? 22} -> ${result.status}${result.error ? ` (${result.error})` : ""}`);
    if (result.status === "ready") {
      rememberRemoteProfile(remote);
      // A fresh credential (or a recovered server) must clear the breaker,
      // otherwise the user's just-typed password would be refused for up to
      // the auth cooldown by the cache that already gave up.
      sftpFailures.delete(buildRemoteKey(remote));
      emitRemoteStatus(remote, "connected");
    } else if (result.status === "need-password") {
      emitRemoteStatus(remote, "disconnected", { needPassword: true, error: result.error });
    } else {
      emitRemoteStatus(remote, "failed", { error: result.error });
    }
    return { ...result, key: stableRemoteKey(remote) };
  });

  /** Persist a connection profile (password included) into remote-history.json
   *  so the next connect can skip the password dialog. Same store the
   *  tab-based connect path already writes on every connect. */
  ipcMain.handle("remote:save-history", (_e, remote: RemoteOpts) => {
    saveRemoteHistory(remote);
    // New credentials invalidate a previous auth failure immediately.
    if (remote.password) sftpFailures.delete(buildRemoteKey(remote));
    return listRemoteHistory();
  });

  ipcMain.handle("remote:set-browse-path", (_e, ref: string | TargetRef, path: string) => {
    const target = toTargetRef(ref);
    // Virtual target (explicit profile): no tab owns the browse path — the
    // renderer passes the directory on every read, so there is nothing to
    // persist here.
    if (!target?.tabId) return true;
    const tabId = target.tabId;
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
  ipcMain.handle("remote:get-browse-path", (_e, ref: string | TargetRef) => {
    const target = toTargetRef(ref);
    if (!target?.tabId) {
      const virtual = resolveTarget(target, false);
      if (!virtual) return null;
      return virtual.wsl ? (virtual.wsl.path || "~") : (virtual.remote?.path || "~");
    }
    const t = getTab(target.tabId);
    return t?.wsl ? (t.wsl.path || "~") : getRemoteBrowsePath(target.tabId);
  });
  ipcMain.handle("remote:get-info", (_e, ref: string | TargetRef) => {
    const t = resolveTarget(toTargetRef(ref), false);
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
      agentDir: t.remote.agentDir,
    };
  });

  ipcMain.handle("tab:alive", (_e, tabId: string) => {
    const tab = getTab(tabId);
    // Real pty tabs: alive means the underlying process is STILL RUNNING
    // (a crashed ssh.exe must not report connected). External tabs (RPC/SDK)
    // have no pty — registered is their liveness.
    if (tab?.pty) return isPtyTabAlive(tab);
    return !!getTab(tabId) || !!getRpcSession(tabId) || !!getSdkTab(tabId);
  });

  // Honest SSH connect state for connection shell tabs (startPi:false):
  // "ready" only after the remote __PIPI_READY__ marker (auth + shell up),
  // "failed" when ssh exited before the marker, "pending" while the session
  // is still establishing (may be waiting at a password prompt).
  ipcMain.handle("tab:conn-state", (_e, tabId: string) => {
    const t = getTab(tabId);
    if (!t) return { state: "gone" };
    if (!t.shellMode) return { state: "pending" }; // pi/WSL tabs: no marker
    if (t.sshState === "ready") return { state: "ready" };
    if (t.sshState === "failed" || (t.pty && !isPtyTabAlive(t))) return { state: "failed" };
    return { state: "pending" };
  });

  // --- RPC chat (local pi tabs) ---
  ipcMain.handle("tab:rpc-send", (_e, tabId: string, cmd: Record<string, unknown>) => {
    const sdk = getSdkTab(tabId);
    if (sdk) {
      const ok = sdkSend(tabId, cmd);
      debugLog("rpc-send", `tab ${tabId} ${String(cmd.type)} -> sdk ok=${ok}`);
      return ok;
    }
    const session = getRpcSession(tabId);
    const ok = session ? session.send(cmd) : false;
    debugLog("rpc-send", `tab ${tabId} ${String(cmd.type)} -> rpc ok=${ok} (session=${!!session})`);
    return ok;
  });
  // Renderer-side diagnostics (tree dialog actions) land in the same log file.
  ipcMain.on("debug:log", (_e, msg: unknown) => debugLog("renderer", String(msg ?? "")));
  // Session tree straight from the session file — the fast paint path for
  // the chat tree dialog. The RPC get_tree path can be slow while the
  // remote pi is still booting (or unresponsive if it died), but the
  // append-only JSONL is always readable: local disk, SFTP (password
  // remotes), \\wsl$ UNC. Falls back to the RPC path on any failure.
/** Newest .jsonl in a local/UNC dir (by mtime). Null when none/error. */
async function latestJsonlInDir(dir: string): Promise<string | null> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    try {
      const st = await stat(join(dir, f));
      if (!best || st.mtimeMs > best.mtime) best = { path: join(dir, f), mtime: st.mtimeMs };
    } catch {
      /* transient lock while pi appends */
    }
  }
  return best?.path ?? null;
}

/**
 * Locate the most recent session JSONL for a tab when tab.sessionPath is
 * missing (pi's get_state never resolved). Mirrors where pi stores sessions:
 * <agentDir>/sessions/<encodeCwd(cwd)>/. Key-auth remotes are skipped (would
 * need an ssh ls round-trip; rare combination) — they keep the RPC fallback.
 */
async function findRecentSessionFile(tab: TabInfo): Promise<string | null> {
  try {
    if (tab.wsl) {
      const home = await getWslHomeAsync(tab.wsl.distro);
      const cwd = resolveWslPath(tab.wsl.distro, tab.wsl.path || "~");
      const dir = join(wslToWinPath(tab.wsl.distro, home), ".pi", "agent", "sessions", encodeCwd(cwd));
      return await latestJsonlInDir(dir);
    }
    if (tab.remote) {
      if (!tab.remote.password) return null; // key-auth: no SFTP lease
      const lease = await getSftpLease(tab.remote);
      const cwd = resolveRemotePath(tab.remote.path ?? "~", lease.homeDir);
      const sessionDir = posixPath.join(remoteAgentDir(tab.remote, lease.homeDir), "sessions", encodeCwd(cwd));
      const list = (await lease.client.list(sessionDir)) as Array<{ name: string; type: string; modifyTime: number }>;
      lease.lastUsedAt = Date.now();
      scheduleSftpLeaseCleanup(lease);
      const newest = list
        .filter((f) => f.name.endsWith(".jsonl") && f.type !== "d")
        .sort((a, b) => (b.modifyTime ?? 0) - (a.modifyTime ?? 0))[0];
      return newest ? posixPath.join(sessionDir, newest.name) : null;
    }
    return await latestJsonlInDir(join(agentDir(), "sessions", encodeCwd(tab.cwd)));
  } catch (e) {
    console.error("[tree] findRecentSessionFile failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** The session-file location for a tab — the ONE place a tab's fields are
 *  mapped onto the reader's channel rule (see session-file-reader.ts). */
function sessionFileTargetOf(tab: TabInfo): SessionFileTarget {
  return { wslDistro: tab.wsl ? tab.wsl.distro : undefined, remote: tab.remote };
}

  /** Session-file channel adapters. Declared inside the ready closure (not at
   *  module level) because the SFTP adapter needs `withSftp`, whose
   *  refCount/destroy-on-error discipline the previous hand-rolled lease call
   *  was missing. */
  const readSessionFile = createSessionFileReader({
    readLocal: (p) => readFile(p, "utf8"),
    readWsl: (distro, p) => readFile(wslToWinPath(distro, p), "utf8"),
    readSftp: (remote, p) =>
      withSftp(remote, async (client) => {
        const buf = (await client.get(p)) as string | Buffer;
        return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
      }),
    readSsh: async (remote, p) => {
      const content = await sshCatRemoteFile(remote, p);
      // The helper signals failure with an empty string; the reader's contract
      // is "resolve text or throw", so callers fall back to the RPC path.
      if (!content) throw new Error("key-auth remote read failed");
      return content;
    },
  });

  ipcMain.handle("tree:from-file", async (_e, tabId: string) => {
    const tab = getTab(tabId);
    let sessionPath: string | null | undefined = tab?.sessionPath;
    const pathSource = sessionPath ? "linked" : "missing";
    if (tab && !sessionPath) {
      // pi never reported its session file — its command loop may be stalled
      // (rpc-mode only attaches the stdin reader after boot completes, so a
      // hung boot queues EVERY command: get_state never resolves → sessionPath
      // never links → the file fast path had no path). Locate the most recent
      // session file for the tab's cwd ourselves; no pi round-trip needed.
      sessionPath = await findRecentSessionFile(tab);
    }
    if (!tab || !sessionPath) {
      debugLog("tree", `tab ${tabId} from-file FAILED (${pathSource})`);
      return { ok: false, error: "no session file" };
    }
    debugLog("tree", `tab ${tabId} from-file start (${pathSource}) path=${sessionPath}`);
    try {
      // Channel selection (WSL UNC / SFTP-or-ssh / local) lives in
      // session-file-reader.ts, not here: the tree dialog, the chat transcript
      // and future readers must not each re-derive it. Throws on failure →
      // caught below, so a key-auth read failure still reports exactly
      // "key-auth remote read failed".
      const content = await readSessionFile(sessionFileTargetOf(tab), sessionPath);
      const { entries, leafId } = await parseTreeFileAsync(content);
      debugLog("tree", `tab ${tabId} from-file OK entries=${entries.length}`);
      // Flat entries (not a nested tree): a long linear session nests deeper
      // than Electron's contextBridge 1000-level limit when serialized as a
      // tree — the renderer rebuilds the tree from parentId (shared
      // buildTreeFromEntries).
      return { ok: true, entries, leafId };
    } catch (e) {
      console.error(`[tree] from-file failed for tab ${tabId}:`, e instanceof Error ? e.message : String(e));
      debugLog("tree", `tab ${tabId} from-file ERROR ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  /** Transcript straight from the session file — keeps a multi-MB history
   *  transfer OFF the `pi --mode rpc` command loop (which is serial and behind a
   *  stdout-backpressure gate, so a big `get_messages` makes `prompt`/
   *  `get_state` queue and the agent looks stuck; measured 17–45s round trips).
   *
   *  Scope (R5): only targets whose RPC channel is expensive — remote/WSL.
   *  Local and SDK tabs keep `get_messages` (in-process / local pipe).
   *
   *  CONSISTENCY: pi's `get_state` reports `messageCount = session.messages.length`
   *  — the exact length of the list `get_messages` would return — so the file's
   *  resolution is CHECKED against it before being trusted. A mismatch means the
   *  file is behind pi's in-memory state (an unflushed branch navigation, a
   *  session switch) and the caller must use the RPC path rather than show stale
   *  history. That probe costs one small round trip instead of a multi-MB one;
   *  its response id is prefixed so the renderer ignores it (see
   *  `INTERNAL_RPC_ID_PREFIX`) — otherwise it would drive `state_ready` and loop.
   *
   *  The result is deliberately a discriminated "attempt" rather than a
   *  transcript: the renderer falls back to `get_messages` whenever this cannot
   *  produce one, so a pi format change degrades to "slow but correct" instead
   *  of blank chat (R4). */
  ipcMain.handle("session:transcript-from-file", async (_e, tabId: string) => {
    const tab = getTab(tabId);
    if (!tab) return { ok: false, reason: "tab gone" };
    if (!tab.remote && !tab.wsl) return { ok: false, reason: "local tab" };
    const session = getRpcSession(tabId);
    if (!session) return { ok: false, reason: "no rpc session" };
    const state = await session.request<{ messageCount?: number; sessionFile?: string }>(
      { type: "get_state", id: `${INTERNAL_RPC_ID_PREFIX}get_state` },
      TRANSCRIPT_STATE_TIMEOUT_MS,
    );
    if (!state.success) return { ok: false, reason: "get_state failed" };
    const expected = state.data?.messageCount;
    if (typeof expected !== "number") return { ok: false, reason: "no message count" };
    const sessionPath = state.data?.sessionFile || tab.sessionPath || (await findRecentSessionFile(tab));
    if (!sessionPath) return { ok: false, reason: "no session file" };
    try {
      const content = await readSessionFile(sessionFileTargetOf(tab), sessionPath);
      const messages = await transcriptFromContent(content);
      if (!messages) return { ok: false, reason: "empty transcript" };
      if (messages.length !== expected) {
        return { ok: false, reason: `file behind pi state (${messages.length} != ${expected})` };
      }
      debugLog("transcript", `tab ${tabId} from-file OK messages=${messages.length}`);
      return { ok: true, messages };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      debugLog("transcript", `tab ${tabId} from-file FAILED ${reason}`);
      return { ok: false, reason };
    }
  });

  ipcMain.handle("tab:rpc-switch-terminal", (_e, tabId: string) => {
    // Chat → terminal: local SDK-backed chat tabs respawn the pty TUI;
    // RPC-backed (remote/WSL) chat tabs switch to their pty pi too.
    const ok = getSdkTab(tabId) ? switchSdkToTerminal(tabId, agentDir()) : switchRpcToTerminal(tabId);
    if (ok) {
      emitTabs();
      emitActive();
    }
    return ok;
  });
  ipcMain.handle("tab:rpc-switch-chat", (_e, tabId: string) => {
    if (getSdkTab(tabId)) return false;
    const t = getTab(tabId);
    // Terminal → chat: local pty pi tabs switch to the in-process SDK
    // backend (fast, no extra process); WSL/remote tabs switch to
    // `pi --mode rpc` inside the distro/remote host (agent tools must run in
    // the same OS as the files). Backout: PIPI_SDK_BACKEND=0 sends local
    // tabs down the RPC path too.
    const ok =
      t && !t.remote && !t.wsl && sdkBackendEnabled()
        ? switchTerminalToSdk(tabId, agentDir())
        : switchTerminalToRpc(tabId);
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
  function updateTargetForTab(tabId: string): RemoteUpdateTarget | null {
    const tab = getTab(tabId);
    if (!tab) return null;
    if (tab.wsl) return { kind: "wsl", label: `WSL ${tab.wsl.distro}`, wsl: tab.wsl };
    if (tab.remote) return { kind: "ssh", label: `${tab.remote.user}@${tab.remote.host}`, remote: tab.remote };
    return null;
  }
  ipcMain.handle("update:check-target", (_e, tabId: string) => {
    const target = updateTargetForTab(tabId);
    return target
      ? checkRemotePiUpdate(target)
      : { target: { kind: "ssh" as const, label: "未知目标" }, current: null, latest: null, extensions: [], hasUpdate: false, error: "目标标签不存在" };
  });
  ipcMain.handle("update:run-target", (_e, tabId: string) => {
    const target = updateTargetForTab(tabId);
    return target ? runRemotePiUpdate(target) : { ok: false, output: "", error: "目标标签不存在" };
  });
  ipcMain.handle("update:run", () => runPiUpdate());
  ipcMain.handle("app-update:check", (_e, force?: boolean) => checkAppUpdate(force));
  ipcMain.handle("app-update:download", (_e, url: string) => openAppUpdateDownload(url));
  // App-bundled extensions that were actually re-shipped at startup (content
  // changed). Pull-once: the renderer fetches this exactly once on mount, so
  // dev HMR or window recreation does not re-notify.
  ipcMain.handle("update:extensions-synced", () => {
    const files = pendingExtensionSync;
    pendingExtensionSync = [];
    return { files };
  });

  // --- WSL distro list ---
  ipcMain.handle("wsl:list-distros", async () => {
    const distros = await listWslDistros();
    // Warm the home-dir cache in the background. The sync getWslHome() on WSL
    // click paths uses spawnSync("wsl.exe") with a 5s timeout, which BLOCKS
    // the whole main process (all IPC, terminal streaming) when cold — the
    // "app freezes when I open a WSL tab/tree" report. Listing distros always
    // precedes those clicks (sidebar + remote dialog), so by the time one
    // lands the async probe has usually filled the shared cache.
    for (const d of distros.slice(0, 4)) void getWslHomeAsync(d.name);
    return distros;
  });

  // --- Project list ---
  ipcMain.handle("project:list", () => listProjects());
  ipcMain.handle("project:add-local", (_e, cwd: string) => addLocalProject(cwd));
  ipcMain.handle("project:add-remote", (_e, remote: { host: string; user: string; port?: number; path: string; password?: string; agentDir?: string }) => addRemoteProject(remote));
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
  function remoteModelsFilePath(remote: RemoteOpts, homeDir: string): string {
    return posixPath.join(remoteAgentDir(remote, homeDir), "models.json");
  }

  function remoteAuthFilePath(remote: RemoteOpts, homeDir: string): string {
    return posixPath.join(remoteAgentDir(remote, homeDir), "auth.json");
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
        const obj = await readRemoteJson(client, remoteModelsFilePath(remote, homeDir));
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
      const modelsPath = remoteModelsFilePath(input.remote, homeDir);
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
          ...(manual?.thinkingLevelMap
            ? { thinkingLevelMap: manual.thinkingLevelMap }
            : prev?.thinkingLevelMap
            ? { thinkingLevelMap: prev.thinkingLevelMap }
            : /deepseek-v4-(flash|pro)/i.test(id)
            ? { thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", max: "max" } }
            : {}),
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
        const authPath = remoteAuthFilePath(input.remote, homeDir);
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
      const modelsPath = remoteModelsFilePath(input.remote, homeDir);
      const obj = await readRemoteJson(client, modelsPath);
      if (obj && typeof obj.providers === "object" && !Array.isArray(obj.providers) && (obj.providers as Record<string, unknown>)[providerId] !== undefined) {
        const providers = obj.providers as Record<string, unknown>;
        delete providers[providerId];
        await writeRemoteJson(client, modelsPath, obj);
      }
      const authPath = remoteAuthFilePath(input.remote, homeDir);
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
  ipcMain.handle("remote:delete-history", (_e, target: { host: string; user: string; port: number; agentDir?: string }) => deleteRemoteHistory(target));

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
        const piDir = remoteAgentDir(remote, homeDir);
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
      // Same seam as local: cached when fresh, async incremental refresh
      // otherwise (\\wsl$ UNC reads are plain fs under the hood).
      const cached = sessionIndex.cached(wslTarget(t.wsl.distro), linuxCwd);
      if (cached) return cached;
      return sessionIndex.refresh(wslTarget(t.wsl.distro), linuxCwd);
    }
    const dir = cwd ?? t?.cwd ?? process.cwd();
    sessionIndex.setAgentDir(agentDir());
    // Serve from the SessionIndex cache when fresh; otherwise parse async
    // (cooperative, snapshot-incremental) so the click path never blocks the
    // main-process event loop.
    const cached = sessionIndex.cached(localTarget(), dir);
    if (cached) return cached;
    return sessionIndex.refresh(localTarget(), dir);
  });
  ipcMain.handle("session:list-projects", () => listLocalProjects(agentDir()));
  ipcMain.handle("session:set-remote-hydration-paused", (_e, ref: string | TargetRef, remoteCwd: string, paused: boolean) => {
    const t = resolveTarget(toTargetRef(ref), false);
    if (!t?.remote) return false;
    setRemoteSessionHydrationPaused(remoteSessionCacheKey(t.remote, remoteCwd), paused);
    return true;
  });
  ipcMain.handle("session:prioritize-remote", (_e, ref: string | TargetRef, remoteCwd: string, priority = 2) => {
    const t = resolveTarget(toTargetRef(ref), false);
    if (!t?.remote) return false;
    markRemoteSessionPriority(remoteSessionCacheKey(t.remote, remoteCwd), priority);
    void scheduleRemoteHydrationWork();
    return true;
  });
  ipcMain.handle("session:list-remote", async (_e, ref: string | TargetRef, remoteCwd?: string) => {
    const t = resolveTarget(toTargetRef(ref), false);
    if (!t?.remote && !t?.wsl) return { sessions: [], error: "远程目标不存在或已断开" };
    const targetDir = remoteCwd ?? t.remoteBrowsePath ?? t.remote?.path ?? t.wsl?.path ?? "~";
    if (t?.wsl) {
      // WSL sessions are plain files under \\wsl$\<distro>\… — same
      // SessionIndex seam as local (shared snapshot cache + incremental
      // parse); no SFTP/lease involved.
      const cached = sessionIndex.cached(wslTarget(t.wsl.distro), targetDir);
      if (cached) return { sessions: cached, diagnostics: undefined };
      try {
        const sessions = await sessionIndex.refresh(wslTarget(t.wsl.distro), targetDir);
        return { sessions, diagnostics: undefined };
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
  ipcMain.handle("session:delete", async (_e, payload: TargetRef & { path: string }) => {
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
    const t = resolveTarget(payload);
    if (t?.wsl && !existsSync(payload.path)) {
      // WSL session paths are UNC (\\wsl$\<distro>\…) — use them as-is. The
      // Linux-path translation below only covers legacy/edge callers.
      const isUnc = /^\\\\wsl\$\\/i.test(payload.path);
      const winPath = isUnc ? payload.path : wslToWinPath(t.wsl.distro, resolveWslPath(t.wsl.distro, payload.path));
      try {
        if (existsSync(winPath)) {
          unlinkSync(winPath);
          // Same "deleted sessions must not resurrect" rule as local: drop
          // the WSL cwd from the SessionIndex cache.
          sessionIndex.invalidateFile(winPath);
          return { ok: true };
        }
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
  onFilePath(({ path, kind, seed }) => {
    // A session activation must not move the workbench-level preview to that
    // session's last touched file. Live activity is attributed to its tab so
    // events that race a later activation can also be discarded in renderer.
    if (seed) return;
    const active = getActiveTab();
    if (!active || active.remote || active.wsl) return;
    mainWindow?.webContents.send("file:autofollow", { path, kind, tabId: active.id });
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

  /** Renderer-supplied connection target: a real tab id, or an explicit
   *  connection profile when no tab exists (a "virtual target"). Remote/WSL
   *  file + session operations used to require a live connection tab; a
   *  profile is enough — SFTP already pools by stableRemoteKey, so no ssh
   *  session is implied by a profile. */
  type TargetRef = {
    tabId?: string;
    remote?: { host: string; user: string; port?: number; path?: string; password?: string; agentDir?: string };
    wsl?: { distro: string; path?: string };
  };

  /** Materialize an explicit profile as a VIRTUAL TabInfo so every remote/WSL
   *  branch below keeps reading the same fields (remote / wsl /
   *  remoteBrowsePath / cwd) whether or not a tab exists. A real tab always
   *  wins: it owns the live browse-path state. `fallbackToActive` mirrors the
   *  historical `tabId ? getTab(tabId) : getActiveTab()` contract — a stale
   *  tabId must NOT silently fall back to the active tab. */
  function resolveTarget(ref: TargetRef | undefined, fallbackToActive = true): TabInfo | undefined {
    if (ref?.tabId) return getTab(ref.tabId);
    const remote = ref?.remote;
    const wsl = ref?.wsl;
    if (!remote && !wsl) return fallbackToActive ? (getActiveTab() ?? undefined) : undefined;
    const remoteProfile = remote ? { ...remote } : undefined;
    if (remoteProfile) rememberRemoteProfile(remoteProfile);
    return {
      id: `target:${remoteProfile ? buildRemoteKey(remoteProfile) : `wsl:${wsl!.distro}`}`,
      kind: "agent",
      cwd: "",
      title: "",
      cols: 80,
      rows: 24,
      remote: remoteProfile,
      wsl: wsl ? { distro: wsl.distro, path: wsl.path || "~" } : undefined,
      remoteBrowsePath: remoteProfile ? remoteProfile.path || "~" : undefined,
      remoteKey: remoteProfile ? buildRemoteKey(remoteProfile) : undefined,
      createdAt: 0,
    };
  }

  /** `session:*`-family ref: legacy tabId string, or a TargetRef object. */
  function toTargetRef(ref: string | TargetRef | undefined): TargetRef | undefined {
    return typeof ref === "string" ? { tabId: ref } : ref;
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
        children: undefined,
      }));
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
          children: undefined,
        }));
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
    remoteKey: string,
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
      // Emit the READABLE profile key (pty.buildRemoteKey), not the internal
      // sha1 cache key: the renderer keys its remote session caches by the
      // same readable identity it builds from the sidebar's project rows.
      emitRemoteSessionsUpdated({ remoteKey: buildRemoteKey(remote), remoteCwd, sessions: hydrated, hydratedCount: nextTargetCount, totalCount: currentSessions.length });
    } catch (error) {
      // A DETERMINISTIC failure (auth / permission / missing) must not become a
      // hot retry loop: the scheduler selects entries by hydratedCount, so
      // consume the remaining target to take this entry out of the queue. The
      // entry still expires on its own TTL, and the next fresh listing
      // re-hydrates from zero — so a transient blip recovers, a broken one
      // does not spin.
      console.error(`[remote] session hydration failed (${cacheKey}):`, error instanceof Error ? error.message : String(error));
      const latest = remoteSessionCache.get(cacheKey);
      if (latest) {
        latest.hydrating = false;
        latest.hydratedCount = Math.max(latest.hydratedCount, nextTargetCount);
      }
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
      // Profile-first: a server with no open tab (virtual target) has no entry
      // in the tab registry, but hydration must still run for it.
      const remote = remoteProfiles.get(remoteKey)
        ?? listTabs().find((item) => item.remote && stableRemoteKey(item.remote) === remoteKey)?.remote;
      if (!remote || !remoteCwd) continue;
      void hydrateRemoteSessionsInBackground(remoteKey, remote, remoteCwd, cacheKey, entry.sessions);
    }
  }

  type RemoteSessionListResult =
    | { ok: true; sessions: SessionEntry[]; diagnostics: { resolvedCwd: string; sessionDir: string; fileCount: number } }
    | { ok: false; error: string };

  /** List + parse one remote session dir (metadata-only; eager limit 0). */
  async function listRemoteSessionDir(client: SftpClient, homeDir: string, remoteCwd: string, agentDirOverride?: string): Promise<{ sessions: SessionEntry[]; diagnostics: { resolvedCwd: string; sessionDir: string; fileCount: number } }> {
    const resolvedCwd = resolveRemotePath(remoteCwd, homeDir);
    const sessionDir = posixPath.join(remoteAgentDir({ agentDir: agentDirOverride } as RemoteOpts, homeDir), "sessions", encodeCwd(resolvedCwd));
    // A missing session dir is ROUTINE (pi creates it lazily on the first
    // session), so it must read as "no sessions yet" — the same semantics the
    // local SessionIndex gives (`if (!existsSync(dir)) return []`). Without
    // this the sidebar showed "远程会话加载失败：list: No such file" for a
    // project that simply has no sessions. Other SFTP failures (auth,
    // permission, dead channel) still throw and are reported honestly.
    let items: Awaited<ReturnType<typeof client.list>>;
    try {
      items = await client.list(sessionDir);
    } catch (error) {
      if (!isSftpMissingPathError(error)) throw error;
      debugLog("sessions", `remote session dir missing (treated as empty): ${sessionDir}`);
      return { sessions: [], diagnostics: { resolvedCwd, sessionDir, fileCount: 0 } };
    }
    const files = items
      .filter((item: { name: string; type: string }) => item.type !== "d" && item.name.endsWith(".jsonl"))
      .sort((a: { modifyTime?: number }, b: { modifyTime?: number }) => (b.modifyTime ?? 0) - (a.modifyTime ?? 0));

    const eager = files.slice(0, REMOTE_SESSION_EAGER_PARSE_LIMIT);
    const deferred = files.slice(REMOTE_SESSION_EAGER_PARSE_LIMIT);

    const eagerParsed = await Promise.all(eager.map(async (item: { name: string; modifyTime?: number; size?: number }) => {
      const full = posixPath.join(sessionDir, item.name);
      try {
        // Eager limit is 0 today, so this branch is dormant; if re-enabled,
        // parse cooperatively (never block the event loop on the click path).
        const raw = await client.get(full);
        const text = (Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).subarray(0, REMOTE_SESSION_READ_BYTE_LIMIT).toString("utf8");
        const parsed = await parseSessionTextAsync(text, full, {
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
          const result = await listRemoteSessionDir(client, homeDir, remoteCwd, remote.agentDir);
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
          const sessionDir = posixPath.join(remoteAgentDir(remote, homeDir), "sessions", encodeCwd(resolvedCwd));
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
      const sessionDir = posixPath.join(remoteAgentDir(remote, homeDir), "sessions", encodeCwd(resolveRemotePath(remoteCwd, homeDir)));
      const hydratedRange = await Promise.all(currentSessions.slice(startIndex, endIndex).map(async (entry) => {
        try {
          // Range reads: head (first 128 KiB) always; tail (last 64 KiB)
          // only for oversize files. The sidebar's fields live in the head;
          // but pi appends session_info RENAME entries to the END of the
          // JSONL (mirrors pty.ts's local head+tail 64 KiB title read), so
          // without the tail a renamed large session loses its title. Full
          // multi-MB downloads were the dominant cost of remote sidebar
          // loading on high-latency links; never go back to client.get(full).
          // messageCount saturates at what fits in the window ("N 条" is
          // cosmetic) — never worth a full-file transfer for it.
          const path = entry.path || posixPath.join(sessionDir, posixPath.basename(entry.path));
          const headOpts = { readStreamOptions: { start: 0, end: REMOTE_SESSION_READ_BYTE_LIMIT - 1 } } as unknown as Parameters<typeof client.get>[2];
          const headRaw = await client.get(path, undefined, headOpts);
          const head = Buffer.isBuffer(headRaw) ? headRaw : Buffer.from(String(headRaw));
          let text = head.toString("utf8");
          if ((entry.size || 0) > REMOTE_SESSION_READ_BYTE_LIMIT) {
            try {
              const tailOpts = { readStreamOptions: { start: Math.max(0, entry.size - REMOTE_SESSION_TAIL_READ_BYTES), end: entry.size - 1 } } as unknown as Parameters<typeof client.get>[2];
              const tailRaw = await client.get(path, undefined, tailOpts);
              const tail = Buffer.isBuffer(tailRaw) ? tailRaw : Buffer.from(String(tailRaw));
              text = `${head.toString("utf8")}\n${tail.toString("utf8")}`;
            } catch {
              /* tail read failed — head-only parse still yields the name-less fields */
            }
          }
          // Cooperative parse (yields every 400 lines) — 4 files × 128 KiB of
          // JSON parsing must not land on the main-process event loop in one
          // synchronous burst (terminal streaming shares that loop).
          return await parseSessionTextAsync(text, entry.path, {
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

  async function remoteReadFile(remote: RemoteOpts, filePath: string, baseDir: string, requireWithinBase = false) {
    try {
      if (/^[A-Za-z]:[\\/]/.test(filePath)) {
        throw new Error(`remote tab cannot open local path: ${filePath}`);
      }
      return await withSftp(remote, async (client, homeDir) => {
        const base = resolveRemotePath(baseDir, homeDir);
        const full = filePath.startsWith("/")
          ? posixPath.normalize(filePath)
          : posixPath.normalize(posixPath.join(base, filePath));
        if (requireWithinBase && full !== base && !full.startsWith(`${base}/`)) {
          throw new Error("引用文件不能位于项目目录之外");
        }
        const st = await client.stat(full);
        const bytes = st.size;
        if (bytes <= TEXT_PREVIEW_MAX_BYTES) {
          const content = await client.get(full);
          const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
          const isBinary = isBinaryBuffer(buffer);
          return {
            content: isBinary ? "(二进制文件，无法以文本显示)" : buffer.toString("utf8"),
            bytes,
            isBinary,
            image: imagePayloadOf(buffer, filePath),
            error: undefined as string | undefined,
          };
        }
        // Oversize: pull only the head+tail ranges over the wire (no full
        // transfer). readStreamOptions start/end are byte offsets — the
        // @types/ssh2-sftp-client declarations are stale, but v12 passes the
        // options straight to ssh2's createReadStream, which honors ranges.
        const half = TEXT_PREVIEW_HALF_BYTES;
        const rangeOpts = { readStreamOptions: { start: 0, end: half - 1 } } as unknown as Parameters<typeof client.get>[2];
        const headRaw = await client.get(full, undefined, rangeOpts);
        const tailRaw = await client.get(full, undefined, {
          readStreamOptions: { start: bytes - half, end: bytes - 1 },
        } as unknown as Parameters<typeof client.get>[2]);
        const head = Buffer.isBuffer(headRaw) ? headRaw : Buffer.from(String(headRaw));
        const tail = Buffer.isBuffer(tailRaw) ? tailRaw : Buffer.from(String(tailRaw));
        if (isBinaryBuffer(head)) {
          let image;
          if (rasterImageMimeOf(filePath) && bytes <= IMAGE_PREVIEW_MAX_BYTES) {
            const fullBuf = await client.get(full);
            image = imagePayloadOf(Buffer.isBuffer(fullBuf) ? fullBuf : Buffer.from(String(fullBuf)), filePath);
          }
          return {
            content: "(二进制文件，无法以文本显示)",
            bytes,
            isBinary: true,
            image,
            error: undefined as string | undefined,
          };
        }
        return {
          content: `${head.toString("utf8")}\n\n……\n\n${tail.toString("utf8")}`,
          bytes,
          isBinary: false,
          truncated: true,
          error: undefined as string | undefined,
        };
      });
    } catch (e) {
      return { content: `⚠️ 读取失败: ${e instanceof Error ? e.message : String(e)}`, bytes: 0, isBinary: false, error: String(e) };
    }
  }

  // Provision the app-controlled theme file into pi's config BEFORE the window
  // opens so the very first local tab already renders with the app's palette
  // (pi hot-reloads the file on later mode flips).
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

  // --- ConPTY freeze self-healing ------------------------------------------
  // Windows conhost's pipe can stall after a LONG lock/sleep (output freezes,
  // input is swallowed — known OS bug). The renderer-side watchdog in pty.ts
  // catches a stalled pty on the next keystroke; here we ALSO proactively
  // rebuild every pty tab when the machine comes back from a long power event,
  // so a terminal that was left unattended is already fresh when the user
  // returns. Sessions survive (pi auto-saves to JSONL; restart resumes them).
  let powerOffAt = 0;
  const POWER_OFF_RESTART_MIN_MS = 10 * 60 * 1000; // ≥10min off → restart
  function maybeRestartTabsAfterPower(label: string): void {
    const dur = powerOffAt === 0 ? 0 : Date.now() - powerOffAt;
    powerOffAt = 0;
    if (dur < POWER_OFF_RESTART_MIN_MS) return; // brief lock/sleep — skip
    console.log(`[power] ${label} lasted ${(dur / 60000).toFixed(1)} min — rebuilding pty tabs`);
    for (const t of listTabs()) {
      // Shell tabs (pi already exited / startPi:false) keep their plain
      // shell — restarting them would respawn pi or kill a running job.
      if (t.pty && !t.shellMode) restartTab(t.id);
    }
  }
  powerMonitor.on("lock-screen", () => {
    powerOffAt = Date.now();
  });
  powerMonitor.on("suspend", () => {
    powerOffAt = Date.now();
  });
  powerMonitor.on("unlock-screen", () => maybeRestartTabsAfterPower("lock"));
  powerMonitor.on("resume", () => maybeRestartTabsAfterPower("sleep"));

  // Back off per server after failures (unreachable host / session dir not
  // created yet) so one dead server can't block polling for others and we
  // don't retry an SSH+SFTP connect every 4s in a tight loop.
  const remoteRefreshFailures = new Map<string, number>(); // remoteKey -> last failure time
  async function refreshActiveRemoteTabTitles(): Promise<void> {
    const t = getActiveTab();
    if (!t) return;
    if (t.wsl) {
      // WSL titles sync through the SessionIndex change forwarder (the
      // active WSL tab is polled there; onAnyChange routes file-set changes
      // to emitRemoteSessionsUpdated and mtime-only drift to
      // syncRemoteTabTitles). Nothing to do here.
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
    if (changed) emitRemoteSessionsUpdated({ tabId: t.id, remoteKey, remoteCwd: targetDir, sessions: merged, hydratedCount: merged.every((s) => !(s.name === null && s.firstMessage === "" && s.messageCount === 0)) ? merged.length : hydratedCount, totalCount: merged.length });
    else syncRemoteTabTitles(t.id, targetDir, merged);
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
} // gotSingleInstanceLock

app.on("window-all-closed", async () => {
  if (remotePollTimer) clearInterval(remotePollTimer);
  stopSessionsPoll();
  closeAllTabs();
  closeAllRpcSessions();
  closeAllSdkSessions();
  stopWatching();
  await Promise.all([...sftpLeases.values()].map((lease) => destroySftpLease(lease)));
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (remotePollTimer) clearInterval(remotePollTimer);
  stopSessionsPoll();
  closeAllTabs();
  closeAllRpcSessions();
  closeAllSdkSessions();
  stopWatching();
  await Promise.all([...sftpLeases.values()].map((lease) => destroySftpLease(lease)));
});

process.on("unhandledRejection", (err) => {
  console.error("[main] unhandledRejection:", err);
});
// A synchronous throw inside a setInterval/fs.watch/timer callback (e.g. the
// remote title poll) would otherwise CRASH the whole main process — the
// terminal app dies with no recovery. Log and keep going.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
});
