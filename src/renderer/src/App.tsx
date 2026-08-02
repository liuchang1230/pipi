/**
 * pi Desktop — three-panel layout with an embedded pi terminal.
 *
 * Left: file tree (top) + session list (bottom), following the active tab's cwd.
 * Middle: tab bar + xterm.js terminal running `pi` (the real TUI — every pi
 *         command, extension, and capability is available natively).
 * Right: read-only file viewer with Markdown preview + code highlighting;
 *        auto-follows the files pi's tools touch (via session-file watching).
 *
 * No SDK is embedded; pi runs as a CLI child process per tab. Pi updates keep
 * working as long as the CLI and JSONL format stay stable.
 */
import { useEffect, useRef, useState, useCallback, memo, useMemo } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_THEMES } from "../../shared/terminal-theme";
// Keep Windows IME candidate/preedit anchored to pi's visible TUI caret.
import { attachImeHeuristic } from "./xterm-ime-anchor";
import FileViewer, { type CurrentFile } from "./FileViewer";

// --- Types ------------------------------------------------------------------

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

interface TabInfo {
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
}

interface SessionItem {
  path: string;
  sessionId: string;
  mtime: number;
  messageCount: number;
  firstMessage: string;
  name: string | null;
}

interface ProjectListItem {
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

interface RemoteHistoryItem {
  id: string;
  host: string;
  user: string;
  port: number;
  password?: string;
  path?: string;
  updatedAt: number;
}

interface ProjectGroup {
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

interface RemoteHydrationState {
  phase: "idle" | "loading" | "hydrating";
  tabId?: string;
  remoteCwd?: string;
}

interface SidebarProps {
  leftWidth: number;
  sidebarRef: React.RefObject<HTMLDivElement>;
  sidebarSplit: number;
  theme: "dark" | "light";
  toggleTheme: () => void;
  selectedSessions: Set<string>;
  handleBatchDelete: () => void;
  setSelectedSessions: (next: Set<string>) => void;
  localProjectGroups: ProjectGroup[];
  remoteProjectGroups: ProjectGroup[];
  isRemote: boolean;
  cwd: string;
  remoteDir: string | null;
  expandedProjects: Set<string>;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, "idle" | "loading" | "ready" | "empty" | "error">;
  activeTab: string | null;
  tree: FileNode[];
  remoteHydration: RemoteHydrationState;
  fileTreeStatus: "idle" | "loading" | "refreshing" | "error";
  fileTreeError: string | null;
  onSidebarResizerDown: () => void;
  onToggleProject: (project: ProjectGroup) => void;
  onNewLocalProject: () => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onNewProjectSession: (project: ProjectGroup) => void;
  onAddRemoteProject: () => void;
  onOpenSession: (session: SessionItem, projectCwd?: string) => void;
  onOpenRemoteSession: (tabId: string, projectCwd: string, session: SessionItem) => void;
  onDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => void;
  onHandleSessionCtx: (e: React.MouseEvent, session: SessionItem) => void;
  onSelectAllSessions: (sessions: SessionItem[]) => void;
  onToggleSessionSelect: (path: string) => void;
  renderTree: (nodes: FileNode[], depth: number) => ReactNode;
}

interface TabBarProps {
  visibleTabs: TabInfo[];
  activeTab: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onShowRemote: () => void;
  onShowModels: () => void;
}

interface AutoFollowSettings {
  enabled: boolean;
  followReads: boolean;
}

interface ViewerPaneProps {
  viewerCollapsed: boolean;
  rightWidth: number;
  currentFile: CurrentFile | null;
  remoteLabel: string;
  onToggleViewer: () => void;
  fileLoading: boolean;
  followCfg: AutoFollowSettings;
  onFollowChange: (patch: Partial<AutoFollowSettings>) => void;
  followDegraded: boolean;
}

interface ModelConfigItem {
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

type ModelTarget =
  | { kind: "local" }
  | { kind: "remote"; index: number; host: string; user: string; port: number; password?: string; path?: string };

interface UseProjectsResult {
  projects: ProjectListItem[];
  remoteHistory: RemoteHistoryItem[];
  setRemoteHistory: Dispatch<SetStateAction<RemoteHistoryItem[]>>;
  upsertProject: (project: ProjectListItem) => void;
  refreshProjects: () => Promise<void>;
}

interface UseRemoteSessionHydrationArgs {
  projects: ProjectListItem[];
  tabs: TabInfo[];
  setRemoteSessions: Dispatch<SetStateAction<Record<string, SessionItem[]>>>;
  setProjectSessions: Dispatch<SetStateAction<Record<string, SessionItem[]>>>;
  setRemoteHydration: Dispatch<SetStateAction<RemoteHydrationState>>;
}

const remoteSessionCacheKey = (tabId: string, remoteCwd: string) => `${tabId}:${remoteCwd}`;
const buildRemoteKey = (host?: string, user?: string, port?: number) => `${user ?? ""}@${host ?? ""}:${port ?? 22}`;

interface UseFileTreeArgs {
  activeTab: string | null;
  isRemote: boolean;
  remoteDir: string | null;
  setCwd: Dispatch<SetStateAction<string>>;
  setRemoteDir: Dispatch<SetStateAction<string | null>>;
}

interface UseFileTreeResult {
  tree: FileNode[];
  setTree: Dispatch<SetStateAction<FileNode[]>>;
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  fileTreeStatus: "idle" | "loading" | "refreshing" | "error";
  fileTreeError: string | null;
  remoteTreeCache: Record<string, FileNode[]>;
  setRemoteTreeCache: Dispatch<SetStateAction<Record<string, FileNode[]>>>;
  loadTree: (dirPath?: string, tabId?: string, rootPath?: string, options?: { isRemote?: boolean }) => Promise<void>;
  navigateRemoteDir: (dirPath: string) => Promise<void>;
}

interface UseSessionManagerArgs {
  tabs: TabInfo[];
  cwd: string;
  activeTab: string | null;
  isRemote: boolean;
  remoteDir: string | null;
  setRemoteSessions: Dispatch<SetStateAction<Record<string, SessionItem[]>>>;
  loadProjects: () => Promise<void>;
  onLocalSessionsDeleted?: (paths: string[]) => void;
}

interface UseSessionManagerResult {
  sessions: SessionItem[];
  setSessions: Dispatch<SetStateAction<SessionItem[]>>;
  selectedSessions: Set<string>;
  setSelectedSessions: Dispatch<SetStateAction<Set<string>>>;
  loadSessions: (cwd?: string) => Promise<void>;
  handleOpenSession: (session: SessionItem, projectCwd?: string) => Promise<void>;
  handleOpenRemoteSession: (tabId: string, projectCwd: string, session: SessionItem) => Promise<void>;
  handleDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => Promise<void>;
  handleBatchDelete: (tabId?: string, projectCwd?: string) => Promise<void>;
  toggleSessionSelect: (path: string) => void;
  selectAllSessions: (sessions: SessionItem[]) => void;
}

interface UseProjectExplorerArgs {
  expandedProjects: Set<string>;
  projectTrees: Record<string, FileNode[]>;
  projectSessions: Record<string, SessionItem[]>;
  remoteSessions: Record<string, SessionItem[]>;
  remoteTreeCache: Record<string, FileNode[]>;
  loadProjects: () => Promise<void>;
  loadTree: (dirPath?: string, tabId?: string, rootPath?: string, options?: { isRemote?: boolean }) => Promise<void>;
  setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
  setProjectLoading: Dispatch<SetStateAction<Record<string, boolean>>>;
  setProjectSessionStatus: Dispatch<SetStateAction<Record<string, "idle" | "loading" | "ready" | "empty" | "error">>>;
  setProjectErrors: Dispatch<SetStateAction<Record<string, string | undefined>>>;
  setProjectDiagnostics: Dispatch<SetStateAction<Record<string, { resolvedCwd: string; sessionDir: string; fileCount: number } | undefined>>>;
  setProjectSessions: Dispatch<SetStateAction<Record<string, SessionItem[]>>>;
  setProjectTrees: Dispatch<SetStateAction<Record<string, FileNode[]>>>;
  setRemoteHydration: Dispatch<SetStateAction<RemoteHydrationState>>;
  setRemoteSessions: Dispatch<SetStateAction<Record<string, SessionItem[]>>>;
  setRemoteTreeCache: Dispatch<SetStateAction<Record<string, FileNode[]>>>;
  setTree: Dispatch<SetStateAction<FileNode[]>>;
  setCwd: Dispatch<SetStateAction<string>>;
  setRemoteDir: Dispatch<SetStateAction<string | null>>;
  setIsRemote: Dispatch<SetStateAction<boolean>>;
  setRemoteLabel: Dispatch<SetStateAction<string>>;
  setActiveTab: Dispatch<SetStateAction<string | null>>;
  cwd: string;
}

interface UseProjectExplorerResult {
  toggleProject: (project: ProjectGroup) => Promise<void>;
  handleDeleteProject: (project: ProjectGroup) => Promise<void>;
  handleNewProjectSession: (project: ProjectGroup) => Promise<void>;
}

// --- Terminal component (one xterm per tab) ---------------------------------

interface TerminalViewProps {
  tabId: string;
  theme: "dark" | "light";
  onResize: (cols: number, rows: number) => void;
}

function TerminalView({ tabId, theme, onResize }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Sarasa Mono SC", "Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "Microsoft YaHei", "Consolas", monospace',
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 10000,
      smoothScrollDuration: 0,
      scrollOnUserInput: true,
      theme: TERMINAL_THEMES[theme].xterm,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const ime = attachImeHeuristic(term);

    // Pipe user input → pty.
    const disp = term.onData((data) => {
      window.api.tab.write(tabId, data);
    });

    // Copy / paste handling — terminal eats Ctrl+C/V so we intercept here.
    const keyHandler = (e: KeyboardEvent) => {
      // Shift+Enter → insert newline (pi keybinding `tui.input.newLine`)
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.type === "keydown") {
        window.api.tab.write(tabId, "\n");
        return false;
      }
      if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {
          document.execCommand("copy");
        });
        return false;
      }
      if (e.ctrlKey && e.key === "v" && e.type === "keydown") {
        navigator.clipboard.readText().then((text) => {
          term.paste(text);
        }).catch(() => {});
        return false;
      }
      return true;
    };
    term.attachCustomKeyEventHandler(keyHandler);

