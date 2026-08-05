// Type bridge exposed by preload via contextBridge.
export {};

export interface FileNode {
  name: string;
  path: string; // relative to root, forward slashes
  type: "file" | "directory";
  children?: FileNode[];
}

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

export interface AutoFollowEvent {
  path: string;
  kind: "read" | "write";
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
          remote?: { host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean };
          wsl?: { distro: string; path?: string };
        }) => Promise<string>;
        close: (id: string) => Promise<boolean>;
        activate: (id: string) => Promise<boolean>;
        write: (id: string, data: string) => Promise<boolean>;
        resize: (id: string, cols: number, rows: number) => Promise<boolean>;
        alive: (id: string) => Promise<boolean>;
        list: () => Promise<TabSummary[]>;
        waitUntilAlive: (id: string, timeoutMs?: number, intervalMs?: number) => Promise<boolean>;
      };
      onTabData: (id: string, callback: (data: string) => void) => () => void;
      onTabExit: (id: string, callback: (code: number) => void) => () => void;
      onTabsUpdate: (callback: (tabs: TabSummary[]) => void) => () => void;
      onActiveTab: (callback: (payload: { id: string | null; cwd: string; isRemote?: boolean; sessions?: SessionListItem[] }) => void) => () => void;
      theme: {
        setMode: (mode: "dark" | "light") => Promise<boolean>;
      };
      file: {
        list: (tabId?: string, dirPath?: string, rootPath?: string) => Promise<FileNode[]>;
        read: (tabId: string | undefined, relPath: string, rootPath?: string) => Promise<FileReadResult>;
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
        addRemote: (remote: { host: string; user: string; port?: number; path: string; password?: string }) => Promise<ProjectListItem>;
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
        add: (input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[] }) => Promise<ModelConfigItem>;
        discover: (input: { baseUrl: string; apiKey?: string }) => Promise<string[]>;
        delete: (id: string) => Promise<boolean>;
        checkSync: (input: { provider: string; model: string }) => Promise<{ ok: boolean; piModelsPath: string; providerExists: boolean; modelExists: boolean; listModelsContains: boolean; error?: string }>;
        listRemote: (remote: RemoteTarget) => Promise<ModelConfigItem[]>;
        addRemote: (input: { remote: RemoteTarget; baseUrl: string; apiKey?: string; model: string; provider: string; availableModels?: string[] }) => Promise<{ ok: boolean; provider: string }>;
        deleteRemote: (input: { remote: RemoteTarget; provider: string }) => Promise<boolean>;
        discoverRemote: (input: { remote: RemoteTarget; baseUrl: string; apiKey?: string }) => Promise<string[]>;
        transplantToWsl: (distro: string) => Promise<{ ok: boolean; error?: string; copied: string[] }>;
        transplantToRemote: (remote: RemoteTarget) => Promise<{ ok: boolean; error?: string; copied: string[] }>;
      };
      remote: {
        setBrowsePath: (tabId: string, path: string) => Promise<boolean>;
        getBrowsePath: (tabId: string) => Promise<string | null>;
        getInfo: (tabId: string) => Promise<{ host: string; user: string; port?: number; path?: string; password?: string; startPi?: boolean; isWsl?: boolean } | null>;
        listHistory: () => Promise<RemoteHistoryItem[]>;
      };
      wsl: {
        listDistros: () => Promise<Array<{ name: string; default: boolean; running: boolean; version: number }>>;
      };
      selectDir: () => Promise<string | null>;
    };
  }
}
