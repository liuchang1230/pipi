// Type bridge exposed by preload via contextBridge.
export {};

export interface FileNode {
  name: string;
  path: string; // relative to root, forward slashes
  type: "file" | "directory";
  children?: FileNode[];
}

export interface ImagePreview {
  mimeType: string;
  base64: string;
}

export interface FileReadResult {
  content: string;
  bytes: number;
  isBinary: boolean;
  /** Set when the file is a previewable raster image (base64 payload). */
  image?: ImagePreview;
  /** Set when the file exceeded the preview cap: content is head+tail only. */
  truncated?: boolean;
  error?: string;
}

export interface FileMentionResult {
  files: Array<{ path: string; type: "file" | "directory" }>;
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
  /** rpc = headless ChatPane (local tabs); pty = terminal view. */
  mode?: "rpc" | "sdk" | "pty";
  /** Connection shell tabs only: "ready" after the remote shell confirmed,
   *  "failed" when ssh exited before that. */
  sshState?: "ready" | "failed";
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

export interface RemoteHistoryItem {
  id: string;
  host: string;
  user: string;
  port: number;
  password?: string;
  path?: string;
  agentDir?: string;
  updatedAt: number;
}

export interface ProjectListItem {
  id: string;
  type: "local" | "remote";
  name: string;
  cwd?: string;
  host?: string;
  user?: string;
  port?: number;
  path?: string;
  password?: string;
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
  agentDir?: string;
}

export interface AutoFollowEvent {
  path: string;
  kind: "read" | "write";
  /** Local tab that produced this event; absent for older main processes. */
  tabId?: string;
}

export interface AutoFollowStatus {
  ok: boolean;
  reason?: string;
}

export interface AutoFollowSettings {
  enabled: boolean;
  followReads: boolean;
}

export interface AppSettings {
  autoFollow: AutoFollowSettings;
}

declare global {
  interface Window {
    api: {
      tab: {
        create: (opts: {
          cwd: string;
          sessionPath?: string;
          continueRecent?: boolean;
          title?: string;
          remote?: { host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean; agentDir?: string };
          wsl?: { distro: string; path?: string };
        }) => Promise<string>;
        close: (id: string) => Promise<boolean>;
        activate: (id: string) => Promise<boolean>;
        write: (id: string, data: string) => Promise<boolean>;
        /** One-way low-latency keystroke transport for the embedded terminal. */
        writeInput: (id: string, data: string) => void;
        resize: (id: string, cols: number, rows: number) => Promise<boolean>;
        alive: (id: string) => Promise<boolean>;
        list: () => Promise<TabSummary[]>;
        waitUntilAlive: (id: string, timeoutMs?: number, intervalMs?: number) => Promise<boolean>;
        /** Honest SSH session state for connection shell tabs: "ready" | "failed" | "timeout". */
        waitConnState: (id: string, timeoutMs?: number, intervalMs?: number) => Promise<"ready" | "failed" | "timeout">;
        /** Send a JSON command to a tab's RPC pi session (prompt/steer/abort/…). */
        rpcSend: (id: string, cmd: Record<string, unknown>) => Promise<boolean>;
        /** Send a command and resolve with its response frame (id-matched). */
        rpcRequest: (id: string, cmd: Record<string, unknown>, timeoutMs?: number) => Promise<{ success: boolean; data?: unknown; error?: string }>;
        /** Fall back from the chat view to the full TUI for this tab (same id). */
        rpcSwitchToTerminal: (id: string) => Promise<string | null>;
        /** Switch back from the TUI to the chat view (same id). */
        rpcSwitchToChat: (id: string) => Promise<string | null>;
      };
      onTabData: (id: string, callback: (data: string) => void) => () => void;
      onTabExit: (id: string, callback: (code: number) => void) => () => void;
      /** RPC chat: parsed pi events (message_update, tool_execution_*, …). */
      onRpcEvent: (id: string, callback: (event: Record<string, unknown>) => void) => () => void;
      /** RPC chat: pi process exited. */
      onRpcExit: (id: string, callback: (code: number) => void) => () => void;
      /** RPC chat: extension UI dialog request (select/confirm/input/editor). */
      onRpcUiRequest: (id: string, callback: (req: Record<string, unknown>) => void) => () => void;
      /** RPC chat: answer an extension UI dialog ({value} | {confirmed} | {cancelled}). */
      rpcUiResponse: (id: string, response: Record<string, unknown>) => Promise<boolean>;
      appUpdate: {
        check: (force?: boolean) => Promise<{ current: string; latest: string | null; hasUpdate: boolean; downloadUrl?: string; releaseUrl?: string; notes?: string; error?: string }>;
        download: (url: string) => Promise<boolean>;
      };
      update: {
        check: (force?: boolean) => Promise<{ current: string | null; latest: string | null; hasUpdate: boolean; error?: string }>;
        run: () => Promise<{ ok: boolean; output: string; error?: string }>;
        /** App-bundled extensions re-shipped at startup (content changed), pull-once. */
        getExtensionSynced: () => Promise<{ files: string[] }>;
      };
      /** pi agent: progress dialog events + manual global-install entry. */
      piInstall: {
        run: () => Promise<{ ok: boolean; cancelled?: boolean }>;
        cancel: () => Promise<void>;
        onBegin: (callback: () => void) => () => void;
        onProgress: (callback: (p: { stage: string }) => void) => () => void;
        onResult: (callback: (r: { ok: boolean; error?: string; cancelled?: boolean }) => void) => () => void;
        onNotice: (callback: (n: { backend: string }) => void) => () => void;
      };
      diff: {
        list: (tabId: string) => Promise<{ isGit: boolean; initialized?: boolean; files: { status: string; path: string; additions: number; deletions: number }[]; error?: string }>;
        get: (tabId: string, path: string) => Promise<{ diff: string; isUntracked: boolean; error?: string }>;
        history: (tabId: string, path: string, events: unknown[]) => Promise<{ versions: { label: string; content: string }[]; error?: string }>;
        compare: (a: string, b: string, path: string) => Promise<{ diff: string }>;
        write: (tabId: string, path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
        commits: (tabId: string, path: string) => Promise<{ rev: string; subject: string }[]>;
        at: (tabId: string, path: string, rev?: string) => Promise<{ content: string; error?: string }>;
      };
      onWorkbenchCommand: (callback: (command: "project:open" | "remote:connect" | "session:new" | "session:close" | "view:toggle-viewer" | "view:toggle-theme" | "models:configure" | "help:shortcuts") => void) => () => void;
      onTabsUpdate: (callback: (tabs: TabSummary[]) => void) => () => void;
      onActiveTab: (callback: (payload: { id: string | null; cwd: string; isRemote?: boolean; sessions?: SessionListItem[] }) => void) => () => void;
      theme: {
        setMode: (mode: "dark" | "light") => Promise<boolean>;
      };
      file: {
        list: (tabId?: string, dirPath?: string, rootPath?: string, noCache?: boolean) => Promise<FileNode[]>;
        /** Lazy local tree: list one directory's children on expand. */
        listDirChildren: (rootPath: string | undefined, tabId: string | undefined, relDir: string, noCache?: boolean) => Promise<FileNode[]>;
        resolveLink: (input: { tabId?: string; rootPath?: string; currentPath?: string; href: string }) => Promise<{ ok: true; relPath: string; tabId?: string; rootPath?: string } | { ok: false }>;
        read: (tabId: string | undefined, relPath: string, rootPath?: string, mention?: boolean) => Promise<FileReadResult>;
        searchMentions: (tabId: string, query: string) => Promise<FileMentionResult>;
        write: (tabId: string | undefined, relPath: string, content: string, rootPath?: string) => Promise<FileOpResult>;
        mkdir: (tabId: string | undefined, relPath: string, rootPath?: string) => Promise<FileOpResult>;
        delete: (tabId: string | undefined, relPath: string, rootPath?: string) => Promise<FileOpResult>;
        rename: (tabId: string | undefined, relPath: string, newName: string, rootPath?: string) => Promise<FileOpResult>;
      };
      onAutoFollow: (callback: (ev: AutoFollowEvent) => void) => () => void;
      onAutoFollowStatus: (callback: (status: AutoFollowStatus) => void) => () => void;
      settings: {
        get: () => Promise<AppSettings>;
        set: (patch: Partial<AppSettings>) => Promise<AppSettings>;
      };
      project: {
        list: () => Promise<ProjectListItem[]>;
        addLocal: (cwd: string) => Promise<ProjectListItem>;
        addRemote: (remote: { host: string; user: string; port?: number; path: string; password?: string; agentDir?: string }) => Promise<ProjectListItem>;
        addWsl: (distro: string, path: string) => Promise<ProjectListItem>;
        delete: (id: string) => Promise<boolean>;
      };
      session: {
        list: (cwd?: string) => Promise<SessionListItem[]>;
        listProjects: () => Promise<string[]>;
        listRemote: (tabId: string, remoteCwd?: string) => Promise<RemoteSessionListResult>;
        delete: (path: string, tabId?: string) => Promise<{ ok: boolean; error?: string }>;
        rename: (path: string, name: string) => Promise<{ ok: boolean; error?: string }>;
        onRemoteUpdated: (callback: (payload: { tabId: string; remoteCwd: string; sessions: SessionListItem[] }) => void) => () => void;
        onLocalUpdated: (callback: (payload: { cwd: string; sessions: SessionListItem[] }) => void) => () => void;
        setRemoteHydrationPaused: (tabId: string, remoteCwd: string, paused: boolean) => Promise<boolean>;
        prioritizeRemote: (tabId: string, remoteCwd: string, priority?: number) => Promise<boolean>;
      };
      model: {
        list: () => Promise<ModelConfigItem[]>;
        add: (input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }) => Promise<ModelConfigItem>;
        update: (id: string, input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }) => Promise<ModelConfigItem>;
        discover: (input: { baseUrl: string; apiKey?: string }) => Promise<string[]>;
        delete: (id: string) => Promise<boolean>;
        checkSync: (input: { provider: string; model: string }) => Promise<{ ok: boolean; piModelsPath: string; providerExists: boolean; modelExists: boolean; listModelsContains: boolean; error?: string }>;
        listRemote: (remote: RemoteTarget) => Promise<ModelConfigItem[]>;
        addRemote: (input: { remote: RemoteTarget; baseUrl: string; apiKey?: string; model: string; provider: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }) => Promise<{ ok: boolean; provider: string }>;
        deleteRemote: (input: { remote: RemoteTarget; provider: string }) => Promise<boolean>;
        discoverRemote: (input: { remote: RemoteTarget; baseUrl: string; apiKey?: string }) => Promise<string[]>;
        transplantToWsl: (distro: string) => Promise<{ ok: boolean; error?: string; copied: string[] }>;
        transplantToRemote: (remote: RemoteTarget) => Promise<{ ok: boolean; error?: string; copied: string[] }>;
      };
      remote: {
        setBrowsePath: (tabId: string, path: string) => Promise<boolean>;
        getBrowsePath: (tabId: string) => Promise<string | null>;
        getInfo: (tabId: string) => Promise<{ host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean; agentDir?: string; isWsl?: boolean } | null>;
        listHistory: () => Promise<RemoteHistoryItem[]>;
        deleteHistory: (target: { host: string; user: string; port: number; agentDir?: string }) => Promise<boolean>;
      };
      wsl: {
        listDistros: () => Promise<Array<{ name: string; default: boolean; running: boolean; version: number }>>;
      };
      selectDir: () => Promise<string | null>;
    };
  }
}