    // Right-click context menu for copy/paste.
    const ctxHandler = (e: MouseEvent) => {
      e.preventDefault();
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {
          document.execCommand("copy");
        });
      } else {
        navigator.clipboard.readText().then((text) => {
          term.paste(text);
        }).catch(() => {});
      }
    };
    term.element?.addEventListener("contextmenu", ctxHandler);
    // Pipe pty output → terminal. pi queries the terminal's color scheme
    // with `CSI ? 996 n` at startup; answer it (1=dark, 2=light) so pi's
    // auto theme resolves to the app's mode deterministically, and so pi
    // keeps its color-scheme notification listener armed (auto sync).
    let schemeBuf = "";
    const offData = window.api.onTabData(tabId, (data) => {
      term.write(data);
      schemeBuf += data;
      if (schemeBuf.includes("\x1b[?996n")) {
        schemeBuf = "";
        window.api.tab.write(tabId, themeRef.current === "dark" ? "\x1b[?997;1n" : "\x1b[?997;2n");
      } else if (schemeBuf.length > 32) {
        schemeBuf = schemeBuf.slice(-32);
      }
    });
    const offExit = window.api.onTabExit(tabId, () => {
      term.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
    });

    // Report initial size.
    onResize(term.cols, term.rows);

    // Resize observer → refit + notify pty.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width === sizeRef.current.width && height === sizeRef.current.height) return;
      sizeRef.current = { width, height };
      try {
        const viewportY = term.buffer.active.viewportY;
        fit.fit();
        if (viewportY > 0) term.scrollToLine(viewportY);
        onResize(term.cols, term.rows);
      } catch {
        /* container not ready */
      }
    });
    const rect = containerRef.current.getBoundingClientRect();
    sizeRef.current = { width: Math.round(rect.width), height: Math.round(rect.height) };
    ro.observe(containerRef.current);

    return () => {
      term.element?.removeEventListener("contextmenu", ctxHandler);
      disp.dispose();
      offData();
      offExit();
      ro.disconnect();
      ime.detach();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Update theme without destroying the terminal.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.theme = TERMINAL_THEMES[theme].xterm;
  }, [theme]);

  return <div className="terminal-container" ref={containerRef} />;
}

interface TerminalHostProps {
  visibleTabs: TabInfo[];
  activeTab: string | null;
  theme: "dark" | "light";
}

const TerminalHost = memo(function TerminalHost({ visibleTabs, activeTab, theme }: TerminalHostProps) {
  const tabIds = useMemo(() => visibleTabs.map((t) => t.id), [visibleTabs]);
  return (
    <div className="terminal-wrap">
      {visibleTabs.length === 0 ? (
        <div className="placeholder">点击 + 开始（或从左侧选择一个会话）</div>
      ) : (
        visibleTabs.map((tab) => (
          <div key={tab.id} className={`terminal-pane${tab.id === activeTab ? " active" : " hidden"}`}>
            <TerminalView
              tabId={tab.id}
              theme={theme}
              onResize={(cols, rows) => window.api.tab.resize(tab.id, cols, rows)}
            />
          </div>
        ))
      )}
    </div>
  );
});

// --- App --------------------------------------------------------------------

