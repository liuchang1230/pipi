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
 * working as long as the CLI and JSONL format stay consistent.
 *
 * Architecture: this file is the composition shell + event orchestration.
 * It holds NO reactive store subscriptions — panes (panes/*) subscribe to
 * their own slices, dialogs (dialogs/*) own their state, and every handler
 * here reads stores via getState() so a session-poll / auto-follow / tree
 * update never re-renders this component. The only things that re-render App
 * are its own useState (theme, dialog open flags).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { SidebarPane } from "./panes/SidebarPane";
import { TerminalPane } from "./panes/TerminalPane";
import { ViewerPane } from "./panes/ViewerPane";
import { ModelConfigDialog } from "./dialogs/ModelConfigDialog";
import { RemoteDialog } from "./dialogs/RemoteDialog";
import { RemoteDirPicker } from "./dialogs/RemoteDirPicker";
import { useTabsStore } from "./stores/tabsStore";
import { useSessionsStore } from "./stores/sessionsStore";
import { useTreeStore } from "./stores/treeStore";
import { useViewerStore } from "./stores/viewerStore";
import { useUiStore } from "./stores/uiStore";
import { useLayoutStore } from "./stores/layoutStore";
import type { SessionItem } from "./stores/types";

/** Renders the app-wide toast from uiStore (transient, 3s auto-dismiss). */
function ToastHost() {
  const toast = useUiStore((s) => s.toast);
  if (!toast) return null;
  return <div className={`toast toast-${toast.type}`}>{toast.text}</div>;
}

/** pi 更新横幅（RPC 聊天没有 TUI 的 Update Available 提示，app 层补齐）。 */
function UpdateBanner() {
  const [info, setInfo] = useState<{ current: string | null; latest: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.api.update.check().then((r) => {
      if (!cancelled && r.hasUpdate) setInfo({ current: r.current, latest: r.latest });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;
  return (
    <div className="update-banner">
      <span>
        pi 有新版本：{info.current} → {info.latest}（含扩展包更新）
      </span>
      <button
        className="btn btn-primary update-banner-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await window.api.update.run();
          setBusy(false);
          if (r.ok) {
            setInfo(null);
            useUiStore.getState().showToast("更新完成，请重启标签页生效", "ok");
          } else {
            useUiStore.getState().showToast(`更新失败: ${r.error ?? r.output.slice(0, 120)}`, "err");
          }
        }}
      >
        {busy ? "更新中…" : "立即更新"}
      </button>
      <button className="update-banner-close" onClick={() => setInfo(null)} title="关闭">×</button>
    </div>
  );
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

  // --- Dialog open flags (dialogs own their state internally) -------------
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const pickerTabRef = useRef<string | null>(null);

  // --- Activation bookkeeping (refs mirror the store for the stable handler) ---
  const activeTabRef = useRef<string | null>(null);
  const activeCwdRef = useRef<string | null>(null);
  const remoteDirRef = useRef<string | null>(null);

  // --- Activation + initial load (the orchestration hub) ------------------
  useEffect(() => {
    // Initial catalog load: the sidebar project list and the remote-history
    // dropdown must be populated at start.
    void useSessionsStore.getState().refreshProjects();
    window.api.remote.listHistory().then((list) => useSessionsStore.getState().setRemoteHistory(list)).catch(() => {});
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
  }, []);

  // --- Local project: native dir picker → project + tab --------------------
  const handleSelectDir = useCallback(async () => {
    const dir = await window.api.selectDir();
    if (!dir) return;
    await useSessionsStore.getState().addLocalProject(dir);
    await window.api.tab.create({ cwd: dir });
  }, []);

  // --- Remote directory picker openers -------------------------------------
  const handleAddRemoteProject = useCallback(async () => {
    // SSH section +: find an SSH connection tab (never a WSL tab).
    const tabs = useTabsStore.getState().tabs;
    const remoteTab = tabs.find((t) => t.isRemote && !t.isWsl);
    if (!remoteTab) {
      alert("未连接远程终端，先点击顶部的 🌐 连接远程。\n连接成功后，再点这里的 + 选择远程项目目录。");
      return;
    }
    pickerTabRef.current = remoteTab.id;
    setShowRemotePicker(true);
  }, []);

  /** Connect a WSL distro: activate its tab if open, otherwise create one. */
  const connectWslDistro = useCallback(async (distro: string) => {
    const tabsState = useTabsStore.getState();
    const existing = tabsState.tabs.find((t) => t.isWsl && t.wslDistro === distro);
    if (existing) {
      await window.api.tab.activate(existing.id);
      tabsState.setActiveTab(existing.id);
      return;
    }
    await window.api.tab.create({ cwd: tabsState.cwd || ".", wsl: { distro } });
  }, []);

  /** WSL connection node +: open the dir picker rooted at that distro's home. */
  const addWslProject = useCallback(async (distro: string) => {
    // Use the created tab id directly (tabs state updates asynchronously, so
    // a find() right after create() could miss the new tab).
    try {
      const tabs = useTabsStore.getState().tabs;
      const existing = tabs.find((t) => t.isWsl && t.wslDistro === distro);
      const id = existing?.id ?? await window.api.tab.create({ cwd: useTabsStore.getState().cwd || ".", wsl: { distro } });
      pickerTabRef.current = id;
      setShowRemotePicker(true);
    } catch (e) {
      useUiStore.getState().showToast(`WSL ${distro} 连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, []);

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
      <TerminalPane theme={theme} onShowRemote={() => setShowRemote(true)} onShowModels={() => setShowModelConfig(true)} />

      <div className="pane-resizer" onMouseDown={onRightPaneResizerDown} />

      <ViewerPane />

      {showModelConfig && <ModelConfigDialog onClose={() => setShowModelConfig(false)} />}
      {showRemote && <RemoteDialog onClose={() => setShowRemote(false)} />}
      {showRemotePicker && pickerTabRef.current && (
        <RemoteDirPicker
          tabId={pickerTabRef.current}
          onClose={() => { setShowRemotePicker(false); pickerTabRef.current = null; }}
        />
      )}

      {/* Toast notification */}
      <ToastHost />
      <UpdateBanner />
    </div>
  );
}
