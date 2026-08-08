import { contextBridge, ipcRenderer } from "electron";
import type { ModelEditorSpec, ProviderEditorConfig } from "../shared/model-config-types";

export interface FileReadResult {
  content: string;
  bytes: number;
  isBinary: boolean;
  error?: string;
}

export type FileOpResult = { ok: true } | { ok: false; error: string };

export interface TabSummary {
  id: string;
  cwd: string;
  sessionPath?: string;
  title: string;
  isRemote?: boolean;
  remoteKey?: string;
  remoteHost?: string;
  remoteUser?: string;
  remotePort?: number;
  /** Whether this tab runs the pi TUI (local tabs always; remote unless startPi:false). */
  pi: boolean;
  isWsl?: boolean;
  wslDistro?: string;
  /** rpc = headless ChatPane (local tabs); pty = terminal view. */
  mode?: "rpc" | "pty";
}

export interface SessionListItem {
  path: string;
  sessionId: string;
  mtime: number;
  size: number;
  messageCount: number;
  firstMessage: string;
  name: string | null;
}

export interface RemoteSessionListResult {
  sessions: SessionListItem[];
  error?: string;
  diagnostics?: {
    resolvedCwd: string;
    sessionDir: string;
    fileCount: number;
  };
}

export interface ModelConfigItem {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
  availableModels?: string[];
  contextWindow?: number;
  maxTokens?: number;
  providerConfig?: ProviderEditorConfig;
  modelSpecs?: Record<string, ModelEditorSpec>;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteTarget {
  host: string;
  user: string;
  port?: number;
  path?: string;
  password?: string;
}

const api = {
  // --- Tabs / terminal ---
  tab: {
    create: (opts: { cwd: string; sessionPath?: string; continueRecent?: boolean; title?: string; remote?: { host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean }; wsl?: { distro: string; path?: string } }): Promise<string> =>
      ipcRenderer.invoke("tab:create", opts),
    close: (id: string): Promise<boolean> => ipcRenderer.invoke("tab:close", id),
    activate: (id: string): Promise<boolean> => ipcRenderer.invoke("tab:activate", id),
    write: (id: string, data: string): Promise<boolean> => ipcRenderer.invoke("tab:write", id, data),
    resize: (id: string, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke("tab:resize", id, cols, rows),
    alive: (id: string): Promise<boolean> => ipcRenderer.invoke("tab:alive", id),
    list: (): Promise<TabSummary[]> => ipcRenderer.invoke("tab:list"),
    /** Send a JSON command to a tab's RPC pi session (prompt/steer/abort/…). */
    rpcSend: (id: string, cmd: Record<string, unknown>): Promise<boolean> =>
      ipcRenderer.invoke("tab:rpc-send", id, cmd),
    /** Fall back from the chat view to the full TUI for this tab (same id). */
    rpcSwitchToTerminal: (id: string): Promise<string | null> =>
      ipcRenderer.invoke("tab:rpc-switch-terminal", id),
    /** Switch back from the TUI to the chat view (same id). */
    rpcSwitchToChat: (id: string): Promise<string | null> =>
      ipcRenderer.invoke("tab:rpc-switch-chat", id),
    waitUntilAlive: async (id: string, timeoutMs = 3000, intervalMs = 250): Promise<boolean> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (await ipcRenderer.invoke("tab:alive", id)) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      return await ipcRenderer.invoke("tab:alive", id);
    },
  },
  onTabData: (id: string, callback: (data: string) => void): (() => void) => {
    const channel = `tab:data:${id}`;
    const handler = (_e: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onTabExit: (id: string, callback: (code: number) => void): (() => void) => {
    const channel = `tab:exit:${id}`;
    const handler = (_e: Electron.IpcRendererEvent, code: number) => callback(code);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /** RPC chat: parsed pi events (message_update, tool_execution_*, …). */
  onRpcEvent: (id: string, callback: (event: Record<string, unknown>) => void): (() => void) => {
    const channel = `tab:rpc-event:${id}`;
    const handler = (_e: Electron.IpcRendererEvent, event: Record<string, unknown>) => callback(event);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /** RPC chat: pi process exited. */
  onRpcExit: (id: string, callback: (code: number) => void): (() => void) => {
    const channel = `tab:rpc-exit:${id}`;
    const handler = (_e: Electron.IpcRendererEvent, code: number) => callback(code);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /** RPC chat: extension UI dialog request (select/confirm/input/editor). */
  onRpcUiRequest: (id: string, callback: (req: Record<string, unknown>) => void): (() => void) => {
    const channel = `tab:rpc-ui-request:${id}`;
    const handler = (_e: Electron.IpcRendererEvent, req: Record<string, unknown>) => callback(req);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /** RPC chat: answer an extension UI dialog ({value} | {confirmed} | {cancelled}). */
  rpcUiResponse: (id: string, response: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke("tab:rpc-ui-response", id, response),
  update: {
    check: (force?: boolean): Promise<{ current: string | null; latest: string | null; hasUpdate: boolean; error?: string }> =>
      ipcRenderer.invoke("update:check", force),
    run: (): Promise<{ ok: boolean; output: string; error?: string }> => ipcRenderer.invoke("update:run"),
  },
  diff: {
    list: (tabId: string): Promise<{ isGit: boolean; files: { status: string; path: string; additions: number; deletions: number }[]; error?: string }> =>
      ipcRenderer.invoke("diff:list", tabId),
    get: (tabId: string, path: string): Promise<{ diff: string; isUntracked: boolean; error?: string }> =>
      ipcRenderer.invoke("diff:get", tabId, path),
    history: (tabId: string, path: string, events: unknown[]): Promise<{ versions: { label: string; content: string }[]; error?: string }> =>
      ipcRenderer.invoke("diff:history", tabId, path, events),
    compare: (a: string, b: string, path: string): Promise<{ diff: string }> =>
      ipcRenderer.invoke("diff:compare", a, b, path),
  },
  theme: {
    setMode: (mode: "dark" | "light"): Promise<boolean> =>
      ipcRenderer.invoke("theme:set-mode", mode),
  },
  onTabsUpdate: (callback: (tabs: TabSummary[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, tabs: TabSummary[]) => callback(tabs);
    ipcRenderer.on("tabs:update", handler);
    return () => ipcRenderer.removeListener("tabs:update", handler);
  },
  onActiveTab: (callback: (payload: { id: string | null; cwd: string; isRemote?: boolean; sessions?: SessionListItem[] }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { id: string; cwd: string; isRemote?: boolean; sessions?: SessionListItem[] }) =>
      callback(payload);
    ipcRenderer.on("tabs:active", handler);
    return () => ipcRenderer.removeListener("tabs:active", handler);
  },

  // --- File tree + viewer ---
  file: {
    list: (tabId?: string, dirPath?: string, rootPath?: string, noCache?: boolean): Promise<unknown> =>
      ipcRenderer.invoke("file:list", { tabId, dirPath, rootPath, noCache }),
    resolveLink: (input: { tabId?: string; rootPath?: string; currentPath?: string; href: string }): Promise<{ ok: true; relPath: string; tabId?: string; rootPath?: string } | { ok: false }> =>
      ipcRenderer.invoke("file:resolve-link", input),
    read: (tabId: string | undefined, relPath: string, rootPath?: string): Promise<FileReadResult> =>
      ipcRenderer.invoke("file:read", { tabId, relPath, rootPath }),
    write: (tabId: string | undefined, relPath: string, content: string, rootPath?: string): Promise<FileOpResult> =>
      ipcRenderer.invoke("file:write", { tabId, relPath, content, rootPath }),
    mkdir: (tabId: string | undefined, relPath: string, rootPath?: string): Promise<FileOpResult> =>
      ipcRenderer.invoke("file:mkdir", { tabId, relPath, rootPath }),
    delete: (tabId: string | undefined, relPath: string, rootPath?: string): Promise<FileOpResult> =>
      ipcRenderer.invoke("file:delete", { tabId, relPath, rootPath }),
    rename: (tabId: string | undefined, relPath: string, newName: string, rootPath?: string): Promise<FileOpResult> =>
      ipcRenderer.invoke("file:rename", { tabId, relPath, newName, rootPath }),
  },
  onAutoFollow: (callback: (ev: { path: string; kind: "read" | "write" }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: { path: string; kind: "read" | "write" }) => callback(ev);
    ipcRenderer.on("file:autofollow", handler);
    return () => ipcRenderer.removeListener("file:autofollow", handler);
  },
  onAutoFollowStatus: (callback: (status: { ok: boolean; reason?: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: { ok: boolean; reason?: string }) => callback(status);
    ipcRenderer.on("file:autofollow-status", handler);
    return () => ipcRenderer.removeListener("file:autofollow-status", handler);
  },

  settings: {
    get: (): Promise<{ autoFollow: { enabled: boolean; followReads: boolean } }> =>
      ipcRenderer.invoke("settings:get"),
    set: (patch: { autoFollow?: { enabled?: boolean; followReads?: boolean } }): Promise<{ autoFollow: { enabled: boolean; followReads: boolean } }> =>
      ipcRenderer.invoke("settings:set", patch),
  },

  project: {
    list: (): Promise<any[]> => ipcRenderer.invoke("project:list"),
    addLocal: (cwd: string): Promise<any> => ipcRenderer.invoke("project:add-local", cwd),
    addRemote: (remote: { host: string; user: string; port?: number; path: string; password?: string }): Promise<any> =>
      ipcRenderer.invoke("project:add-remote", remote),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke("project:delete", id),
    addWsl: (distro: string, path: string): Promise<any> => ipcRenderer.invoke("project:add-wsl", distro, path),
  },

  model: {
    list: (): Promise<ModelConfigItem[]> => ipcRenderer.invoke("model:list"),
    add: (input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }): Promise<ModelConfigItem> =>
      ipcRenderer.invoke("model:add", input),
    update: (id: string, input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }): Promise<ModelConfigItem> =>
      ipcRenderer.invoke("model:update", id, input),
    discover: (input: { baseUrl: string; apiKey?: string }): Promise<string[]> =>
      ipcRenderer.invoke("model:discover", input),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke("model:delete", id),
    checkSync: (input: { provider: string; model: string }): Promise<{ ok: boolean; piModelsPath: string; providerExists: boolean; modelExists: boolean; listModelsContains: boolean; error?: string }> =>
      ipcRenderer.invoke("model:check-sync", input),
    listRemote: (remote: RemoteTarget): Promise<ModelConfigItem[]> => ipcRenderer.invoke("model:list-remote", remote),
    addRemote: (input: { remote: RemoteTarget; baseUrl: string; apiKey?: string; model: string; provider: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }): Promise<{ ok: boolean; provider: string }> =>
      ipcRenderer.invoke("model:add-remote", input),
    deleteRemote: (input: { remote: RemoteTarget; provider: string }): Promise<boolean> =>
      ipcRenderer.invoke("model:delete-remote", input),
    discoverRemote: (input: { remote: RemoteTarget; baseUrl: string; apiKey?: string }): Promise<string[]> =>
      ipcRenderer.invoke("model:discover-remote", input),
    transplantToWsl: (distro: string): Promise<{ ok: boolean; error?: string; copied: string[] }> =>
      ipcRenderer.invoke("model:transplant-to-wsl", distro),
    transplantToRemote: (remote: RemoteTarget): Promise<{ ok: boolean; error?: string; copied: string[] }> =>
      ipcRenderer.invoke("model:transplant-to-remote", remote),
  },

  // --- Session list (sidebar) ---
  session: {
    list: (cwd?: string): Promise<SessionListItem[]> =>
      ipcRenderer.invoke("session:list", cwd),
    listProjects: (): Promise<string[]> =>
      ipcRenderer.invoke("session:list-projects"),
    listRemote: (tabId: string, remoteCwd?: string): Promise<RemoteSessionListResult> =>
      ipcRenderer.invoke("session:list-remote", tabId, remoteCwd),
    onLocalUpdated: (callback: (payload: { cwd: string; sessions: SessionListItem[] }) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { cwd: string; sessions: SessionListItem[] }) => callback(payload);
      ipcRenderer.on("session:local-updated", handler);
      return () => ipcRenderer.removeListener("session:local-updated", handler);
    },
    delete: (path: string, tabId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("session:delete", { path, tabId }),
    rename: (path: string, name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("session:rename", path, name),
    onRemoteUpdated: (callback: (payload: { tabId: string; remoteCwd: string; sessions: SessionListItem[] }) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: { tabId: string; remoteCwd: string; sessions: SessionListItem[] }) => callback(payload);
      ipcRenderer.on("session:remote-updated", handler);
      return () => ipcRenderer.removeListener("session:remote-updated", handler);
    },
    setRemoteHydrationPaused: (tabId: string, remoteCwd: string, paused: boolean): Promise<boolean> =>
      ipcRenderer.invoke("session:set-remote-hydration-paused", tabId, remoteCwd, paused),
    prioritizeRemote: (tabId: string, remoteCwd: string, priority?: number): Promise<boolean> =>
      ipcRenderer.invoke("session:prioritize-remote", tabId, remoteCwd, priority),
  },

  remote: {
    setBrowsePath: (tabId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke("remote:set-browse-path", tabId, path),
    getBrowsePath: (tabId: string): Promise<string | null> =>
      ipcRenderer.invoke("remote:get-browse-path", tabId),
    getInfo: (tabId: string): Promise<{ host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean; isWsl?: boolean } | null> =>
      ipcRenderer.invoke("remote:get-info", tabId),
    listHistory: (): Promise<any[]> => ipcRenderer.invoke("remote:list-history"),
  },

  wsl: {
    listDistros: (): Promise<Array<{ name: string; default: boolean; running: boolean; version: number }>> =>
      ipcRenderer.invoke("wsl:list-distros"),
  },

  // --- Project directory picker ---
  selectDir: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-dir"),
};

contextBridge.exposeInMainWorld("api", api);

export type AppApi = typeof api;