export default function App() {
  // --- Theme ---
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("pi-theme");
    return (stored === "light" || stored === "dark") ? stored : "dark";
  });
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("pi-theme", theme);
    // Tell the main process which mode to render; it injects COLORFGBG
    // into every new pty (local + remote) so pi matches the app.
    window.api.theme.setMode(theme).catch(() => {});
    // Live color-scheme push: pi listens for `CSI ? 997 ; N n` while its
    // settings use the auto light/dark mapping (which the app enforces), so
    // a running pi swaps its whole palette to match the app's new mode
    // without a reconnect. Only tabs running the pi TUI receive this (a
    // plain remote shell would treat the sequence as input noise).
    const seq = theme === "dark" ? "\x1b[?997;1n" : "\x1b[?997;2n";
    for (const tab of tabs) {
      if (tab.pi) {
        window.api.tab.write(tab.id, seq).catch(() => {});
      }
    }
  }, [theme, tabs]);
  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [isRemote, setIsRemote] = useState(false);
  const [remoteDir, setRemoteDir] = useState<string | null>(null);
  const [remoteLabel, setRemoteLabel] = useState("");
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [pickerPath, setPickerPath] = useState("~");
  const [pickerEntries, setPickerEntries] = useState<FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const pickerTabRef = useRef<string | null>(null);
  const [cwd, setCwd] = useState<string>("");
  const { tree, setTree, expanded, setExpanded, fileTreeStatus, fileTreeError, remoteTreeCache, setRemoteTreeCache, loadTree, navigateRemoteDir } = useFileTree({ activeTab, isRemote, remoteDir, setCwd, setRemoteDir });
  const [remoteSessions, setRemoteSessions] = useState<Record<string, SessionItem[]>>({});
  const [projectSessions, setProjectSessions] = useState<Record<string, SessionItem[]>>({});
  const [projectLoading, setProjectLoading] = useState<Record<string, boolean>>({});
  const [projectSessionStatus, setProjectSessionStatus] = useState<Record<string, "idle" | "loading" | "ready" | "empty" | "error">>({});
  const [projectErrors, setProjectErrors] = useState<Record<string, string | undefined>>({});
  const [projectDiagnostics, setProjectDiagnostics] = useState<Record<string, { resolvedCwd: string; sessionDir: string; fileCount: number } | undefined>>({});
  const [projectTrees, setProjectTrees] = useState<Record<string, FileNode[]>>({});
  const { projects, remoteHistory, setRemoteHistory, upsertProject, refreshProjects: loadProjects } = useProjects();
  const [selectedRemoteHistory, setSelectedRemoteHistory] = useState("");
  const [remoteHydration, setRemoteHydration] = useState<RemoteHydrationState>({ phase: "idle" });
  const [currentFile, setCurrentFile] = useState<CurrentFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [followCfg, setFollowCfg] = useState<AutoFollowSettings>({ enabled: true, followReads: true });
  const [followDegraded, setFollowDegraded] = useState(false);
  const [followSettingsState, setFollowSettingsState] = useState<"loading" | "ready" | "error">("loading");
  // Refs so the stable auto-follow listener never reads stale closures.
  const currentFileRef = useRef<CurrentFile | null>(null);
  const followCfgRef = useRef(followCfg);
  const openFileRef = useRef<((relPath: string, followed: boolean) => Promise<void>) | null>(null);
  const fileReqSeq = useRef(0);
  const manualPendingRef = useRef<number | null>(null); // seq of in-flight manual open
  const followTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  const [sidebarSplit, setSidebarSplit] = useState(55); // % for file tree
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(420);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [models, setModels] = useState<ModelConfigItem[]>([]);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [modelName, setModelName] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelIdValue, setModelIdValue] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [modelTarget, setModelTarget] = useState<ModelTarget>({ kind: "local" });
  const [modelRemoteLoading, setModelRemoteLoading] = useState(false);

  // --- Remote dialog ---
  const [showRemote, setShowRemote] = useState(false);
  const [remoteHost, setRemoteHost] = useState("");
  const [remoteUser, setRemoteUser] = useState("");
  const [remotePort, setRemotePort] = useState("22");
  const [remotePath, setRemotePath] = useState("");
  const [remotePassword, setRemotePassword] = useState("");
  const [remoteStatus, setRemoteStatus] = useState<"" | "connecting" | "connected" | "failed">("");
  const [toast, setToast] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const loadModels = useCallback(async () => {
    try {
      setModels(await window.api.model.list());
    } catch {
      setModels([]);
    }
  }, []);
  const showToast = useCallback((text: string, type: "ok" | "err") => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleDiscoverModels = useCallback(async () => {
    if (!modelBaseUrl.trim()) {
      showToast("请先填写 Base URL", "err");
      return;
    }
    setDiscoveringModels(true);
    try {
      let list: string[];
      if (modelTarget.kind === "remote") {
        list = await window.api.model.discoverRemote({
          remote: { host: modelTarget.host, user: modelTarget.user, port: modelTarget.port, password: modelTarget.password, path: modelTarget.path },
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
        });
      } else {
        list = await window.api.model.discover({
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
        });
      }
      setDiscoveredModels(list);
      if (list.length > 0 && !list.includes(modelIdValue)) {
        setModelIdValue(list[0]);
      }
      showToast(list.length > 0 ? `已检索到 ${list.length} 个模型${modelTarget.kind === "remote" ? "（远程）" : ""}` : "未检索到模型", list.length > 0 ? "ok" : "err");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "模型检索失败", "err");
    } finally {
      setDiscoveringModels(false);
    }
  }, [modelApiKey, modelBaseUrl, modelIdValue, modelTarget, showToast]);

  const loadRemoteModels = useCallback(async (target: Extract<ModelTarget, { kind: "remote" }>) => {
    setModelRemoteLoading(true);
    try {
      setModels(await window.api.model.listRemote({ host: target.host, user: target.user, port: target.port, password: target.password, path: target.path }));
    } catch (error) {
      setModels([]);
      showToast(error instanceof Error ? error.message : "读取远程配置失败", "err");
    } finally {
      setModelRemoteLoading(false);
    }
  }, [showToast]);

  const onModelTargetChange = useCallback((value: string) => {
    if (value === "local") {
      setModelTarget({ kind: "local" });
      void loadModels();
      setDiscoveredModels([]);
      setModelIdValue("");
      return;
    }
    const idx = Number(value.replace(/^remote:/, ""));
    const rh = remoteHistory[idx];
    if (!rh) return;
    const target: Extract<ModelTarget, { kind: "remote" }> = {
      kind: "remote",
      index: idx,
      host: rh.host,
      user: rh.user,
      port: rh.port ?? 22,
      password: rh.password,
      path: rh.path,
    };
    setModelTarget(target);
    void loadRemoteModels(target);
    setDiscoveredModels([]);
    setModelIdValue("");
  }, [remoteHistory, loadModels, loadRemoteModels]);

  const openModelConfig = useCallback(() => {
    // Default target follows the active tab.
    const active = tabs.find((t) => t.id === activeTab);
    let target: ModelTarget = { kind: "local" };
    if (active?.isRemote && active.remoteHost && active.remoteUser) {
      const rh = remoteHistory.find(
        (h) => h.host === active.remoteHost && h.user === active.remoteUser && (h.port ?? 22) === (active.remotePort ?? 22),
      );
      if (rh) {
        const idx = remoteHistory.indexOf(rh);
        target = { kind: "remote", index: idx, host: rh.host, user: rh.user, port: rh.port ?? 22, password: rh.password, path: rh.path };
      }
    }
    setModelTarget(target);
    setShowModelConfig(true);
    void (target.kind === "remote" ? loadRemoteModels(target) : loadModels());
  }, [tabs, activeTab, remoteHistory, loadModels, loadRemoteModels]);

  // --- Session context menu ---
  const [ctxMenuSession, setCtxMenuSession] = useState<SessionItem | null>(null);
  const [ctxMenuPos, setCtxMenuPos] = useState({ x: 0, y: 0 });
  const [renameSession, setRenameSession] = useState<SessionItem | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // --- Tab events ---
  useEffect(() => {
    void loadModels();
    const offTabs = window.api.onTabsUpdate((list) => setTabs(list));
    const offActive = window.api.onActiveTab(async ({ id, cwd: c, isRemote: r }) => {
      setActiveTab(id);
      setIsRemote(r ?? false);
      if (!id) {
        setCwd("");
        setRemoteDir(null);
        setRemoteLabel("");
        setTree([]);
        return;
      }
      if (r) {
        // Watcher is stopped for remote tabs; nothing will replace the viewer
        // content, so clear the previous (local) file to avoid a stale view.
        setCurrentFile(null);
        const browsePath = (await window.api.remote.getBrowsePath(id)) ?? c;
        const remoteInfo = await window.api.remote.getInfo(id);
        setCwd(browsePath);
        setRemoteDir(browsePath);
        setRemoteLabel(remoteInfo ? `${remoteInfo.user}@${remoteInfo.host}` : "远程");
        loadTree(browsePath, id);
      } else {
        setCwd(c);
        setRemoteDir(null);
        setRemoteLabel("");
        loadTree(undefined, id);
        loadSessions(c);
      }
    });
    // Initial fetch in case the main process already created the first tab.
    window.api.tab.list().then((list) => {
      setTabs(list);
    });
    return () => {
      offTabs();
      offActive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadModels]);

  // --- Auto-follow ---
  // Keep refs in sync so the stable listener below never sees stale values.
  useEffect(() => {
    currentFileRef.current = currentFile;
    followCfgRef.current = followCfg;
    openFileRef.current = openFile;
  });

  // Load persisted auto-follow settings once.
  useEffect(() => {
    let alive = true;
    window.api.settings
      .get()
      .then((s) => {
        if (!alive) return;
        setFollowCfg(s.autoFollow);
        setFollowSettingsState("ready");
      })
      .catch(() => {
        // Load failed: keep UI usable; user toggles will persist (merged with
        // whatever is on disk) once they act.
        if (alive) setFollowSettingsState("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Persist on change (never during the initial load, to avoid clobbering
  // stored values with defaults).
  useEffect(() => {
    if (followSettingsState === "loading") return;
    void window.api.settings.set({ autoFollow: followCfg }).catch(() => {
      /* persistence is best-effort */
    });
  }, [followCfg, followSettingsState]);

  const handleFollowChange = useCallback((patch: Partial<AutoFollowSettings>) => {
    setFollowCfg((prev) => ({ ...prev, ...patch }));
  }, []);

  // Trailing debounce + latest-wins sequencing: a burst of follow events
  // (e.g. session-resume replay) collapses to the last file, and a stale
  // in-flight read can never overwrite a newer one.
  const scheduleFollow = useCallback((path: string) => {
    if (followTimer.current) clearTimeout(followTimer.current);
    followTimer.current = setTimeout(() => {
      // Re-verify at fire time — the user may have acted during the debounce.
      if (!followCfgRef.current.enabled) return;
      if (manualPendingRef.current !== null) return; // a manual open is in flight
      const cur = currentFileRef.current;
      if (cur && !cur.followed) return; // now pinned by a manual open
      void openFileRef.current?.(path, true);
    }, 180);
  }, []);

  // A tab switch makes any pending auto-follow open's context stale.
  useEffect(() => {
    if (followTimer.current) clearTimeout(followTimer.current);
  }, [activeTab, isRemote]);

  useEffect(() => {
    const off = window.api.onAutoFollow(({ path, kind }) => {
      const cfg = followCfgRef.current;
      if (!cfg.enabled) return;
      if (kind === "read" && !cfg.followReads) return;
      const cur = currentFileRef.current;
      // Pin: a manually opened file is never yanked away by auto-follow.
      if (cur && !cur.followed) return;
      // Dedup: a read of the currently displayed file changes nothing.
      if (cur && cur.path === path && kind === "read") return;
      scheduleFollow(path);
    });
    const offStatus = window.api.onAutoFollowStatus((status) => {
      if (status.ok) {
        setFollowDegraded(false);
        return;
      }
      setFollowDegraded(true);
      showToast("自动跟随已降级：会话日志格式不兼容", "err");
    });
    return () => {
      off();
      offStatus();
    };
    // No isRemote guard here: main stops the watcher before activating a remote
    // tab, and IPC ordering guarantees pending follow events arrive first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast, scheduleFollow]);

  // --- File tree ---

  // 本地会话被删除后刷新对应项目的 projectSessions 缓存，避免侧边栏残留已删会话
  const handleLocalSessionsDeleted = useCallback((deletedPaths: string[]) => {
    if (deletedPaths.length === 0) return;
    const deletedSet = new Set(deletedPaths);
    for (const p of projects) {
      if (p.type !== "local" || !p.cwd) continue;
      const cached = projectSessions[p.id];
      if (!cached?.some((s) => deletedSet.has(s.path))) continue;
      setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "loading" }));
      void window.api.session.list(p.cwd)
        .then((list) => {
          setProjectSessions((prev) => ({ ...prev, [p.id]: list as SessionItem[] }));
          setProjectSessionStatus((prev) => ({ ...prev, [p.id]: list.length > 0 ? "ready" : "empty" }));
        })
        .catch(() => {
          setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "error" }));
        });
    }
  }, [projects, projectSessions]);

  // --- Sessions ---
  const {
    sessions,
    setSessions,
    selectedSessions,
    setSelectedSessions,
    loadSessions,
    handleOpenSession,
    handleOpenRemoteSession,
    handleDeleteSession,
    handleBatchDelete,
    toggleSessionSelect,
    selectAllSessions,
  } = useSessionManager({ tabs, cwd, activeTab, isRemote, remoteDir, setRemoteSessions, loadProjects, onLocalSessionsDeleted: handleLocalSessionsDeleted });

  useRemoteSessionHydration({ projects, tabs, setRemoteSessions, setProjectSessions, setRemoteHydration });


  // --- File viewer ---
  const openFile = useCallback(async (relPath: string, followed: boolean) => {
    // Every open is a numbered request; only the latest one may render.
    // This protects both directions: a stale follow read must not overwrite a
    // manual open, and vice versa.
    const seq = ++fileReqSeq.current;
    if (!followed) manualPendingRef.current = seq;
    setFileLoading(true);
    try {
      const res = await window.api.file.read(activeTab ?? undefined, relPath);
      if (seq !== fileReqSeq.current) return; // a newer request already won
      setCurrentFile({
        path: relPath,
        content: res.content,
        bytes: res.bytes,
        isBinary: res.isBinary,
        followed,
        source: isRemote ? "remote" : "local",
        sourceLabel: isRemote ? `${remoteLabel}${remoteDir ? `:${remoteDir}` : ""}` : cwd,
      });
    } catch (error) {
      if (seq === fileReqSeq.current) {
        showToast(error instanceof Error ? error.message : "读取文件失败", "err");
      }
    } finally {
      if (manualPendingRef.current === seq) manualPendingRef.current = null;
      if (seq === fileReqSeq.current) setFileLoading(false);
    }
  }, [activeTab, cwd, isRemote, remoteDir, remoteLabel, showToast]);

  // --- Tab actions ---
  const handleNewTab = useCallback(async () => {
    if (isRemote && activeTab) {
      const remote = await window.api.remote.getInfo(activeTab);
      if (remote) {
        await window.api.tab.create({
          cwd: cwd || ".",
          remote: {
            host: remote.host,
            user: remote.user,
            port: remote.port,
            path: remoteDir || remote.path,
            password: remote.password,
          },
        });
        return;
      }
    }
    const c = cwd || "D:/其余文件/项目/agent";
    await window.api.tab.create({ cwd: c });
  }, [activeTab, cwd, isRemote, remoteDir]);

  const handleCloseTab = useCallback(async (id: string) => {
    await window.api.tab.close(id);
  }, []);

  const handleSelectTab = useCallback(async (id: string) => {
    await window.api.tab.activate(id);
  }, []);

  const handleSelectDir = useCallback(async () => {
    const dir = await window.api.selectDir();
    if (!dir) return;
    const project = await window.api.project.addLocal(dir);
    upsertProject(project);
    await loadProjects();
    await window.api.tab.create({ cwd: dir });
  }, [loadProjects, upsertProject]);

  // --- Remote connection ---
  const handleRemote = useCallback(async () => {
    if (!remoteHost || !remoteUser) return;
    const host = remoteHost.trim();
    const user = remoteUser.trim();
    setRemoteStatus("connecting");
    try {
      const id = await window.api.tab.create({
        cwd: cwd || ".",
        remote: {
          host,
          user,
          port: parseInt(remotePort) || 22,
          path: remotePath.trim() || undefined,
          password: remotePassword || undefined,
          startPi: false,
        },
      });
      const ok = await window.api.tab.waitUntilAlive(id, 3000, 200);
      if (ok) {
        setRemoteStatus("connected");
        showToast(`已连接到 ${user}@${host}`, "ok");
        setShowRemote(false);
      } else {
        setRemoteStatus("failed");
        showToast(`连接失败: ${user}@${host}`, "err");
      }
      setRemoteHistory(await window.api.remote.listHistory() as RemoteHistoryItem[]);
      const matchingProjects = projects.filter((p) => p.type === "remote" && p.host === host && p.user === user && (p.port ?? 22) === (parseInt(remotePort) || 22));
      for (const p of matchingProjects) {
        setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "loading" }));
        window.api.session.listRemote(id, p.path).then((result) => {
          setProjectSessions((prev) => ({ ...prev, [p.id]: result.sessions as SessionItem[] }));
          setProjectErrors((prev) => ({ ...prev, [p.id]: result.error }));
          setProjectDiagnostics((prev) => ({ ...prev, [p.id]: result.diagnostics }));
          setProjectSessionStatus((prev) => ({ ...prev, [p.id]: result.error ? "error" : result.sessions.length > 0 ? "ready" : "empty" }));
        }).catch(() => {
          setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "error" }));
        });
        window.api.file.list(id, p.path).then((nodes) => {
          setProjectTrees((prev) => ({ ...prev, [p.id]: nodes as FileNode[] }));
        }).catch(() => undefined);
      }
      setRemoteHost(""); setRemoteUser(""); setRemotePort("22"); setRemotePath(""); setRemotePassword("");
      setSelectedRemoteHistory("");
    } catch (e) {
      console.error("[remote] failed:", e);
      setRemoteStatus("failed");
      showToast(`连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, [cwd, projects, remotePort, remotePath, remotePassword, showToast]);

  // --- Remote directory picker ---
  const openRemotePicker = useCallback(async (startPath?: string) => {
    const tabId = pickerTabRef.current ?? activeTab ?? undefined;
    const p = startPath || remoteDir || "~";
    setPickerPath(p);
    setShowRemotePicker(true);
    setPickerLoading(true);
    try {
      const entries = (await window.api.file.list(tabId, p)) as FileNode[];
      setPickerEntries(entries);
    } catch {
      setPickerEntries([{ name: "（远程目录加载失败）", path: "", type: "file" }]);
    }
    setPickerLoading(false);
  }, [activeTab, remoteDir]);

  const handleAddRemoteProject = useCallback(async () => {
    // Find any connection-only remote tab — not just the active one.
    const remoteTab = tabs.find((t) => t.isRemote);
    if (!remoteTab) {
      alert("未连接远程终端，先点击顶部的 🌐 连接远程。\n连接成功后，再点这里的 + 选择远程项目目录。");
      return;
    }
    pickerTabRef.current = remoteTab.id;
    await openRemotePicker(remoteDir || await window.api.remote.getBrowsePath(remoteTab.id) || "~");
  }, [tabs, openRemotePicker, remoteDir]);

  const pickerNavigate = useCallback(async (dir: string) => {
    const tabId = pickerTabRef.current ?? activeTab ?? undefined;
    setPickerPath(dir);
    setPickerLoading(true);
    try {
      const entries = (await window.api.file.list(tabId, dir)) as FileNode[];
      setPickerEntries(entries);
    } catch {
      setPickerEntries([{ name: "（远程目录加载失败）", path: "", type: "file" }]);
    }
    setPickerLoading(false);
  }, [activeTab]);

  const pickerSelect = useCallback(async () => {
    const tabId = pickerTabRef.current ?? activeTab ?? undefined;
    if (tabId) {
      const remote = await window.api.remote.getInfo(tabId);
      if (remote) {
        const project = await window.api.project.addRemote({
          host: remote.host,
          user: remote.user,
          port: remote.port,
          path: pickerPath,
          password: remote.password,
        });
        upsertProject(project);
        await loadProjects();
      }
    }
    setShowRemotePicker(false);
    pickerTabRef.current = null;
  }, [activeTab, loadProjects, pickerPath, upsertProject]);

  // --- Session actions ---
  const { toggleProject, handleDeleteProject, handleNewProjectSession } = useProjectExplorer({
    expandedProjects,
    projectTrees,
    projectSessions,
    remoteSessions,
    remoteTreeCache,
    loadProjects,
    loadTree,
    setExpandedProjects,
    setProjectLoading,
    setProjectSessionStatus,
    setProjectErrors,
    setProjectDiagnostics,
    setProjectSessions,
    setProjectTrees,
    setRemoteHydration,
    setRemoteSessions,
    setRemoteTreeCache,
    setTree,
    setCwd,
    setRemoteDir,
    setIsRemote,
    setRemoteLabel,
    setActiveTab,
    cwd,
  });

  const handleSessionCtx = useCallback((e: React.MouseEvent, s: SessionItem) => {
    e.preventDefault();
    setCtxMenuSession(s);
    setCtxMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleRenameStart = useCallback(() => {
    if (!ctxMenuSession) return;
    setRenameSession(ctxMenuSession);
    setRenameValue(ctxMenuSession.name || "");
    setCtxMenuSession(null);
  }, [ctxMenuSession]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renameSession) return;
    const r = await window.api.session.rename(renameSession.path, renameValue.trim());
    if (!r.ok) { alert(`重命名失败: ${r.error}`); return; }
    setRenameSession(null);
    loadSessions(cwd);
  }, [renameSession, renameValue, cwd, loadSessions]);

  const handleCtxDelete = useCallback(async () => {
    if (!ctxMenuSession) return;
    await handleDeleteSession(ctxMenuSession);
    setCtxMenuSession(null);
  }, [ctxMenuSession, handleDeleteSession]);

  // --- Batch session selection ---

  // --- Resizers ---
  const sidebarDragRef = useRef(false);
  const leftPaneDragRef = useRef(false);
  const rightPaneDragRef = useRef(false);
  const onSidebarResizerDown = () => { sidebarDragRef.current = true; };
  const onLeftPaneResizerDown = () => { leftPaneDragRef.current = true; };
  const onRightPaneResizerDown = () => { rightPaneDragRef.current = true; };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (sidebarDragRef.current && sidebarRef.current) {
        const rect = sidebarRef.current.getBoundingClientRect();
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        setSidebarSplit(Math.max(20, Math.min(80, pct)));
      }
      if (leftPaneDragRef.current) {
        setLeftWidth(Math.max(220, Math.min(520, e.clientX)));
      }
      if (rightPaneDragRef.current) {
        setRightWidth(Math.max(320, Math.min(900, window.innerWidth - e.clientX)));
      }
    };
    const onUp = () => {
      sidebarDragRef.current = false;
      leftPaneDragRef.current = false;
      rightPaneDragRef.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // --- Tree rendering ---
  const toggleDir = (path: string) => {
    if (isRemote) {
      void navigateRemoteDir(path);
    } else {
      setExpanded((prev) => {
        const n = new Set(prev);
        if (n.has(path)) n.delete(path);
        else n.add(path);
        return n;
      });
    }
  };

  const renderTree = (nodes: FileNode[], depth: number): React.ReactNode => {
    return nodes.map((node) => (
      <TreeBranch
        key={node.path}
        node={node}
        depth={depth}
        expandedPaths={expanded}
        onToggle={toggleDir}
        onOpen={openFile}
      />
    ));
  };

  const localProjectGroups: ProjectGroup[] = projects
    .filter((p) => p.type === "local" && p.cwd)
    .map((p) => ({
      key: p.id,
      label: p.name,
      cwd: p.cwd!,
      type: "local",
      sessions: projectSessions[p.id] ?? [],
    }));

  const connectedRemoteKeys = new Set(
    tabs
      .filter((t) => t.isRemote && t.remoteKey)
      .map((t) => t.remoteKey as string),
  );

  const remoteProjectGroups: ProjectGroup[] = projects
    .filter((p) => p.type === "remote" && p.path && p.host && p.user)
    .map((p) => {
      const projectRemoteKey = buildRemoteKey(p.host, p.user, p.port);
      const connectionTab = tabs.find((t) => t.isRemote && t.remoteKey === projectRemoteKey);
      const tab = connectionTab;
      const connected = connectedRemoteKeys.has(projectRemoteKey);
      const isHydratingTarget = remoteHydration.tabId === tab?.id && remoteHydration.remoteCwd === p.path;
      return {
        key: p.id,
        label: p.name,
        cwd: p.path!,
        type: "remote" as const,
        tabId: tab?.id,
        host: p.host,
        user: p.user,
        port: p.port,
        password: p.password,
        sessions: projectSessions[p.id] ?? (tab ? (remoteSessions[remoteSessionCacheKey(tab.id, p.path!)] ?? []) : []),
        disabled: !connected,
        error: projectErrors[p.id],
        hydrationPhase: isHydratingTarget ? remoteHydration.phase : "idle",
        diagnostics: projectDiagnostics[p.id],
      };
    });

  const visibleTabs = tabs.filter((t) => !t.title.endsWith(" · 连接"));

  // --- Render ---
  return (
    <div className={`app${viewerCollapsed ? " viewer-hidden" : ""}`}>
      <Sidebar
        leftWidth={leftWidth}
        sidebarRef={sidebarRef}
        sidebarSplit={sidebarSplit}
        theme={theme}
        toggleTheme={toggleTheme}
        selectedSessions={selectedSessions}
        handleBatchDelete={() => void handleBatchDelete(activeTab ?? undefined, remoteDir ?? undefined)}
        setSelectedSessions={setSelectedSessions}
        localProjectGroups={localProjectGroups}
        remoteProjectGroups={remoteProjectGroups}
        isRemote={isRemote}
        cwd={cwd}
        remoteDir={remoteDir}
        expandedProjects={expandedProjects}
        projectLoading={projectLoading}
        projectSessionStatus={projectSessionStatus}
        activeTab={activeTab}
        tree={tree}
        remoteHydration={remoteHydration}
        fileTreeStatus={fileTreeStatus}
        fileTreeError={fileTreeError}
        onSidebarResizerDown={onSidebarResizerDown}
        onToggleProject={(project) => void toggleProject(project)}
        onNewLocalProject={() => void handleSelectDir()}
        onDeleteProject={(project) => void handleDeleteProject(project)}
        onNewProjectSession={(project) => void handleNewProjectSession(project)}
        onAddRemoteProject={() => void handleAddRemoteProject()}
        onOpenSession={(session, projectCwd) => void handleOpenSession(session, projectCwd)}
        onOpenRemoteSession={(tabId, projectCwd, session) => void handleOpenRemoteSession(tabId, projectCwd, session)}
        onDeleteSession={(session, tabId) => void handleDeleteSession(session, tabId)}
        onHandleSessionCtx={handleSessionCtx}
        onSelectAllSessions={selectAllSessions}
        onToggleSessionSelect={toggleSessionSelect}
        renderTree={renderTree}
      />
      {remoteHydration.phase !== "idle" && isRemote && (
        <div className="toast toast-ok" style={{ right: viewerCollapsed ? 20 : rightWidth + 20, bottom: 20 }}>
          {remoteHydration.phase === "loading" ? "远程会话加载中…" : "正在补全远程会话信息…"}
        </div>
      )}

      <div className="pane-resizer" onMouseDown={onLeftPaneResizerDown} />

      {/* Middle: tabs + terminal */}
      <main className="main">
        <TabBar
          visibleTabs={visibleTabs}
          activeTab={activeTab}
          onSelectTab={(id) => void handleSelectTab(id)}
          onCloseTab={(id) => void handleCloseTab(id)}
          onNewTab={() => void handleNewTab()}
          onShowRemote={() => setShowRemote(true)}
          onShowModels={openModelConfig}
        />
        <TerminalHost visibleTabs={visibleTabs} activeTab={activeTab} theme={theme} />
      </main>

      <div className="pane-resizer" onMouseDown={onRightPaneResizerDown} />

      <ViewerPane
        viewerCollapsed={viewerCollapsed}
        rightWidth={rightWidth}
        currentFile={currentFile}
        remoteLabel={remoteLabel}
        onToggleViewer={() => setViewerCollapsed((v) => !v)}
        fileLoading={fileLoading}
        followCfg={followCfg}
        onFollowChange={handleFollowChange}
        followDegraded={followDegraded}
      />

      {showModelConfig && (
        <div className="dialog-overlay" onClick={() => setShowModelConfig(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">模型配置</div>
            <div className="dialog-body">
              <label>
                配置目标
                <select
                  className="dialog-input"
                  value={modelTarget.kind === "remote" ? `remote:${modelTarget.index}` : "local"}
                  onChange={(e) => onModelTargetChange(e.target.value)}
                >
                  <option value="local">本地电脑</option>
                  {remoteHistory.map((h, i) => (
                    <option key={h.id} value={`remote:${i}`}>
                      {h.user}@{h.host}:{h.port ?? 22}
                    </option>
                  ))}
                </select>
                <span className="dialog-hint">
                  {modelTarget.kind === "remote"
                    ? `写入 ${modelTarget.user}@${modelTarget.host} 的 ~/.pi/agent/`
                    : "写入本机 ~/.pi/agent/"}
                </span>
              </label>
              <label>
                配置名称
                <input className="dialog-input" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="例如：OpenAI 兼容" autoFocus />
              </label>
              <label>
                Base URL
                <input className="dialog-input" value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
              </label>
              <label>
                API Key
                <input className="dialog-input" value={modelApiKey} onChange={(e) => setModelApiKey(e.target.value)} placeholder="sk-..." type="password" />
              </label>
              <label>
                模型 ID
                {discoveredModels.length > 0 ? (
                  <select className="dialog-input" value={modelIdValue} onChange={(e) => setModelIdValue(e.target.value)}>
                    {discoveredModels.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                ) : (
                  <input className="dialog-input" value={modelIdValue} onChange={(e) => setModelIdValue(e.target.value)} placeholder="gpt-4o-mini" />
                )}
              </label>
              <label>
                Provider <span className="dialog-hint">（必填，用于 /model 显示 provider 名称）</span>
                <input className="dialog-input" value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} placeholder="例如 my-openai" />
              </label>
              <div className="model-discover-row">
                <button className="btn" onClick={() => void handleDiscoverModels()} disabled={discoveringModels}>
                  {discoveringModels ? "检索中…" : "自动检索模型"}
                </button>
                {discoveredModels.length > 0 && <span className="model-discover-hint">已发现 {discoveredModels.length} 个模型</span>}
              </div>
              <div className="model-list">
                {modelRemoteLoading ? <div className="placeholder">（读取远程配置…）</div> : models.length === 0 ? <div className="placeholder">（暂无模型配置）</div> : models.map((item) => (
                  <div key={item.id} className="model-row">
                    <div className="model-row-main">
                      <div className="model-row-title">{item.name}</div>
                      <div className="model-row-meta">{item.model} · {item.baseUrl}{item.availableModels?.length ? ` · ${item.availableModels.length} 个模型` : ""}</div>
                    </div>
                    <div className="model-row-actions">
                      {modelTarget.kind === "local" && (
                        <button
                          className="btn"
                          onClick={async () => {
                            const result = await window.api.model.checkSync({ provider: item.provider || "", model: item.model });
                            showToast(
                              result.ok
                                ? `Pi 已识别：${item.provider}/${item.model}`
                                : `Pi 未完全识别：provider=${result.providerExists ? "✓" : "✗"} model=${result.modelExists ? "✓" : "✗"} list=${result.listModelsContains ? "✓" : "✗"}`,
                              result.ok ? "ok" : "err",
                            );
                          }}
                          title="检查是否已同步到 Pi"
                        >验证</button>
                      )}
                      <button
                        className="row-delete"
                        onClick={async () => {
                          if (modelTarget.kind === "remote") {
                            await window.api.model.deleteRemote({
                              remote: { host: modelTarget.host, user: modelTarget.user, port: modelTarget.port, password: modelTarget.password, path: modelTarget.path },
                              provider: item.provider || "",
                            });
                            await loadRemoteModels(modelTarget);
                          } else {
                            await window.api.model.delete(item.id);
                            await loadModels();
                          }
                        }}
                        title="删除配置"
                      >×</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setShowModelConfig(false)}>关闭</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const normalizedBaseUrl = modelBaseUrl.trim();
                  const normalizedModelId = modelIdValue.trim();
                  const normalizedProvider = modelProvider.trim();
                  if (!normalizedBaseUrl || !normalizedModelId || !normalizedProvider) {
                    showToast(`请填写 Base URL、Provider 和模型 ID（当前: baseUrl=${normalizedBaseUrl ? "✓" : "✗"}, provider=${normalizedProvider ? "✓" : "✗"}, model=${normalizedModelId ? "✓" : "✗"}）`, "err");
                    return;
                  }
                  try {
                    if (modelTarget.kind === "remote") {
                      await window.api.model.addRemote({
                        remote: { host: modelTarget.host, user: modelTarget.user, port: modelTarget.port, password: modelTarget.password, path: modelTarget.path },
                        baseUrl: normalizedBaseUrl,
                        apiKey: modelApiKey.trim(),
                        model: normalizedModelId,
                        provider: normalizedProvider,
                        availableModels: discoveredModels,
                      });
                      await loadRemoteModels(modelTarget);
                    } else {
                      await window.api.model.add({
                        name: modelName.trim(),
                        baseUrl: normalizedBaseUrl,
                        apiKey: modelApiKey.trim(),
                        model: normalizedModelId,
                        provider: normalizedProvider,
                        availableModels: discoveredModels,
                      });
                      await loadModels();
                    }
                    setModelName("");
                    setModelBaseUrl("");
                    setModelApiKey("");
                    setModelIdValue("");
                    setModelProvider("");
                    setDiscoveredModels([]);
                    showToast(`模型配置已保存（${modelTarget.kind === "remote" ? `${modelTarget.user}@${modelTarget.host}` : "本地"}）`, "ok");
                  } catch (error) {
                    showToast(error instanceof Error ? `保存失败：${error.message}` : "保存失败", "err");
                  }
                }}
              >保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Remote connection dialog */}
      {showRemote && (
        <div className="dialog-overlay" onClick={() => { setShowRemote(false); setRemoteStatus(""); }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">远程连接</div>
            <div className="dialog-body">
              {remoteHistory.length > 0 && (
                <label>
                  历史连接
                  <select
                    className="dialog-input"
                    value={selectedRemoteHistory}
                    onChange={(e) => {
                      const id = e.target.value;
                      setSelectedRemoteHistory(id);
                      const item = remoteHistory.find((h) => h.id === id);
                      if (!item) return;
                      setRemoteHost(item.host);
                      setRemoteUser(item.user);
                      setRemotePort(String(item.port || 22));
                      setRemotePassword(item.password || "");
                      setRemotePath(item.path || "");
                    }}
                  >
                    <option value="">选择已保存的地址</option>
                    {remoteHistory.map((item) => (
                      <option key={item.id} value={item.id}>{item.user}@{item.host}:{item.port}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                主机地址
                <input
                  className="dialog-input"
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  placeholder="192.168.1.100 或 myserver.com"
                  autoFocus
                />
              </label>
              <label>
                用户名
                <input
                  className="dialog-input"
                  value={remoteUser}
                  onChange={(e) => setRemoteUser(e.target.value)}
                  placeholder="root"
                />
              </label>
              <label>
                端口
                <input
                  className="dialog-input"
                  value={remotePort}
                  onChange={(e) => setRemotePort(e.target.value)}
                  placeholder="22"
                  type="number"
                />
              </label>
              <label>
                远程路径 <span className="dialog-hint">（可选，默认 ~）</span>
                <input
                  className="dialog-input"
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                  placeholder="/home/user/project"
                />
              </label>
              <label>
                密码 <span className="dialog-hint">（可选，免密可留空）</span>
                <input
                  className="dialog-input"
                  value={remotePassword}
                  onChange={(e) => setRemotePassword(e.target.value)}
                  placeholder="输入 SSH 密码"
                  type="password"
                />
              </label>
              <p className="dialog-note">
                终端仍通过 SSH 启动远程 <code>pi</code>。左侧文件树和右侧文件查看会使用密码或免密方式单独建立 SFTP 连接。
              </p>
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => { setShowRemote(false); setRemoteStatus(""); }}>取消</button>
              <button
                className="btn btn-primary"
                onClick={handleRemote}
                disabled={!remoteHost || !remoteUser || remoteStatus === "connecting"}
              >
                {remoteStatus === "connecting" ? "连接中…" : "连接"}
              </button>
            </div>
            {remoteStatus === "connecting" && <div className="dialog-status">正在连接 {remoteUser}@{remoteHost} …</div>}
          </div>
        </div>
      )}

      {/* Session context menu */}
      {ctxMenuSession && (
        <>
          <div className="ctx-backdrop" onClick={() => setCtxMenuSession(null)} />
          <div className="ctx-menu" style={{ left: ctxMenuPos.x, top: ctxMenuPos.y }}>
            <button className="ctx-item" onClick={handleRenameStart}>✏️ 重命名</button>
            <button className="ctx-item ctx-danger" onClick={handleCtxDelete}>🗑 删除</button>
          </div>
        </>
      )}

      {/* Remote directory picker */}
      {showRemotePicker && (
        <div className="dialog-overlay" onClick={() => { setShowRemotePicker(false); pickerTabRef.current = null; }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
            <div className="dialog-title">选择远程目录</div>
            <div className="dialog-body">
              <div className="picker-path">
                📂 <strong>{pickerPath.replace(/^\/home\/[^/]+/, "~")}</strong>
              </div>
              <div className="picker-list">
                {/* Always show .. unless at root */}
                {pickerPath !== "/" && (
                  <div
                    className="picker-row"
                    onClick={() => pickerNavigate(
                      pickerPath === "~" ? "/" : (pickerPath.replace(/\/[^/]+$/, "") || "/")
                    )}
                  >
                    <span className="picker-icon">📁</span>
                    <span>..</span>
                  </div>
                )}
                {pickerLoading ? (
                  <div className="placeholder">加载中…</div>
                ) : pickerEntries.length === 0 ? (
                  <div className="placeholder">（空目录）</div>
                ) : (
                  pickerEntries.map((e) => (
                    <div
                      key={e.path}
                      className={`picker-row${e.type === "directory" ? "" : " picker-file"}`}
                      onClick={() => e.type === "directory" && pickerNavigate(e.path)}
                      onDoubleClick={() => { if (e.type === "directory") { pickerNavigate(e.path).then(() => pickerSelect()); } }}
                    >
                      <span className="picker-icon">{e.type === "directory" ? "📁" : "📄"}</span>
                      <span>{e.name}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => { setShowRemotePicker(false); pickerTabRef.current = null; }}>取消</button>
              <button className="btn btn-primary" onClick={pickerSelect}>选择当前目录</button>
            </div>
          </div>
        </div>
      )}

      {/* Rename dialog */}
      {renameSession && (
        <div className="dialog-overlay" onClick={() => setRenameSession(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">重命名会话</div>
            <div className="dialog-body">
              <input
                className="dialog-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="输入新名称"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") handleRenameSubmit(); }}
              />
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setRenameSession(null)}>取消</button>
              <button className="btn btn-primary" onClick={handleRenameSubmit}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.text}</div>
      )}
    </div>
  );
}

function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [remoteHistory, setRemoteHistory] = useState<RemoteHistoryItem[]>([]);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await window.api.project.list());
    } catch {
      setProjects([]);
    }
  }, []);

  const upsertProject = useCallback((project: ProjectListItem) => {
    setProjects((prev) => {
      const idx = prev.findIndex((p) => p.id === project.id);
      if (idx < 0) return [...prev, project];
      const next = [...prev];
      next[idx] = project;
      return next;
    });
  }, []);

  useEffect(() => {
    void refreshProjects();
    window.api.remote.listHistory().then((list) => setRemoteHistory(list as RemoteHistoryItem[]));
  }, [refreshProjects]);

  return { projects, remoteHistory, setRemoteHistory, upsertProject, refreshProjects };
}

function useRemoteSessionHydration({ projects, tabs, setRemoteSessions, setProjectSessions, setRemoteHydration }: UseRemoteSessionHydrationArgs): void {
  useEffect(() => {
    const off = window.api.session.onRemoteUpdated(({ tabId, remoteCwd, sessions }) => {
      setRemoteSessions((prev) => ({ ...prev, [remoteSessionCacheKey(tabId, remoteCwd)]: sessions as SessionItem[] }));
      setProjectSessions((prev) => {
        const next = { ...prev };
        for (const project of projects) {
          if (project.type !== "remote" || !project.path || !project.host || !project.user) continue;
          if (project.path !== remoteCwd) continue;
          const projectRemoteKey = buildRemoteKey(project.host, project.user, project.port);
          const matchesTab = tabs.find((t) => t.id === tabId && t.isRemote && t.remoteKey === projectRemoteKey);
          if (matchesTab && project.id) next[project.id] = sessions as SessionItem[];
        }
        return next;
      });
      setRemoteHydration((prev) => (prev.tabId === tabId && prev.remoteCwd === remoteCwd ? { phase: "idle" } : prev));
    });
    return off;
  }, [projects, setProjectSessions, setRemoteHydration, setRemoteSessions, tabs]);
}

function useFileTree({ activeTab, isRemote, remoteDir, setCwd, setRemoteDir }: UseFileTreeArgs): UseFileTreeResult {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fileTreeStatus, setFileTreeStatus] = useState<"idle" | "loading" | "refreshing" | "error">("idle");
  const [fileTreeError, setFileTreeError] = useState<string | null>(null);
  const [remoteTreeCache, setRemoteTreeCache] = useState<Record<string, FileNode[]>>({});

  const loadTree = useCallback(async (dirPath?: string, tabId?: string, rootPath?: string, options?: { isRemote?: boolean }) => {
    const remoteMode = options?.isRemote ?? isRemote;
    const resolvedTabId = tabId ?? activeTab ?? undefined;
    const resolvedDir = dirPath ?? remoteDir ?? rootPath;
    const cacheKey = remoteMode && resolvedTabId && resolvedDir ? `${resolvedTabId}:${resolvedDir}` : null;
    if (cacheKey && remoteTreeCache[cacheKey]?.length) {
      setTree(sortFileNodes(remoteTreeCache[cacheKey]));
      setFileTreeStatus("refreshing");
      setFileTreeError(null);
    } else if (remoteMode) {
      setFileTreeStatus("loading");
      setFileTreeError(null);
    } else {
      setFileTreeStatus("idle");
      setFileTreeError(null);
    }
    try {
      const nodes = (await window.api.file.list(resolvedTabId, dirPath, rootPath)) as FileNode[];
      const sortedNodes = sortFileNodes(nodes);
      setTree(sortedNodes);
      if (cacheKey) setRemoteTreeCache((prev) => ({ ...prev, [cacheKey]: sortedNodes }));
      if (nodes.length > 0) setExpanded((prev) => new Set(prev).add(nodes[0].path));
      setFileTreeStatus("idle");
      setFileTreeError(null);
    } catch (error) {
      if (!cacheKey || !remoteTreeCache[cacheKey]?.length) setTree([]);
      setFileTreeStatus(remoteMode ? "error" : "idle");
      setFileTreeError(error instanceof Error ? error.message : "未知错误");
    }
  }, [activeTab, isRemote, remoteDir, remoteTreeCache]);

  const navigateRemoteDir = useCallback(async (dirPath: string) => {
    if (!activeTab || !isRemote) return;
    const ok = await window.api.remote.setBrowsePath(activeTab, dirPath);
    if (!ok) return;
    setRemoteDir(dirPath);
    setCwd(dirPath);
    await loadTree(dirPath, activeTab);
  }, [activeTab, isRemote, loadTree, setCwd, setRemoteDir]);

  return { tree, setTree, expanded, setExpanded, fileTreeStatus, fileTreeError, remoteTreeCache, setRemoteTreeCache, loadTree, navigateRemoteDir };
}

function useSessionManager({ tabs, cwd, activeTab, isRemote, remoteDir, setRemoteSessions, loadProjects, onLocalSessionsDeleted }: UseSessionManagerArgs): UseSessionManagerResult {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const openingSessionsRef = useRef(new Set<string>());

  const loadSessions = useCallback(async (c?: string) => {
    try {
      const list = (await window.api.session.list(c)) as SessionItem[];
      setSessions(list);
    } catch {
      setSessions([]);
    }
  }, []);

  const handleOpenSession = useCallback(async (session: SessionItem, projectCwd?: string) => {
    if (openingSessionsRef.current.has(session.path)) return;
    const existing = tabs.find((t) => t.sessionPath === session.path);
    if (existing) {
      await window.api.tab.activate(existing.id);
      return;
    }
    openingSessionsRef.current.add(session.path);
    try {
      await window.api.tab.create({ cwd: projectCwd || cwd, sessionPath: session.path, continueRecent: false, title: sessionLabel(session) });
    } finally {
      openingSessionsRef.current.delete(session.path);
    }
  }, [cwd, tabs]);

  const handleOpenRemoteSession = useCallback(async (tabId: string, projectCwd: string, session: SessionItem) => {
    if (openingSessionsRef.current.has(session.path)) return;
    const existing = tabs.find((t) => t.sessionPath === session.path);
    if (existing) {
      await window.api.tab.activate(existing.id);
      return;
    }
    const remote = await window.api.remote.getInfo(tabId);
    if (!remote) return;
    openingSessionsRef.current.add(session.path);
    try {
      await window.api.tab.create({
        cwd: cwd || ".",
        sessionPath: session.path,
        title: sessionLabel(session),
        remote: {
          host: remote.host,
          user: remote.user,
          port: remote.port,
          path: projectCwd,
          password: remote.password,
        },
      });
    } finally {
      openingSessionsRef.current.delete(session.path);
    }
  }, [cwd, tabs]);

  const handleDeleteSession = useCallback(async (session: SessionItem, tabId?: string, projectCwd?: string) => {
    if (!confirm(`删除该会话？\n${sessionLabel(session)}`)) return;
    const opened = tabs.filter((t) => t.sessionPath === session.path);
    for (const tab of opened) {
      try {
        await window.api.tab.close(tab.id);
      } catch {
        /* 标签页可能已关闭，忽略 */
      }
    }
    const result = await window.api.session.delete(session.path, tabId);
    if (!result.ok) {
      alert(`删除失败: ${result.error}`);
      return;
    }
    setSessions((prev) => prev.filter((item) => item.path !== session.path));
    onLocalSessionsDeleted?.([session.path]);
    await loadSessions(cwd);
    await loadProjects();
    if (tabId && projectCwd) {
      const remoteList = await window.api.session.listRemote(tabId, projectCwd);
      setRemoteSessions((prev) => ({ ...prev, [remoteSessionCacheKey(tabId, projectCwd)]: remoteList.sessions as SessionItem[] }));
    }
  }, [cwd, loadProjects, loadSessions, onLocalSessionsDeleted, setRemoteSessions, tabs]);

  const toggleSessionSelect = useCallback((path: string) => {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAllSessions = useCallback((items: SessionItem[]) => {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      const allSelected = items.every((s) => next.has(s.path));
      for (const session of items) {
        if (allSelected) next.delete(session.path);
        else next.add(session.path);
      }
      return next;
    });
  }, []);

  const handleBatchDelete = useCallback(async (tabId?: string, projectCwd?: string) => {
    if (selectedSessions.size === 0) return;
    if (!confirm(`确定删除已选中的 ${selectedSessions.size} 个会话？\n此操作不可撤销。`)) return;
    const paths = [...selectedSessions];
    try {
      for (const tab of tabs) {
        if (tab.sessionPath && paths.includes(tab.sessionPath)) {
          try {
            await window.api.tab.close(tab.id);
          } catch {
            /* 标签页可能已关闭，忽略 */
          }
        }
      }
      let ok = 0;
      const errors: string[] = [];
      for (const path of paths) {
        try {
          const result = await window.api.session.delete(path);
          if (result.ok) ok += 1;
          else errors.push(`${path}：${result.error ?? "未知错误"}`);
        } catch (err) {
          errors.push(`${path}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const fail = errors.length;
      if (fail > 0) {
        const detail = errors.slice(0, 5).join("\n");
        alert(`删除完成：${ok} 个成功，${fail} 个失败${errors.length > 5 ? `（还有 ${errors.length - 5} 个省略）` : ""}\n\n${detail}`);
      }
      if (ok > 0) {
        onLocalSessionsDeleted?.(paths);
        await loadSessions(cwd);
        await loadProjects();
      }
      if (isRemote && tabId && projectCwd) {
        const remoteList = await window.api.session.listRemote(tabId, projectCwd);
        setRemoteSessions((prev) => ({ ...prev, [remoteSessionCacheKey(tabId, projectCwd)]: remoteList.sessions as SessionItem[] }));
      }
    } catch (err) {
      alert(`批量删除出错：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSelectedSessions(new Set());
    }
  }, [cwd, isRemote, loadProjects, loadSessions, onLocalSessionsDeleted, selectedSessions, setRemoteSessions, tabs]);

  return {
    sessions,
    setSessions,
    selectedSessions,
    setSelectedSessions,
    loadSessions,
    handleOpenSession,
    handleOpenRemoteSession,
    handleDeleteSession,
    handleBatchDelete,
    toggleSessionSelect,
    selectAllSessions,
  };
}

function useProjectExplorer({
  expandedProjects,
  projectTrees,
  projectSessions,
  remoteSessions,
  remoteTreeCache,
  loadProjects,
  loadTree,
  setExpandedProjects,
  setProjectLoading,
  setProjectSessionStatus,
  setProjectErrors,
  setProjectDiagnostics,
  setProjectSessions,
  setProjectTrees,
  setRemoteHydration,
  setRemoteSessions,
  setRemoteTreeCache,
  setTree,
  setCwd,
  setRemoteDir,
  setIsRemote,
  setRemoteLabel,
  setActiveTab,
  cwd,
}: UseProjectExplorerArgs): UseProjectExplorerResult {
  const toggleProject = useCallback(async (project: ProjectGroup) => {
    const willExpand = !expandedProjects.has(project.key);
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project.key)) next.delete(project.key);
      else next.add(project.key);
      return next;
    });

    if (project.type === "local") {
      const hasCachedSessions = !!projectSessions[project.key]?.length;
      if (willExpand && !hasCachedSessions) {
        setProjectLoading((prev) => ({ ...prev, [project.key]: true }));
        const list = await window.api.session.list(project.cwd);
        setProjectSessions((prev) => ({ ...prev, [project.key]: list as SessionItem[] }));
        setProjectSessionStatus((prev) => ({ ...prev, [project.key]: list.length > 0 ? "ready" : "empty" }));
        setProjectLoading((prev) => ({ ...prev, [project.key]: false }));
      }
      setCwd(project.cwd);
      setRemoteDir(null);
      setIsRemote(false);
      await loadTree(undefined, undefined, project.cwd, { isRemote: false });
      return;
    }

    if (!project.tabId) {
      return;
    }

    await window.api.tab.activate(project.tabId);
    setActiveTab(project.tabId);
    setIsRemote(true);
    setRemoteDir(project.cwd);
    setCwd(project.cwd);
    setRemoteLabel(`${project.user}@${project.host}`);
    await window.api.remote.setBrowsePath(project.tabId, project.cwd);

    const remoteCacheKey = `${project.tabId}:${project.cwd}`;
    await window.api.session.setRemoteHydrationPaused(project.tabId, project.cwd, !willExpand);
    if (willExpand) await window.api.session.prioritizeRemote(project.tabId, project.cwd, 2);
    const cachedTree = projectTrees[project.key] ?? remoteTreeCache[remoteCacheKey];
    if (cachedTree) setTree(sortFileNodes(cachedTree));

    if (willExpand) {
      const cachedSessions = projectSessions[project.key] ?? remoteSessions[remoteCacheKey] ?? [];
      const hasCachedTree = !!cachedTree?.length;
      const hasCachedSessions = cachedSessions.length > 0;
      if (hasCachedSessions) {
        setProjectSessions((prev) => ({ ...prev, [project.key]: cachedSessions }));
      }
      if (hasCachedTree && hasCachedSessions) {
        setProjectSessionStatus((prev) => ({ ...prev, [project.key]: "ready" }));
        void window.api.session.listRemote(project.tabId, project.cwd).then((listResult) => {
          setProjectSessions((prev) => ({ ...prev, [project.key]: listResult.sessions as SessionItem[] }));
          setProjectErrors((prev) => ({ ...prev, [project.key]: listResult.error }));
          setProjectDiagnostics((prev) => ({ ...prev, [project.key]: listResult.diagnostics }));
          setProjectSessionStatus((prev) => ({ ...prev, [project.key]: listResult.error ? "error" : listResult.sessions.length > 0 ? "ready" : "empty" }));
        }).catch(() => undefined);
        setProjectLoading((prev) => ({ ...prev, [project.key]: false }));
        setRemoteHydration({ phase: "idle" });
        return;
      }
      setProjectLoading((prev) => ({ ...prev, [project.key]: true }));
      setProjectSessionStatus((prev) => ({ ...prev, [project.key]: hasCachedSessions ? "ready" : "loading" }));
      setRemoteHydration({ phase: hasCachedSessions ? "hydrating" : "loading", tabId: project.tabId, remoteCwd: project.cwd });

      if (!hasCachedSessions) {
        void window.api.session.listRemote(project.tabId, project.cwd).then((listResult) => {
          setProjectSessions((prev) => ({ ...prev, [project.key]: listResult.sessions as SessionItem[] }));
          setProjectErrors((prev) => ({ ...prev, [project.key]: listResult.error }));
          setProjectDiagnostics((prev) => ({ ...prev, [project.key]: listResult.diagnostics }));
          setProjectSessionStatus((prev) => ({ ...prev, [project.key]: listResult.error ? "error" : listResult.sessions.length > 0 ? "ready" : "empty" }));
          setProjectLoading((prev) => ({ ...prev, [project.key]: false }));
          setRemoteHydration({ phase: "idle" });
        }).catch((error) => {
          setProjectErrors((prev) => ({ ...prev, [project.key]: error instanceof Error ? error.message : String(error) }));
          setProjectSessionStatus((prev) => ({ ...prev, [project.key]: "error" }));
          setProjectLoading((prev) => ({ ...prev, [project.key]: false }));
          setRemoteHydration({ phase: "idle" });
        });
      } else {
        setProjectLoading((prev) => ({ ...prev, [project.key]: false }));
      }

      if (!hasCachedTree) {
        const nodes = await window.api.file.list(project.tabId, project.cwd);
        const sortedNodes = sortFileNodes(nodes as FileNode[]);
        setTree(sortedNodes);
        setProjectTrees((prev) => ({ ...prev, [project.key]: sortedNodes }));
        setRemoteTreeCache((prev) => ({ ...prev, [remoteCacheKey]: sortedNodes }));
      }
      return;
    }

    const nodes = await window.api.file.list(project.tabId, project.cwd);
    const sortedNodes = sortFileNodes(nodes as FileNode[]);
    setTree(sortedNodes);
    setProjectTrees((prev) => ({ ...prev, [project.key]: sortedNodes }));
    setRemoteTreeCache((prev) => ({ ...prev, [remoteCacheKey]: sortedNodes }));
    setProjectLoading((prev) => ({ ...prev, [project.key]: false }));
    setRemoteHydration({ phase: "idle" });
  }, [expandedProjects, loadTree, projectSessions, projectTrees, remoteSessions, remoteTreeCache, setActiveTab, setCwd, setExpandedProjects, setIsRemote, setProjectDiagnostics, setProjectErrors, setProjectLoading, setProjectSessionStatus, setProjectSessions, setProjectTrees, setRemoteDir, setRemoteHydration, setRemoteLabel, setRemoteTreeCache, setTree]);

  const handleDeleteProject = useCallback(async (project: ProjectGroup) => {
    if (!confirm(`删除项目 ${project.label}？\n这不会删除实际文件夹。`)) return;
    const ok = await window.api.project.delete(project.key);
    if (!ok) {
      alert("删除项目失败");
      return;
    }
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      next.delete(project.key);
      return next;
    });
    await loadProjects();
  }, [loadProjects, setExpandedProjects]);

  const handleNewProjectSession = useCallback(async (project: ProjectGroup) => {
    if (project.type === "remote") {
      let remoteInfo = project.tabId ? await window.api.remote.getInfo(project.tabId) : null;
      if (!remoteInfo && project.host && project.user) {
        remoteInfo = {
          host: project.host,
          user: project.user,
          port: project.port,
          path: project.cwd,
          password: project.password,
        };
      }
      if (!remoteInfo) return;
      const id = await window.api.tab.create({
        cwd: cwd || ".",
        remote: {
          host: remoteInfo.host,
          user: remoteInfo.user,
          port: remoteInfo.port,
          path: project.cwd,
          password: remoteInfo.password,
        },
      });
      const remoteTabId = project.tabId || id;
      const remoteListResult = await window.api.session.listRemote(remoteTabId, project.cwd);
      setRemoteSessions((prev) => ({ ...prev, [remoteSessionCacheKey(remoteTabId, project.cwd)]: remoteListResult.sessions as SessionItem[] }));
      setProjectErrors((prev) => ({ ...prev, [project.key]: remoteListResult.error }));
      setProjectDiagnostics((prev) => ({ ...prev, [project.key]: remoteListResult.diagnostics }));
      setProjectSessionStatus((prev) => ({ ...prev, [project.key]: remoteListResult.error ? "error" : remoteListResult.sessions.length > 0 ? "ready" : "empty" }));
      return;
    }
    await window.api.tab.create({ cwd: project.cwd });
  }, [cwd, setProjectDiagnostics, setProjectErrors, setProjectSessionStatus, setRemoteSessions]);

  return { toggleProject, handleDeleteProject, handleNewProjectSession };
}

// --- Layout slices ----------------------------------------------------------

const Sidebar = memo(function Sidebar({
  leftWidth,
  sidebarRef,
  sidebarSplit,
  theme,
  toggleTheme,
  selectedSessions,
  handleBatchDelete,
  setSelectedSessions,
  localProjectGroups,
  remoteProjectGroups,
  isRemote,
  cwd,
  remoteDir,
  expandedProjects,
  projectLoading,
  projectSessionStatus,
  activeTab,
  tree,
  remoteHydration,
  fileTreeStatus,
  fileTreeError,
  onSidebarResizerDown,
  onToggleProject,
  onNewLocalProject,
  onDeleteProject,
  onNewProjectSession,
  onAddRemoteProject,
  onOpenSession,
  onOpenRemoteSession,
  onDeleteSession,
  onHandleSessionCtx,
  onSelectAllSessions,
  onToggleSessionSelect,
  renderTree,
}: SidebarProps) {
  return (
    <aside className="sidebar" ref={sidebarRef} style={{ width: leftWidth, flex: "0 0 auto" }}>
      <div className="sidebar-header">
        <span className="sidebar-title" title={isRemote && remoteDir ? remoteDir : cwd}>项目与会话</span>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={toggleTheme} title={theme === "dark" ? "浅色主题" : "深色主题"}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </div>
      <div className="sidebar-top" style={{ height: `${sidebarSplit}%` }}>
        <div className="panel-label">项目 / 会话</div>
        {false && isRemote && remoteHydration.phase !== "idle" && (
          <div className="placeholder" style={{ marginBottom: 8 }}>
            {remoteHydration.phase === "loading" ? "远程会话加载中…" : "正在补全远程会话信息…"}
          </div>
        )}
        {selectedSessions.size > 0 && (
          <div className="batch-bar">
            <span>已选 {selectedSessions.size} 个</span>
            <button className="btn btn-danger btn-small" onClick={handleBatchDelete}>删除选中</button>
            <button className="btn btn-small" onClick={() => setSelectedSessions(new Set())}>取消</button>
          </div>
        )}
        <div className="session-scroll">
          <ProjectGroupSection
            title="本地项目"
            emptyText="（暂无本地项目）"
            addTitle="新增本地项目"
            onAdd={onNewLocalProject}
            projects={localProjectGroups}
            expandedProjects={expandedProjects}
            projectLoading={projectLoading}
            projectSessionStatus={projectSessionStatus}
            selectedSessions={selectedSessions}
            isProjectActive={(project) => !isRemote && cwd === project.cwd}
            onToggleProject={onToggleProject}
            onDeleteProject={onDeleteProject}
            onNewProjectSession={onNewProjectSession}
            onOpenSession={onOpenSession}
            onDeleteSession={onDeleteSession}
            onHandleSessionCtx={onHandleSessionCtx}
            onSelectAllSessions={onSelectAllSessions}
            onToggleSessionSelect={onToggleSessionSelect}
          />
          <ProjectGroupSection
            title="远程项目"
            emptyText="（暂无远程项目）"
            addTitle="新增远程项目"
            onAdd={onAddRemoteProject}
            projects={remoteProjectGroups}
            expandedProjects={expandedProjects}
            projectLoading={projectLoading}
            projectSessionStatus={projectSessionStatus}
            selectedSessions={selectedSessions}
            isProjectActive={(project) => project.tabId === activeTab}
            onToggleProject={onToggleProject}
            onDeleteProject={onDeleteProject}
            onNewProjectSession={onNewProjectSession}
            onOpenSession={undefined}
            onOpenRemoteSession={onOpenRemoteSession}
            onDeleteSession={onDeleteSession}
            onHandleSessionCtx={undefined}
            onSelectAllSessions={onSelectAllSessions}
            onToggleSessionSelect={onToggleSessionSelect}
            isRemoteSection
          />
        </div>
      </div>
      <div className="sidebar-resizer" onMouseDown={onSidebarResizerDown} />
      <div className="sidebar-bottom" style={{ height: `${100 - sidebarSplit}%` }}>
        <div className="panel-label">当前项目文件</div>
        {(isRemote ? remoteDir : cwd) ? (
          <div className="tree-path" title={isRemote ? remoteDir! : cwd}>
            📂 {(isRemote ? remoteDir! : cwd).replace(/^\/home\/[^/]+/, "~")}
          </div>
        ) : null}
        <div className="tree-scroll">
          {fileTreeStatus === "loading" ? (
            <div className="placeholder">远程文件加载中…</div>
          ) : fileTreeStatus === "refreshing" ? (
            <>
              <div className="placeholder">远程文件刷新中…</div>
              {renderTree(tree, 0)}
            </>
          ) : fileTreeStatus === "error" ? (
            <div className="placeholder">远程文件加载失败{fileTreeError ? `：${fileTreeError}` : "，请重试"}</div>
          ) : tree.length === 0 && !isRemote ? (
            <div className="placeholder">（无文件）</div>
          ) : tree.length === 0 && isRemote ? (
            <div className="placeholder">加载中…</div>
          ) : (
            renderTree(tree, 0)
          )}
        </div>
      </div>
    </aside>
  );
});

interface ProjectGroupSectionProps {
  title: string;
  emptyText: string;
  addTitle: string;
  onAdd: () => void;
  projects: ProjectGroup[];
  expandedProjects: Set<string>;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, "idle" | "loading" | "ready" | "empty" | "error">;
  selectedSessions: Set<string>;
  isProjectActive: (project: ProjectGroup) => boolean;
  onToggleProject: (project: ProjectGroup) => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onNewProjectSession: (project: ProjectGroup) => void;
  onOpenSession?: (session: SessionItem, projectCwd?: string) => void;
  onOpenRemoteSession?: (tabId: string, projectCwd: string, session: SessionItem) => void;
  onDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => void;
  onHandleSessionCtx?: (e: React.MouseEvent, session: SessionItem) => void;
  onSelectAllSessions: (sessions: SessionItem[]) => void;
  onToggleSessionSelect: (path: string) => void;
  isRemoteSection?: boolean;
}

const ProjectGroupSection = memo(function ProjectGroupSection({
  title,
  emptyText,
  addTitle,
  onAdd,
  projects,
  expandedProjects,
  projectLoading,
  projectSessionStatus,
  selectedSessions,
  isProjectActive,
  onToggleProject,
  onDeleteProject,
  onNewProjectSession,
  onOpenSession,
  onOpenRemoteSession,
  onDeleteSession,
  onHandleSessionCtx,
  onSelectAllSessions,
  onToggleSessionSelect,
  isRemoteSection,
}: ProjectGroupSectionProps) {
  return (
    <div className="group-block">
      <div className="group-title group-title-row"><span>{title}</span><button className="group-add" onClick={onAdd} title={addTitle}>+</button></div>
      {projects.length === 0 ? <div className="placeholder">{emptyText}</div> : projects.map((project) => {
        const expanded = expandedProjects.has(project.key);
        const disabled = !!project.disabled;
        return (
          <div key={project.key} className="project-group">
            <div
              className={`project-row${isProjectActive(project) ? " active" : ""}${disabled ? " disabled" : ""}`}
              onClick={() => { if (!disabled) onToggleProject(project); }}
              title={disabled ? `未连接：${project.user}@${project.host}` : isRemoteSection ? `${project.user}@${project.host}:${project.cwd}` : project.cwd}
            >
              <span className="tree-chevron">{expanded ? "▾" : "▸"}</span>
              <span className="project-icon">{isRemoteSection ? "🌐" : "📁"}</span>
              <span className="project-name">{project.label}</span>
              <button className="row-action" disabled={disabled} onClick={(e) => { e.stopPropagation(); onNewProjectSession(project); }} title={disabled ? "请先连接远程" : "新建会话"}>+</button>
              <button className="row-delete" onClick={(e) => { e.stopPropagation(); onDeleteProject(project); }} title="删除项目">×</button>
            </div>
            {expanded && (
              <div className="project-sessions">
                {isRemoteSection && <div className="remote-project-path">{project.cwd}</div>}
                {isRemoteSection && project.error ? <div className="placeholder">远程会话加载失败：{project.error}</div> : isRemoteSection && (projectSessionStatus[project.key] === "loading" || projectSessionStatus[project.key] === "idle") && project.sessions.length === 0 ? <div className="placeholder">远程会话加载中…</div> : projectLoading[project.key] ? <div className="placeholder">加载中…</div> : project.sessions.length === 0 ? (isRemoteSection ? null : <div className="placeholder">（无会话）</div>) : (
                  <>
                    <div className="session-select-all" onClick={() => onSelectAllSessions(project.sessions)}>
                      {project.sessions.every((s) => selectedSessions.has(s.path)) ? "☑" : "☐"} 全选
                    </div>
                    {project.sessions.map((session) => (
                      <SessionRow
                        key={session.path}
                        session={session}
                        checked={selectedSessions.has(session.path)}
                        onToggleChecked={onToggleSessionSelect}
                        onOpen={() => {
                          if (isRemoteSection) {
                            if (project.tabId && onOpenRemoteSession) onOpenRemoteSession(project.tabId, project.cwd, session);
                            return;
                          }
                          onOpenSession?.(session, project.cwd);
                        }}
                        onDelete={() => onDeleteSession(session, isRemoteSection ? project.tabId : undefined, isRemoteSection ? project.cwd : undefined)}
                        onContextMenu={onHandleSessionCtx ? (e) => onHandleSessionCtx(e, session) : undefined}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

interface SessionRowProps {
  session: SessionItem;
  checked: boolean;
  onToggleChecked: (path: string) => void;
  onOpen: () => void;
  onDelete: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

const SessionRow = memo(function SessionRow({ session, checked, onToggleChecked, onOpen, onDelete, onContextMenu }: SessionRowProps) {
  return (
    <div className="session-row" onClick={onOpen} onContextMenu={onContextMenu} title={session.firstMessage}>
      <input type="checkbox" className="session-check" checked={checked} onChange={() => onToggleChecked(session.path)} onClick={(e) => e.stopPropagation()} />
      <div className="session-body">
        <div className="session-preview">{sessionLabel(session)}</div>
        <div className="session-meta"><span>{session.messageCount} 条</span><span>{relativeTime(session.mtime)}</span></div>
      </div>
      <button className="row-delete session-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="删除会话">×</button>
    </div>
  );
});

const TabBar = memo(function TabBar({ visibleTabs, activeTab, onSelectTab, onCloseTab, onNewTab, onShowRemote, onShowModels }: TabBarProps) {
  return (
    <div className="tab-bar">
      <div className="tabs">
        {visibleTabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${activeTab === t.id ? "active" : ""}${t.isRemote ? " remote" : ""}`}
            onClick={() => onSelectTab(t.id)}
          >
            {t.isRemote && <span className="tab-remote-icon">🌐</span>}
            <span className="tab-title">{t.title}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
              title="关闭"
            >×</button>
          </div>
        ))}
      </div>
      <button className="tab-new" onClick={onNewTab} title="新标签（新建空白会话）">+</button>
      <button className="tab-remote" onClick={onShowModels} title="模型配置">🤖</button>
      <button className="tab-remote" onClick={onShowRemote} title="远程连接">🌐</button>
    </div>
  );
});

