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
 * are its own useState (theme, dialog open flags); the small
 * ViewerExpandButton leaf below subscribes to the layout slice but is a
 * self-contained component, so App itself still never re-renders.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { SidebarPane } from "./panes/SidebarPane";
import { TerminalPane } from "./panes/TerminalPane";
import { ViewerPane } from "./panes/ViewerPane";
import { ModelConfigDialog } from "./dialogs/ModelConfigDialog";
import { PiInstallDialog } from "./dialogs/PiInstallDialog";
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

/** 预览面板折叠后，悬浮在窗口右缘的展开按钮（订阅自己的 slice，App 本体不订阅）。 */
function ViewerExpandButton() {
  const collapsed = useLayoutStore((s) => s.viewerCollapsed);
  if (!collapsed) return null;
  return (
    <button
      className="viewer-expand-btn"
      title="展开预览"
      aria-label="展开预览"
      onClick={() => useLayoutStore.getState().toggleViewer()}
    >
      ❮
    </button>
  );
}

/** pi 更新 + 内置扩展同步横幅（RPC 聊天没有 TUI 的 Update Available 提示，app 层补齐）。
 * 仅在激活页签是终端视图（无聊天页）时渲染——聊天页有自己的通知条，
 * 两者读同一个 uiStore，任一关闭即全局消失。 */
