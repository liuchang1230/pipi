import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join, posix as posixPath } from "node:path";
import { unlinkSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import SftpClient from "ssh2-sftp-client";
import { Client as SshClient } from "ssh2";
import { listFiles, readFileContent } from "./file-tree";
import {
  createTab, closeTab, closeAllTabs, getTab, listTabs, setActiveTab,
  resizeTab, writeTab, subscribeTab, getActiveTab, findSshBin,
  getRemoteBrowsePath, setRemoteBrowsePath, buildRemoteKey, setThemeMode,
  hasNodeInstalled, hasGlobalPiInstalled, installGlobalPi, getPiDetectionDiagnostics,
  type TabInfo, type RemoteOpts,
} from "./pty";
import {
  ensureLocalSettingsTheme, ensureLocalThemeFiles, syncThemesViaSftp,
  type RemoteThemeSyncResult,
} from "./theme-sync";
import type { ThemeMode } from "../shared/terminal-theme";
import { encodeCwd, listSessions, listLocalProjects, parseSessionText, sessionDirFor, type SessionEntry } from "./session-list";
import { startWatching, stopWatching, onFilePath, onStatus } from "./session-watcher";
import { getSettings, updateSettings, type AppSettings } from "./settings";
import { addLocalProject, addRemoteProject, addModel, deleteModel, deleteProject, listModels, listProjects, syncModelToPi, checkPiModelSync } from "./projects";

interface RemoteModelListResponse {
  data?: Array<{ id?: string }>;
}
import { listRemoteHistory, saveRemoteHistory } from "./remote-history";

let mainWindow: BrowserWindow | null = null;

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

function emitRemoteSessionsUpdated(tabId: string, remoteCwd: string, sessions: SessionEntry[]): void {
  mainWindow?.webContents.send("session:remote-updated", { tabId, remoteCwd, sessions });
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

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "pipi",
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
  mainWindow?.webContents.send("tabs:update", listTabs().map((t) => ({
    id: t.id,
    cwd: t.cwd,
    sessionPath: t.sessionPath,
    title: t.title,
    isRemote: !!t.remote,
    remoteKey: t.remoteKey,
    remoteHost: t.remote?.host,
    remoteUser: t.remote?.user,
    remotePort: t.remote?.port ?? 22,
    // Local tabs always run pi; remote tabs do unless startPi:false.
    pi: t.remote ? t.remote.startPi !== false : true,
  })));
}

function emitActive() {
  const t = getActiveTab();
  if (t) {
    const cwd = t.remote ? (t.remoteBrowsePath || t.remote.path || "~") : t.cwd;
    mainWindow?.webContents.send("tabs:active", { id: t.id, cwd, isRemote: !!t.remote });
    if (t.remote) stopWatching();
    else startWatching(t.cwd);
    return;
  }
  stopWatching();
  mainWindow?.webContents.send("tabs:active", { id: null, cwd: "", isRemote: false });
}

app.whenReady().then(async () => {
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

    const install = installGlobalPi();
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
    return { ok: true };
  }

  // --- Terminal / tabs ---
  ipcMain.handle("tab:create", async (_e, opts: { cwd: string; sessionPath?: string; continueRecent?: boolean; remote?: { host: string; user: string; port?: number; path?: string; password?: string }; themeMode?: ThemeMode }) => {
    if (!opts.remote) {
      const ready = await ensurePiReady();
      if (!ready.ok) {
        throw new Error(ready.reason);
      }
    }
    // Remote tabs always spawn from process.cwd(); also fix cwd if the
    // renderer accidentally passes a remote path (e.g. "/home/user").
    if (opts.remote || opts.cwd.startsWith("/") || opts.cwd.startsWith("~")) {
      opts.cwd = process.cwd();
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
    const id = createTab(opts);
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
    const tab = getTab(id);
    const remote = tab?.remote;
    closeTab(id);
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
    setActiveTab(id);
    emitActive();
    return true;
  });
  ipcMain.handle("tab:write", (_e, id: string, data: string) => writeTab(id, data));
  ipcMain.handle("tab:resize", (_e, id: string, cols: number, rows: number) => resizeTab(id, cols, rows));
  ipcMain.handle("tab:list", () => listTabs().map((t) => ({
    id: t.id, cwd: t.cwd, sessionPath: t.sessionPath, title: t.title, isRemote: !!t.remote,
  })));

  // --- File tree + viewer (left/right panels) ---
  ipcMain.handle("file:list", async (_e, payload?: { tabId?: string; dirPath?: string; rootPath?: string }) => {
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    const dirPath = payload?.dirPath;
    if (t?.remote) {
      const targetDir = dirPath ?? payload?.rootPath ?? t.remoteBrowsePath ?? t.remote.path ?? "~";
      const cacheKey = remoteFileTreeCacheKey(t.remote, targetDir);
      const cached = getCachedRemoteFileTree(cacheKey);
      if (cached) return cached;
      return setCachedRemoteFileTree(cacheKey, await remoteListFiles(t.remote, targetDir));
    }
    return listFiles(payload?.rootPath ?? dirPath ?? t?.cwd ?? process.cwd());
  });
  ipcMain.handle("file:read", async (_e, payload: { tabId?: string; relPath: string }) => {
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
    const relPath = payload.relPath;
    if (t?.remote) {
      return remoteReadFile(t.remote, relPath, t.remoteBrowsePath ?? t.remote.path ?? "~");
    }
    return readFileContent(t?.cwd ?? process.cwd(), relPath).catch((err) => ({
      content: `⚠️ 读取失败: ${err instanceof Error ? err.message : String(err)}`,
      bytes: 0,
      isBinary: false,
      error: String(err),
    }));
  });

  ipcMain.handle("remote:set-browse-path", (_e, tabId: string, path: string) => {
    const ok = setRemoteBrowsePath(tabId, path);
    if (ok && getActiveTab()?.id === tabId) emitActive();
    return ok;
  });
  ipcMain.handle("remote:get-browse-path", (_e, tabId: string) => getRemoteBrowsePath(tabId));
  ipcMain.handle("remote:get-info", (_e, tabId: string) => {
    const t = getTab(tabId);
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

  ipcMain.handle("tab:alive", (_e, tabId: string) => !!getTab(tabId));

  // --- Project list ---
  ipcMain.handle("project:list", () => listProjects());
  ipcMain.handle("project:add-local", (_e, cwd: string) => addLocalProject(cwd));
  ipcMain.handle("project:add-remote", (_e, remote: { host: string; user: string; port?: number; path: string; password?: string }) => addRemoteProject(remote));
  ipcMain.handle("project:delete", (_e, id: string) => deleteProject(id));
  ipcMain.handle("model:list", () => listModels());
  ipcMain.handle("model:add", (_e, input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[] }) => {
    const saved = addModel(input);
    syncModelToPi(saved);
    return saved;
  });
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
        const providers = (obj && typeof obj.providers === "object" && !Array.isArray(obj.providers) ? obj.providers : {}) as Record<string, { baseUrl?: string; apiKey?: string; models?: Array<{ id?: string }> }>;
        return Object.entries(providers).map(([provider, cfg]) => ({
          id: `remote-${provider}`,
          name: provider,
          baseUrl: cfg?.baseUrl ?? "",
          model: cfg?.models?.[0]?.id ?? "",
          provider,
          apiKey: typeof cfg?.apiKey === "string" && cfg.apiKey.length > 0 ? cfg.apiKey : undefined,
          availableModels: (cfg?.models ?? []).map((m) => m?.id).filter((x): x is string => typeof x === "string"),
          createdAt: 0,
          updatedAt: 0,
        }));
      });
    } catch (error) {
      throw new Error(`读取远程模型配置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle("model:add-remote", async (_e, input: { remote: RemoteOpts; baseUrl: string; apiKey?: string; model: string; provider: string; availableModels?: string[] }) => {
    const providerId = input.provider.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!providerId) throw new Error("Provider 必填");
    if (!baseUrl) throw new Error("Base URL 必填");
    const modelIds = Array.from(new Set([input.model.trim(), ...(input.availableModels ?? [])].map((s) => s.trim()).filter(Boolean)));
    if (modelIds.length === 0) throw new Error("模型 ID 必填");
    const models = modelIds.map((id) => ({
      id,
      name: id,
      reasoning: /gpt-5|o1|o3|o4|deepseek-r|deepseek-v4|claude|gemini-2\.5/i.test(id),
      input: ["text"] as Array<"text" | "image">,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    return await withSftp(input.remote, async (client, homeDir) => {
      const modelsPath = remoteModelsFilePath(homeDir);
      const obj = (await readRemoteJson(client, modelsPath)) ?? {};
      const providers = (obj && typeof obj.providers === "object" && !Array.isArray(obj.providers) ? obj.providers : {}) as Record<string, unknown>;
      obj.providers = providers;
      providers[providerId] = {
        baseUrl,
        api: "openai-completions",
        apiKey: input.apiKey?.trim() || "placeholder",
        authHeader: true,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        },
        models,
      };
      await writeRemoteJson(client, modelsPath, obj);
      if (input.apiKey?.trim()) {
        const authPath = remoteAuthFilePath(homeDir);
        const auth = (await readRemoteJson(client, authPath)) ?? {};
        (auth as Record<string, unknown>)[providerId] = { type: "api_key", key: input.apiKey.trim() };
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

  // --- Session list (left sidebar, pure fs) ---
  ipcMain.handle("session:list", (_e, cwd?: string) => {
    const t = getActiveTab();
    const dir = cwd ?? t?.cwd ?? process.cwd();
    return listSessions(dir);
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
    if (!t?.remote) return { sessions: [], error: "远程标签页不存在或已断开" };
    const targetDir = remoteCwd ?? t.remoteBrowsePath ?? t.remote.path ?? "~";
    const cacheKey = remoteSessionCacheKey(t.remote, targetDir);
    const cached = getCachedRemoteSessions(cacheKey);
    if (cached) {
      markRemoteSessionPriority(cacheKey, 2);
      if (!cached.hydrating) {
        void scheduleRemoteHydrationWork();
      }
      const diagnostics = await remoteSessionDiagnostics(t.remote, targetDir).catch(() => undefined);
      return { sessions: cached.sessions, diagnostics };
    }
    const initial = await remoteListSessions(t.remote, targetDir);
    if (!initial.ok) {
      return { sessions: [], error: initial.error };
    }
    const sessions = setCachedRemoteSessions(cacheKey, initial.sessions, false, 0, false, 2, Date.now());
    void scheduleRemoteHydrationWork();
    return { sessions, diagnostics: initial.diagnostics };
  });
  ipcMain.handle("session:delete", async (_e, payload: { path: string; tabId?: string }) => {
    // 本地文件优先：路径在本机存在就直接本地删除，
    // 避免批量删除受“当前活动标签页是远程”影响而误走 SFTP。
    if (existsSync(payload.path)) {
      try {
        unlinkSync(payload.path);
        return { ok: true };
      } catch (err) {
        // 例如 Windows 上文件正被 pi 进程占用时抛出 EPERM/EBUSY
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const t = payload?.tabId ? getTab(payload.tabId) : getActiveTab();
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

  ipcMain.handle("session:rename", (_e, path: string, name: string) => {
    try {
      const raw = readFileSync(path, "utf8");
      const idx = raw.indexOf("\n");
      if (idx < 0) return { ok: false, error: "empty session file" };
      let header;
      try { header = JSON.parse(raw.slice(0, idx)); } catch {
        return { ok: false, error: "invalid header JSON" };
      }
      header.name = name || undefined;
      const rest = raw.slice(idx);
      writeFileSync(path, JSON.stringify(header) + rest, "utf8");
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

  async function remoteListFiles(remote: RemoteOpts, dirPath?: string) {
    try {
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

  async function remoteListSessions(remote: RemoteOpts, remoteCwd: string): Promise<{ ok: true; sessions: SessionEntry[]; diagnostics: { resolvedCwd: string; sessionDir: string; fileCount: number } } | { ok: false; error: string }> {
    try {
      const result = await withSftp(remote, async (client, homeDir) => {
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
      });
      return { ok: true, sessions: result.sessions, diagnostics: result.diagnostics };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function remoteSessionDiagnostics(remote: RemoteOpts, remoteCwd: string): Promise<{ resolvedCwd: string; sessionDir: string; fileCount: number }> {
    return withSftp(remote, async (client, homeDir) => {
      const resolvedCwd = resolveRemotePath(remoteCwd, homeDir);
      const sessionDir = posixPath.join(homeDir, ".pi", "agent", "sessions", encodeCwd(resolvedCwd));
      const items = await client.list(sessionDir);
      const fileCount = items.filter((item: { name: string; type: string }) => item.type !== "d" && item.name.endsWith(".jsonl")).length;
      return { resolvedCwd, sessionDir, fileCount };
    });
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

  // Open the initial tab: continue the most recent session for the cwd.
  emitTabs();
  emitActive();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  closeAllTabs();
  stopWatching();
  await Promise.all([...sftpLeases.values()].map((lease) => destroySftpLease(lease)));
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  closeAllTabs();
  stopWatching();
  await Promise.all([...sftpLeases.values()].map((lease) => destroySftpLease(lease)));
});

process.on("unhandledRejection", (err) => {
  console.error("[main] unhandledRejection:", err);
});