const ViewerPane = memo(function ViewerPane({
  viewerCollapsed, rightWidth, currentFile, remoteLabel, onToggleViewer, fileLoading,
  followCfg, onFollowChange, followDegraded,
}: ViewerPaneProps) {
  const [followMenuOpen, setFollowMenuOpen] = useState(false);
  return (
    <aside className={`viewer${viewerCollapsed ? " collapsed" : ""}`} style={viewerCollapsed ? undefined : { width: rightWidth }}>
      <div className="viewer-header">
        <button className="viewer-toggle" onClick={onToggleViewer} title={viewerCollapsed ? "展开预览" : "收起预览"} aria-label={viewerCollapsed ? "展开预览" : "收起预览"}>
          <span className="viewer-toggle-icon">{viewerCollapsed ? "❮" : "❯"}</span>
        </button>
        {!viewerCollapsed && <span className="viewer-path">{currentFile?.path ?? "（未选择文件）"}</span>}
        {!viewerCollapsed && <div className="viewer-meta">
          <div className="viewer-follow-wrap">
            <button
              className={`viewer-follow-btn${followCfg.enabled ? "" : " off"}${followDegraded ? " degraded" : ""}`}
              title={followCfg.enabled ? "自动跟随：开启（点击设置）" : "自动跟随：已关闭（点击设置）"}
              onClick={() => setFollowMenuOpen((v) => !v)}
            >
              {followDegraded ? "跟随 ⚠" : followCfg.enabled ? "跟随 ●" : "跟随 ○"}
            </button>
            {followMenuOpen && (
              <>
                <div className="viewer-follow-overlay" onClick={() => setFollowMenuOpen(false)} />
                <div className="viewer-follow-menu">
                  <label className="follow-option">
                    <input
                      type="checkbox"
                      checked={followCfg.enabled}
                      onChange={(e) => onFollowChange({ enabled: e.target.checked })}
                    />
                    <span>自动跟随（AI 操作文件时自动显示）</span>
                  </label>
                  <label className={`follow-option${followCfg.enabled ? "" : " disabled"}`}>
                    <input
                      type="checkbox"
                      checked={followCfg.followReads}
                      disabled={!followCfg.enabled}
                      onChange={(e) => onFollowChange({ followReads: e.target.checked })}
                    />
                    <span>跟随读操作（read 工具）</span>
                  </label>
                  {followDegraded && (
                    <div className="follow-degraded">⚠ 会话日志格式不兼容，自动跟随已失效</div>
                  )}
                </div>
              </>
            )}
          </div>
          {currentFile?.source && (
            <span className={`viewer-badge viewer-badge-${currentFile.source}`} title={currentFile.sourceLabel}>
              {currentFile.source === "remote" ? `远程 · ${remoteLabel || "remote"}` : "本地"}
            </span>
          )}
          {currentFile?.followed && <span className="viewer-auto">自动跟随</span>}
        </div>}
      </div>
      {!viewerCollapsed && <FileViewer file={currentFile} loading={fileLoading} />}
    </aside>
  );
});

