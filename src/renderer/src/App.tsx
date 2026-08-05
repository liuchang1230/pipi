/**
 * pi Desktop — three-panel layout with an embedded pi terminal.
 *
 * Left: file tree (top) + session list (bottom), following the active tab's cwd.
 * Middle: tab bar + xterm.js terminal running `pi` (the real TUI — every pi
 *         command, extension, and capability is available natively).
 * Right: editable file viewer with Markdown preview + code highlighting;
 *        auto-follows the files pi's tools touch (via session-file watching).
 *
 * No SDK is embedded; pi runs as a CLI child process per tab. Pi updates keep
 * working as long as the CLI and JSONL format stay stable.
 *
 * Architecture: this file is the composition shell + event orchestration.
 * Each pane subscribes to its own store slices (panes/SidebarPane,
 * panes/TerminalPane, panes/ViewerPane), so a session-poll or auto-follow
 * update re-renders only the affected pane — never this whole tree. The only
 * store slices subscribed here are the ones the dialogs/activation actually
 * render or read; everything else is reached via getState() inside the stable
 * event handlers.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { SidebarPane } from "./panes/SidebarPane";
import { TerminalPane } from "./panes/TerminalPane";
import { ViewerPane } from "./panes/ViewerPane";
import { useTabsStore } from "./stores/tabsStore";
import { useSessionsStore } from "./stores/sessionsStore";
import { useTreeStore } from "./stores/treeStore";
import { useViewerStore } from "./stores/viewerStore";
import { useUiStore } from "./stores/uiStore";
import { useLayoutStore } from "./stores/layoutStore";
import type {
  FileNode,
  ProjectListItem,
  RemoteHistoryItem,
  SessionItem,
} from "./stores/types";

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
  | { kind: "remote"; index: number; host: string; user: string; port: number; password?: string; path?: string }
  | { kind: "wsl"; distro: string };

/** Renders the app-wide toast from uiStore (transient, 3s auto-dismiss). */
function ToastHost() {
  const toast = useUiStore((s) => s.toast);
  if (!toast) return null;
  return <div className={`toast toast-${toast.type}`}>{toast.text}</div>;
}

