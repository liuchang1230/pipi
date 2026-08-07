// Shared renderer types (moved out of App.tsx so the stores can import them
// without a circular dependency).

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface TabInfo {
  id: string;
  cwd: string;
  sessionPath?: string;
  title: string;
  isRemote?: boolean;
  remoteKey?: string;
  remoteHost?: string;
  remoteUser?: string;
  remotePort?: number;
  pi: boolean;
  isWsl?: boolean;
  wslDistro?: string;
  /** rpc = headless ChatPane (local tabs); pty/undefined = terminal view. */
  mode?: "rpc" | "pty";
}

export interface SessionItem {
  path: string;
  sessionId: string;
  mtime: number;
  messageCount: number;
  firstMessage: string;
  name: string | null;
}

export interface ProjectListItem {
  id: string;
  type: "local" | "remote" | "wsl";
  name: string;
  cwd?: string;
  host?: string;
  user?: string;
  port?: number;
  path?: string;
  password?: string;
  distro?: string;
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

export interface ProjectGroup {
  key: string;
  label: string;
  cwd: string;
  type: "local" | "remote";
  tabId?: string;
  host?: string;
  user?: string;
  port?: number;
  password?: string;
  sessions: SessionItem[];
  disabled?: boolean;
  error?: string;
  hydrationPhase?: RemoteHydrationState["phase"];
  diagnostics?: {
    resolvedCwd: string;
    sessionDir: string;
    fileCount: number;
  };
}

/** A WSL distro as a connection node: distro + its project folders. */
export interface WslConnectionGroup {
  distro: string;
  tabId?: string;
  connected: boolean;
  projects: ProjectGroup[];
}

export interface RemoteHydrationState {
  phase: "idle" | "loading" | "hydrating";
  tabId?: string;
  remoteCwd?: string;
}

export interface AutoFollowSettings {
  enabled: boolean;
  followReads: boolean;
}

export type ProjectSessionStatus = "idle" | "loading" | "ready" | "empty" | "error";

export type RemoteFileDiagnostics = {
  resolvedCwd: string;
  sessionDir: string;
  fileCount: number;
};