// --- Tree row ---------------------------------------------------------------

interface TreeRowProps {
  node: FileNode;
  depth: number;
  isExpanded: boolean;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string, followed: boolean) => void;
}

const TreeRow = memo(function TreeRow({ node, depth, isExpanded, expandedPaths, onToggle, onOpen }: TreeRowProps) {
  const isDir = node.type === "directory";
  return (
    <>
      <div
        className={`tree-row${isDir ? " tree-dir" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => (isDir ? onToggle(node.path) : onOpen(node.path, false))}
      >
        <span className="tree-chevron">{isDir ? (isExpanded ? "▾" : "▸") : ""}</span>
        <span className="tree-icon">{isDir ? (isExpanded ? "📂" : "📁") : "📄"}</span>
        <span className="tree-name">{node.name}</span>
      </div>
      {isDir && isExpanded && node.children && (
        <>{node.children.map((c) => (
          <TreeBranch
            key={c.path}
            node={c}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}</>
      )}
    </>
  );
});

// --- Helpers ----------------------------------------------------------------

interface TreeBranchProps {
  node: FileNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string, followed: boolean) => void;
}

const TreeBranch = memo(function TreeBranch({ node, depth, expandedPaths, onToggle, onOpen }: TreeBranchProps) {
  return (
    <TreeRow
      node={node}
      depth={depth}
      isExpanded={expandedPaths.has(node.path)}
      expandedPaths={expandedPaths}
      onToggle={onToggle}
      onOpen={onOpen}
    />
  );
});

function sessionLabel(s: SessionItem): string {
  const label = (s.name || s.firstMessage || "").trim();
  return label ? label.slice(0, 40) : "正在加载会话信息…";
}

function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  if (diff < min) return "刚刚";
  if (diff < hr) return `${Math.floor(diff / min)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hr)}小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  return new Date(ms).toLocaleDateString();
}