export default function App() {
  // --- Theme (app chrome; TerminalPane pushes the live pi color-scheme) ---
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("pi-theme");
    return (stored === "light" || stored === "dark") ? stored : "dark";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("pi-theme", theme);
    // Tell the main process which mode to render; it injects COLORFGBG
    // into every new pty (local + remote) so pi matches the app.
    window.api.theme.setMode(theme).catch(() => {});
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  // --- Store slices the dialogs/orchestration actually read ---------------
  const tabs = useTabsStore((s) => s.tabs);
  const activeTab = useTabsStore((s) => s.activeTab);
  const cwd = useTabsStore((s) => s.cwd);
  const remoteDir = useTabsStore((s) => s.remoteDir);
  const projects = useSessionsStore((s) => s.projects);
  const remoteHistory = useSessionsStore((s) => s.remoteHistory);
  const setRemoteHistory = useSessionsStore((s) => s.setRemoteHistory);
  const upsertProject = useSessionsStore((s) => s.upsertProject);
  const loadProjects = useSessionsStore((s) => s.refreshProjects);

  const showToast = useCallback((text: string, type: "ok" | "err") => {
    useUiStore.getState().showToast(text, type);
  }, []);

  // --- Model config dialog state ---
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

  // --- Remote dialog state ---
  const [showRemote, setShowRemote] = useState(false);
  const [remoteHost, setRemoteHost] = useState("");
  const [remoteUser, setRemoteUser] = useState("");
  const [remotePort, setRemotePort] = useState("22");
  const [remotePath, setRemotePath] = useState("");
  const [remotePassword, setRemotePassword] = useState("");
  const [remoteStatus, setRemoteStatus] = useState<"" | "connecting" | "connected" | "failed">("");
  const [selectedRemoteHistory, setSelectedRemoteHistory] = useState("");

  // --- WSL state ---
  const [wslDistros, setWslDistros] = useState<Array<{ name: string; default: boolean; running: boolean; version: number }>>([]);
  const [wslDistro, setWslDistro] = useState("");
  const [wslPath, setWslPathLocal] = useState("");
  const [remoteTab, setRemoteTab] = useState<"ssh" | "wsl">("ssh");

  // --- Remote directory picker state ---
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [pickerPath, setPickerPath] = useState("~");
  const [pickerEntries, setPickerEntries] = useState<import("./stores/types").FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const pickerTabRef = useRef<string | null>(null);

  // --- Activation bookkeeping (refs mirror the store for the stable handler) ---
  const activeTabRef = useRef<string | null>(null);
  const activeCwdRef = useRef<string | null>(null);
  const remoteDirRef = useRef<string | null>(null);

  const loadModels = useCallback(async () => {
    try {
      setModels(await window.api.model.list());
    } catch {
      setModels([]);
    }
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
    if (value.startsWith("wsl:")) {
      const distro = value.slice(4);
      const target: ModelTarget = { kind: "wsl", distro };
      setModelTarget(target);
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
    if (active?.isWsl && active.wslDistro) {
      target = { kind: "wsl", distro: active.wslDistro };
    } else if (active?.isRemote && active.remoteHost && active.remoteUser) {
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
    // Pre-fetch WSL distros for the dropdown.
    window.api.wsl.listDistros().then(setWslDistros).catch(() => setWslDistros([]));
    void (target.kind === "remote" ? loadRemoteModels(target) : loadModels());
  }, [tabs, activeTab, remoteHistory, loadModels, loadRemoteModels]);

  // --- Activation + initial load (the orchestration hub) ------------------
  useEffect(() => {
    void loadModels();
    // Initial catalog load: the sidebar project list and the remote-history
    // dropdown must be populated at start.
    void loadProjects();
    window.api.remote.listHistory().then((list) => setRemoteHistory(list as RemoteHistoryItem[])).catch(() => {});
    const offTabs = window.api.onTabsUpdate((list) => useTabsStore.setState({ tabs: list }));
    const offActive = window.api.onActiveTab(async ({ id, cwd: c, isRemote: r, sessions: payloadSessions }) => {
      const prevActive = activeTabRef.current;
      activeTabRef.current = id;
      if (!id) {
        // Apply the cleared state atomically: one render pass instead of six
        // setState calls.
        useTabsStore.getState().applyActive({ id: null, cwd: "", isRemote: false, remoteDir: null, remoteLabel: "" });
        remoteDirRef.current = null;
        useTreeStore.setState({ tree: [] });
        return;
      }
      if (r) {
        // Watcher is stopped for remote/WSL tabs; nothing will replace the viewer
        // content, so clear the previous (local) file to avoid a stale view.
        useViewerStore.getState().setCurrentFile(null);
        const browsePath = (await window.api.remote.getBrowsePath(id)) ?? c;
        const remoteInfo = await window.api.remote.getInfo(id);
        // Skip redundant reload only when re-activating the SAME tab at the SAME
        // path — the tree/sessions are already cached. A real tab switch must
        // always reload (paths can coincide across tabs, e.g. two distros with
        // the same $HOME).
        const sameTabSamePath = id === prevActive && browsePath === remoteDirRef.current;
        const wasPreview = useTreeStore.getState().treeOrigin?.rootPath != null;
        useTabsStore.getState().applyActive({
          id,
          cwd: browsePath,
          isRemote: true,
          remoteDir: browsePath,
          remoteLabel: remoteInfo && (remoteInfo as any).isWsl ? `🐧 ${(remoteInfo as any).host}` : remoteInfo ? `${remoteInfo.user}@${remoteInfo.host}` : "远程",
        });
        remoteDirRef.current = browsePath;
        if (!sameTabSamePath || wasPreview) void useTreeStore.getState().loadTree(browsePath, id);
      } else {
        const wasPreview = useTreeStore.getState().treeOrigin?.rootPath != null;
        const sameTabSameCwd = id === prevActive && c === activeCwdRef.current;
        activeCwdRef.current = c;
        useTabsStore.getState().applyActive({ id, cwd: c, isRemote: false, remoteDir: null, remoteLabel: "" });
        remoteDirRef.current = null;
        const sessionsStore = useSessionsStore.getState();
        if (payloadSessions) {
          // Main attached a warm cached list (SessionIndex) — skip the
          // session:list round-trip entirely.
          sessionsStore.setSessions(payloadSessions);
          const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
          const allProjects = sessionsStore.projects;
          sessionsStore.setProjectSessions((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const p of allProjects) {
              if (p.type !== "local" || !p.cwd) continue;
              if (norm(p.cwd) !== norm(c)) continue;
              next[p.id] = payloadSessions as SessionItem[];
              changed = true;
            }
            return changed ? next : prev;
          });
        } else {
          void sessionsStore.loadSessions(c);
        }
        // A real tab activation must always win over a sidebar preview
        // (treeOrigin.rootPath): clicking back to the already-active tab
        // would otherwise skip the reload and leave the preview's tree up.
        if (!sameTabSameCwd || wasPreview) void useTreeStore.getState().loadTree(undefined, id);
      }
    });
    // Initial fetch in case the main process already created the first tab.
    window.api.tab.list().then((list) => useTabsStore.setState({ tabs: list }));
    return () => {
      offTabs();
      offActive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadModels]);

  // --- Local project: native dir picker → project + tab --------------------
  const handleSelectDir = useCallback(async () => {
    const dir = await window.api.selectDir();
    if (!dir) return;
    const project = await window.api.project.addLocal(dir);
    upsertProject(project);
    await loadProjects();
    await window.api.tab.create({ cwd: dir });
  }, [loadProjects, upsertProject]);

  // --- Remote connection (SSH / WSL) ---------------------------------------
  const handleRemote = useCallback(async () => {
    if (remoteTab === "wsl") {
      if (!wslDistro) return;
      setRemoteStatus("connecting");
      try {
        const id = await window.api.tab.create({
          cwd: cwd || ".",
          wsl: { distro: wslDistro, path: wslPath.trim() || undefined },
        });
        const alive = await window.api.tab.waitUntilAlive(id, 3000, 200);
        if (!alive) {
          setRemoteStatus("failed");
          showToast(`WSL 启动失败: ${wslDistro}（发行版可能未安装或已停止）`, "err");
          return;
        }
        setRemoteStatus("connected");
        showToast(`已连接 WSL: ${wslDistro}`, "ok");
        // WSL 项目不再自动创建：和 SSH 一样，通过侧边栏 🐧 区域的 + 号
        // 打开目录选择器，选目录后手动创建项目。
        setShowRemote(false);
        setWslDistro(""); setWslPathLocal("");
      } catch (e) {
        setRemoteStatus("failed");
        showToast(`WSL 连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
      }
      return;
    }
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
      const ss = useSessionsStore.getState();
      const matchingProjects = projects.filter((p) => p.type === "remote" && p.host === host && p.user === user && (p.port ?? 22) === (parseInt(remotePort) || 22));
      for (const p of matchingProjects) {
        ss.setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "loading" }));
        window.api.session.listRemote(id, p.path).then((result) => {
          ss.setProjectSessions((prev) => ({ ...prev, [p.id]: result.sessions as SessionItem[] }));
          ss.setProjectErrors((prev) => ({ ...prev, [p.id]: result.error }));
          ss.setProjectDiagnostics((prev) => ({ ...prev, [p.id]: result.diagnostics }));
          ss.setProjectSessionStatus((prev) => ({ ...prev, [p.id]: result.error ? "error" : result.sessions.length > 0 ? "ready" : "empty" }));
        }).catch(() => {
          ss.setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "error" }));
        });
        window.api.file.list(id, p.path).then((nodes) => {
          ss.setProjectTrees((prev) => ({ ...prev, [p.id]: nodes as FileNode[] }));
        }).catch(() => undefined);
      }
      setRemoteHost(""); setRemoteUser(""); setRemotePort("22"); setRemotePath(""); setRemotePassword("");
      setSelectedRemoteHistory("");
    } catch (e) {
      console.error("[remote] failed:", e);
      setRemoteStatus("failed");
      showToast(`连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, [cwd, projects, remotePort, remotePath, remotePassword, remoteHost, remoteUser, remoteTab, wslDistro, wslPath, showToast]);

  // --- Remote directory picker ---------------------------------------------
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
    // SSH section +: find an SSH connection tab (never a WSL tab).
    const remoteTab = tabs.find((t) => t.isRemote && !t.isWsl);
    if (!remoteTab) {
      alert("未连接远程终端，先点击顶部的 🌐 连接远程。\n连接成功后，再点这里的 + 选择远程项目目录。");
      return;
    }
    pickerTabRef.current = remoteTab.id;
    // Start from the picker tab's own browse path (not the active tab's).
    const startPath = await window.api.remote.getBrowsePath(remoteTab.id);
    await openRemotePicker(startPath || "~");
  }, [tabs, openRemotePicker]);

  /** Connect a WSL distro: activate its tab if open, otherwise create one. */
  const connectWslDistro = useCallback(async (distro: string) => {
    const existing = tabs.find((t) => t.isWsl && t.wslDistro === distro);
    if (existing) {
      await window.api.tab.activate(existing.id);
      useTabsStore.getState().setActiveTab(existing.id);
      return;
    }
    await window.api.tab.create({ cwd: cwd || ".", wsl: { distro } });
  }, [cwd, tabs]);

  /** WSL connection node +: open the dir picker rooted at that distro's home. */
  const addWslProject = useCallback(async (distro: string) => {
    // Use the created tab id directly (tabs state updates asynchronously, so
    // a find() right after create() could miss the new tab).
    try {
      const existing = tabs.find((t) => t.isWsl && t.wslDistro === distro);
      const id = existing?.id ?? await window.api.tab.create({ cwd: cwd || ".", wsl: { distro } });
      pickerTabRef.current = id;
      const startPath = await window.api.remote.getBrowsePath(id);
      await openRemotePicker(startPath || "~");
    } catch (e) {
      showToast(`WSL ${distro} 连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, [cwd, showToast, tabs, openRemotePicker]);

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
        if ((remote as any).isWsl) {
          // WSL project: store distro + selected directory.
          const project = await window.api.project.addWsl((remote as any).host, pickerPath);
          upsertProject(project);
        } else {
          const project = await window.api.project.addRemote({
            host: remote.host,
            user: remote.user,
            port: remote.port,
            path: pickerPath,
            password: remote.password,
          });
          upsertProject(project);
        }
        await loadProjects();
      }
    }
    setShowRemotePicker(false);
    pickerTabRef.current = null;
  }, [activeTab, loadProjects, pickerPath, upsertProject]);

  // --- Horizontal pane resizers (left/right widths → layoutStore) ---------
  const leftPaneDragRef = useRef(false);
  const rightPaneDragRef = useRef(false);
  const onLeftPaneResizerDown = useCallback(() => { leftPaneDragRef.current = true; }, []);
  const onRightPaneResizerDown = useCallback(() => { rightPaneDragRef.current = true; }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (leftPaneDragRef.current) {
        useLayoutStore.getState().setLeftWidth(Math.max(220, Math.min(520, e.clientX)));
      }
      if (rightPaneDragRef.current) {
        useLayoutStore.getState().setRightWidth(Math.max(320, Math.min(900, window.innerWidth - e.clientX)));
      }
    };
    const onUp = () => {
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

  return (
    <div className="app">
      <SidebarPane
        theme={theme}
        toggleTheme={toggleTheme}
        onNewLocalProject={() => void handleSelectDir()}
        onAddRemoteProject={() => void handleAddRemoteProject()}
        onWslConnect={(distro) => void connectWslDistro(distro)}
        onAddWslProject={(distro) => void addWslProject(distro)}
      />

      <div className="pane-resizer" onMouseDown={onLeftPaneResizerDown} />

      {/* Middle: tabs + terminal */}
      <TerminalPane theme={theme} onShowRemote={() => setShowRemote(true)} onShowModels={openModelConfig} />

      <div className="pane-resizer" onMouseDown={onRightPaneResizerDown} />

      <ViewerPane />

      {showModelConfig && (
        <div className="dialog-overlay" onClick={() => setShowModelConfig(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">模型配置</div>
            <div className="dialog-body">
              <label>
                配置目标
                <select
                  className="dialog-input"
                  value={modelTarget.kind === "remote" ? `remote:${modelTarget.index}` : modelTarget.kind === "wsl" ? `wsl:${modelTarget.distro}` : "local"}
                  onChange={(e) => onModelTargetChange(e.target.value)}
                >
                  <option value="local">本地电脑</option>
                  {wslDistros.map((d) => (
                    <option key={`wsl-${d.name}`} value={`wsl:${d.name}`}>
                      🐧 {d.name} (WSL)
                    </option>
                  ))}
                  {remoteHistory.map((h, i) => (
                    <option key={h.id} value={`remote:${i}`}>
                      {h.user}@{h.host}:{h.port ?? 22}
                    </option>
                  ))}
                </select>
                <span className="dialog-hint">
                  {modelTarget.kind === "remote"
                    ? `写入 ${modelTarget.user}@${modelTarget.host} 的 ~/.pi/agent/`
                    : modelTarget.kind === "wsl"
                    ? `写入 WSL ${modelTarget.distro} 的 ~/.pi/agent/`
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
              {(modelTarget.kind === "wsl" || modelTarget.kind === "remote") && (
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      let result: { ok: boolean; error?: string; copied: string[] };
                      if (modelTarget.kind === "wsl") {
                        result = await window.api.model.transplantToWsl(modelTarget.distro);
                      } else {
                        result = await window.api.model.transplantToRemote({
                          host: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).host,
                          user: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).user,
                          port: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).port,
                          password: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).password,
                          path: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).path,
                        });
                      }
                      const label = modelTarget.kind === "wsl" ? modelTarget.distro : `${(modelTarget as any).user}@${(modelTarget as any).host}`;
                      showToast(result.ok ? `已移植 ${result.copied.join(", ")} 到 ${label}` : `移植失败: ${result.error}`, result.ok ? "ok" : "err");
                    } catch (err) {
                      showToast(`移植失败: ${err instanceof Error ? err.message : String(err)}`, "err");
                    }
                  }}
                >📋 从本机移植配置</button>
              )}
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
                    const targetKindWsl = modelTarget.kind === "wsl";
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
                    if (targetKindWsl) {
                      showToast(`已保存到本机。点击「📋 从本机移植配置」同步到 WSL`, "ok");
                    } else if (modelTarget.kind === "remote") {
                      showToast(`模型配置已保存（${modelTarget.user}@${modelTarget.host}）`, "ok");
                    } else {
                      showToast("模型配置已保存（本地）", "ok");
                    }
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
            <div className="dialog-tabs">
              <button className={`dialog-tab${remoteTab === "ssh" ? " active" : ""}`} onClick={() => setRemoteTab("ssh")}>🌐 SSH</button>
              <button className={`dialog-tab${remoteTab === "wsl" ? " active" : ""}`} onClick={() => { setRemoteTab("wsl"); window.api.wsl.listDistros().then(setWslDistros).catch(() => setWslDistros([])); }}>🐧 WSL</button>
            </div>
            <div className="dialog-body">
              {remoteTab === "ssh" ? (<>
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
                  <input className="dialog-input" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="192.168.1.100 或 myserver.com" autoFocus />
                </label>
                <label>
                  用户名
                  <input className="dialog-input" value={remoteUser} onChange={(e) => setRemoteUser(e.target.value)} placeholder="root" />
                </label>
                <label>
                  端口
                  <input className="dialog-input" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="22" type="number" />
                </label>
                <label>
                  远程路径 <span className="dialog-hint">（可选，默认 ~）</span>
                  <input className="dialog-input" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/home/user/project" />
                </label>
                <label>
                  密码 <span className="dialog-hint">（可选，免密可留空）</span>
                  <input className="dialog-input" value={remotePassword} onChange={(e) => setRemotePassword(e.target.value)} placeholder="输入 SSH 密码" type="password" />
                </label>
                <p className="dialog-note">
                  终端仍通过 SSH 启动远程 <code>pi</code>。左侧文件树和右侧文件查看会使用密码或免密方式单独建立 SFTP 连接。
                </p>
              </>) : (<>
                <label>
                  WSL 发行版
                  <select className="dialog-input" value={wslDistro} onChange={(e) => setWslDistro(e.target.value)} autoFocus>
                    <option value="">选择发行版</option>
                    {wslDistros.map((d) => (
                      <option key={d.name} value={d.name}>{d.default ? "⭐ " : ""}{d.name}{d.running ? " (运行中)" : ""} — WSL{d.version}</option>
                    ))}
                  </select>
                </label>
                <label>
                  工作路径 <span className="dialog-hint">（可选，默认 ~）</span>
                  <input className="dialog-input" value={wslPath} onChange={(e) => setWslPathLocal(e.target.value)} placeholder="~/projects/myapp" />
                </label>
                <p className="dialog-note">
                  直接通过 <code>wsl.exe</code> 进入指定发行版，无需 SSH。pi 将在 WSL 内运行。文件浏览通过 <code>\\wsl$\</code> 实现。
                </p>
              </>)}
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => { setShowRemote(false); setRemoteStatus(""); }}>取消</button>
              <button
                className="btn btn-primary"
                onClick={() => void handleRemote()}
                disabled={(remoteTab === "ssh" ? (!remoteHost || !remoteUser) : !wslDistro) || remoteStatus === "connecting"}
              >
                {remoteStatus === "connecting" ? "连接中…" : "连接"}
              </button>
            </div>
            {remoteStatus === "connecting" && <div className="dialog-status">{remoteTab === "wsl" ? `正在连接 WSL: ${wslDistro} …` : `正在连接 ${remoteUser}@${remoteHost} …`}</div>}
          </div>
        </div>
      )}

      {/* Remote directory picker */}
      {showRemotePicker && (
        <div className="dialog-overlay" onClick={() => { setShowRemotePicker(false); pickerTabRef.current = null; }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
            <div className="dialog-title">选择项目目录</div>
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
              <button className="btn btn-primary" onClick={() => void pickerSelect()}>选择当前目录</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      <ToastHost />
    </div>
  );
}