function UpdateBanner() {
  const appUpdateInfo = useUiStore((s) => s.appUpdateInfo);
  const updateInfo = useUiStore((s) => s.updateInfo);
  const extNotice = useUiStore((s) => s.extNotice);
  const [busy, setBusy] = useState(false);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTab = useTabsStore((s) => s.activeTab);
  const activeIsChat = !!tabs.find((t) => t.id === activeTab && (t.mode === "rpc" || t.mode === "sdk"));

  if ((!appUpdateInfo && !updateInfo && !extNotice) || activeIsChat) return null;
  return (
    <div className="update-banner">
      {appUpdateInfo && (
        <div className="update-banner-row app-update-row">
          <span title={appUpdateInfo.notes || undefined}>
            pipi 有新版本：{appUpdateInfo.current} → {appUpdateInfo.latest} — 下载后运行安装包即可覆盖升级
          </span>
          <button
            className="btn btn-primary update-banner-btn"
            onClick={async () => {
              if (!appUpdateInfo.downloadUrl || !(await window.api.appUpdate.download(appUpdateInfo.downloadUrl))) {
                useUiStore.getState().showToast("无法打开 GitHub 下载页，请稍后重试", "err");
              }
            }}
          >
            下载更新
          </button>
          <button className="update-banner-close" onClick={() => useUiStore.getState().setAppUpdateInfo(null)} title="关闭">×</button>
        </div>
      )}
      {extNotice && (
        <div className="update-banner-row">
          <span>
            内置扩展已更新：{extNotice.files.join("、")} — 新开的会话将使用新版本
          </span>
          <button className="update-banner-close" onClick={() => useUiStore.getState().setExtNotice(null)} title="关闭">×</button>
        </div>
      )}
      {updateInfo && (
        <div className="update-banner-row">
          <span>
            pi 有新版本：{updateInfo.current} → {updateInfo.latest}（含扩展包更新）
          </span>
          <button
            className="btn btn-primary update-banner-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await window.api.update.run();
              setBusy(false);
              if (r.ok) {
                useUiStore.getState().setUpdateInfo(null);
                useUiStore.getState().showToast("更新完成，请重启标签页生效", "ok");
              } else {
                useUiStore.getState().showToast(`更新失败: ${r.error ?? r.output.slice(0, 120)}`, "err");
              }
            }}
          >
            {busy ? "更新中…" : "立即更新"}
          </button>
          <button className="update-banner-close" onClick={() => useUiStore.getState().setUpdateInfo(null)} title="关闭">×</button>
        </div>
      )}
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
    // Update notices (chat page + global banner share uiStore):
    // 1) pi itself / its extension packages have a newer version;
    // 2) app-bundled pi extensions were re-shipped at startup (content changed).
    window.api.appUpdate.check().then((r) => {
      if (r.hasUpdate && r.latest) {
        useUiStore.getState().setAppUpdateInfo({ current: r.current, latest: r.latest, downloadUrl: r.downloadUrl, notes: r.notes });
      }
    }).catch(() => {});
    window.api.update.check().then((r) => {
      if (r.hasUpdate) useUiStore.getState().setUpdateInfo({ current: r.current, latest: r.latest });
    }).catch(() => {});
    window.api.update.getExtensionSynced().then((r) => {
      if (r.files.length > 0) useUiStore.getState().setExtNotice({ files: r.files });
    }).catch(() => {});
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

  // Native menu commands share the same deep actions as the in-page controls,
  // so keyboard/menu behavior cannot drift from the visible workbench.
  useEffect(() => {
    return window.api.onWorkbenchCommand((command) => {
      switch (command) {
        case "project:open": void handleSelectDir(); break;
        case "remote:connect": setShowRemote(true); break;
        case "session:new": void useTabsStore.getState().createTab(); break;
        case "session:close": {
          const id = useTabsStore.getState().activeTab;
          if (id) void useTabsStore.getState().closeTab(id);
          break;
        }
        case "view:toggle-viewer": useLayoutStore.getState().toggleViewer(); break;
        case "view:toggle-theme": setTheme((t) => t === "dark" ? "light" : "dark"); break;
        case "models:configure": setShowModelConfig(true); break;
        case "help:shortcuts":
          useUiStore.getState().showToast("快捷键：Ctrl+O 打开项目 · Ctrl+N 新建会话 · Ctrl+W 关闭会话 · Ctrl+Shift+P 显示/隐藏预览 · Ctrl+Shift+L 切换主题", "ok");
          break;
      }
    });
  }, [handleSelectDir]);

  // --- Remote directory picker openers -------------------------------------
  const handleAddRemoteProject = useCallback(async () => {
    // SSH section +: find an SSH connection tab (never a WSL tab).
    const tabs = useTabsStore.getState().tabs;
    const remoteTab = tabs.find((t) => t.isRemote && !t.isWsl);
    if (!remoteTab) {
      useUiStore.getState().showToast("未连接远程终端，先点击顶部的 🌐 连接远程。\n连接成功后，再点这里的 + 选择远程项目目录。", "err");
      return;
    }
    pickerTabRef.current = remoteTab.id;
    setShowRemotePicker(true);
  }, []);

  /** Connect a WSL distro: activate its tab if open, otherwise create one. */
  /** In-flight WSL connects: a double-click must not open two tabs for one
   *  distro (tabs:update arrives async, so the `existing` lookup races). */
  const wslConnectingRef = useRef<Set<string>>(new Set());
  const connectWslDistro = useCallback(async (distro: string) => {
    const tabsState = useTabsStore.getState();
    const existing = tabsState.tabs.find((t) => t.isWsl && t.wslDistro === distro);
    if (existing) {
      await window.api.tab.activate(existing.id);
      tabsState.setActiveTab(existing.id);
      return;
    }
    if (wslConnectingRef.current.has(distro)) return; // already connecting
    wslConnectingRef.current.add(distro);
    try {
      await window.api.tab.create({ cwd: tabsState.cwd || ".", wsl: { distro } });
    } catch (e) {
      useUiStore.getState().showToast(`WSL ${distro} 连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      wslConnectingRef.current.delete(distro);
    }
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
  const pendingPaneWidthsRef = useRef<{ left?: number; right?: number }>({});
  const paneResizeFrameRef = useRef<number | null>(null);
  const flushPaneResize = useCallback(() => {
    paneResizeFrameRef.current = null;
    const pending = pendingPaneWidthsRef.current;
    pendingPaneWidthsRef.current = {};
    const layout = useLayoutStore.getState();
    if (pending.left !== undefined) layout.setLeftWidth(pending.left);
    if (pending.right !== undefined && !layout.viewerCollapsed) layout.setRightWidth(pending.right);
  }, []);
  const onLeftPaneResizerDown = useCallback(() => { leftPaneDragRef.current = true; }, []);
  const onRightPaneResizerDown = useCallback(() => { rightPaneDragRef.current = true; }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (leftPaneDragRef.current) pendingPaneWidthsRef.current.left = Math.max(220, Math.min(520, e.clientX));
      if (rightPaneDragRef.current && !useLayoutStore.getState().viewerCollapsed) {
        pendingPaneWidthsRef.current.right = Math.max(320, Math.min(900, window.innerWidth - e.clientX));
      }
      // Pointer events can arrive far more often than the display refresh.
      // One layout-store update per frame prevents a resize drag from causing
      // repeated React layouts and terminal fit() work between painted frames.
      if (paneResizeFrameRef.current === null && (leftPaneDragRef.current || rightPaneDragRef.current)) {
        paneResizeFrameRef.current = requestAnimationFrame(flushPaneResize);
      }
    };
    const onUp = () => {
      leftPaneDragRef.current = false;
      rightPaneDragRef.current = false;
      if (paneResizeFrameRef.current !== null) {
        cancelAnimationFrame(paneResizeFrameRef.current);
        paneResizeFrameRef.current = null;
      }
      flushPaneResize(); // commit the final pointer position immediately
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (paneResizeFrameRef.current !== null) cancelAnimationFrame(paneResizeFrameRef.current);
    };
  }, [flushPaneResize]);

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

      <div
        className="pane-resizer right-resizer"
        onMouseDown={onRightPaneResizerDown}
        onClick={() => {
          // Clicking the (now empty) edge brings the collapsed viewer back.
          const s = useLayoutStore.getState();
          if (s.viewerCollapsed) s.toggleViewer();
        }}
      >
        <ViewerExpandButton />
      </div>

      <ViewerPane />

      {showModelConfig && <ModelConfigDialog onClose={() => setShowModelConfig(false)} />}
      {/* /settings from chat opens the model config dialog via uiStore. */}
      {useUiStore((s) => s.appDialog) === "model-config" && <ModelConfigDialog onClose={() => useUiStore.getState().closeAppDialog()} />}
      {/* pi agent auto-install progress — main-driven, self-contained. */}
      <PiInstallDialog />
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
