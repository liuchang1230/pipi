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
  /** Explicit connection-shell classification supplied by main. Optimistic
   * client records omit it only until the authoritative tab update arrives. */
  kind?: "agent" | "connection";
  cwd: string;
  sessionPath?: string;
  title: string;
  isRemote?: boolean;
  remoteKey?: string;
  remoteHost?: string;
  remoteUser?: string;
  remotePort?: number;
  remoteAgentDir?: string;
  pi: boolean;
  isWsl?: boolean;
  wslDistro?: string;
  /** Project directory for remote/WSL tabs ("where this session runs").
   *  For those tabs `cwd` is the LOCAL path a new tab would inherit, so the
   *  project name/path shown in the UI comes from here. */
  remoteDir?: string;
  /** Present for WSL tabs: main's listTabs ships the pty TabInfo.wsl object
   *  ({distro, path}) across IPC; used to distinguish WSL (locally revealable
   *  via \\wsl$ UNC) from SSH remote origins. */
  wsl?: { distro: string; path?: string };
  /** rpc = headless ChatPane (remote/WSL); sdk = in-process ChatPane (local);
   *  pty/undefined = terminal view. */
  mode?: "rpc" | "sdk" | "pty";
  /** Connection shell tabs only: "ready" after the remote shell confirmed
   *  (__PIPI_READY__ marker), "failed" when ssh exited before that. */
  sshState?: "ready" | "failed";
  /** RPC remote tabs only: true once pi booted and answered get_state. A tab
   *  EXISTING must never read as "connected". */
  remoteReady?: boolean;
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
  agentDir?: string;
  distro?: string;
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

export interface ProjectGroup {
  key: string;
  label: string;
  cwd: string;
  type: "local" | "remote";
  tabId?: string;
  /** Connection profile key of the owning server (SSH). Tab-independent, so
   *  a project stays addressable while it has no open tab. */
  remoteKey?: string;
  host?: string;
  user?: string;
  port?: number;
  password?: string;
  agentDir?: string;
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

/** Honest connection status of an SSH server node in the sidebar. */
export type ServerStatus = "connected" | "connecting" | "failed" | "disconnected";

/** An SSH server as a sidebar connection node (the 远程服务器 section): the
 *  server itself plus the project folders hanging under it. Mirrors
 *  WslConnectionGroup for WSL distros. */
export interface RemoteServerGroup {
  key: string;
  host: string;
  user: string;
  port: number;
  agentDir?: string;
  password?: string;
  path?: string;
  label: string;
  /** connected = confirmed (ready marker or an open pi session tab);
   *  connecting = connection shell tab exists but not confirmed yet;
   *  failed = ssh exited before confirming; disconnected = no tab. */
  status: ServerStatus;
  /** Auth needs a password (probe result): the sidebar shows the dot in the
   *  "needs login" flavor and the click opens the login dialog. */
  needPassword?: boolean;
  tabId?: string;
  projects: ProjectGroup[];
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
  /** Profile-keyed hydration (no tab): the tab-independent identity. */
  remoteKey?: string;
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
