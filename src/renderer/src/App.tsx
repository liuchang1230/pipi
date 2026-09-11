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
import { OnboardingDialog } from "./dialogs/OnboardingDialog";
import { RemoteDialog } from "./dialogs/RemoteDialog";
import { RemoteDirPicker } from "./dialogs/RemoteDirPicker";
import { RemotePasswordDialog } from "./dialogs/RemotePasswordDialog";
import { serverProfile, type RemoteProfileTarget, type TargetRef } from "./stores/remote-target";
import { useRemoteStore } from "./stores/remoteStore";
import { useTabsStore } from "./stores/tabsStore";
import { useChatStore } from "./stores/chatStore";
import { useSessionsStore } from "./stores/sessionsStore";
import { useTreeStore } from "./stores/treeStore";
import { useViewerStore } from "./stores/viewerStore";
import { useUiStore } from "./stores/uiStore";
import { useLayoutStore } from "./stores/layoutStore";
import type { RemoteServerGroup, SessionItem, RemoteHistoryItem } from "./stores/types";

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

/** Login dialog host: owns the password dialog for BOTH paths — main's
 *  discovered auth failures (SFTP breaker / probe / background poll) and an
 *  explicit click request. Self-contained, so App keeps zero store
 *  subscriptions (its rendering stays limited to its own dialog flags). */
function RemoteLoginDialogHost() {
  const request = useRemoteStore((s) => s.loginRequest);
  const busy = useRemoteStore((s) => s.loginBusy);
  if (!request) return null;
  return (
    <RemotePasswordDialog
      request={request}
      busy={busy}
      onSubmit={(password, remember) => {
        void (async () => {
          const ok = await useRemoteStore.getState().submitLogin(password, remember);
          if (!ok) return;
          useUiStore.getState().showToast(`已连接到 ${request.remote.user}@${request.remote.host}`, "ok");
          // The credential now exists for this server: refresh the catalog so
          // its project rows can load sessions through the profile.
          void useSessionsStore.getState().refreshProjects();
        })();
      }}
      onCancel={() => useRemoteStore.getState().dismissLogin()}
    />
  );
}

/** pi 更新 + 内置扩展同步横幅（RPC 聊天没有 TUI 的 Update Available 提示，app 层补齐）。
 * 仅在激活页签是终端视图（无聊天页）时渲染——聊天页有自己的通知条，
 * 两者读同一个 uiStore，任一关闭即全局消失。 */
function UpdateBanner() {
  const appUpdateInfo = useUiStore((s) => s.appUpdateInfo);
  const updateInfo = useUiStore((s) => s.updateInfo);
  const updateResult = useUiStore((s) => s.updateResult);
  const piUpdating = useUiStore((s) => s.piUpdating);
  const extNotice = useUiStore((s) => s.extNotice);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTab = useTabsStore((s) => s.activeTab);
  const activeIsChat = !!tabs.find((t) => t.id === activeTab && (t.mode === "rpc" || t.mode === "sdk"));

  if ((!appUpdateInfo && !updateInfo && !extNotice && !updateResult) || activeIsChat) return null;
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
      {updateResult ? (
        <div className={`update-banner-row${updateResult.ok ? " ok" : " err"}`}>
          <span>
            {updateResult.ok
              ? `pi agent 更新成功：已更新到 ${updateResult.version ?? "最新版"}，请重启标签页生效`
              : `pi agent 更新失败：${updateResult.error ?? "未知错误"}`}
          </span>
          <button className="update-banner-close" onClick={() => useUiStore.getState().setUpdateResult(null)} title="关闭">×</button>
        </div>
      ) : updateInfo ? (
        <div className="update-banner-row">
          <span>
            {piUpdating
              ? "正在更新 pi agent 和扩展包…"
              : updateInfo.targetLabel
                ? `${updateInfo.targetLabel} pi agent 版本（${updateInfo.current ?? "?"}）与应用配套版本（${updateInfo.latest ?? "?"}）不一致；更新将对齐版本并同步扩展包`
                : updateInfo.latest
                  ? `pi agent 有新版本：${updateInfo.current ?? "?"} → ${updateInfo.latest}${updateInfo.extensions.length ? `；扩展包也有更新：${updateInfo.extensions.join("、")}` : ""}`
                  : `pi 扩展包有更新：${updateInfo.extensions.join("、")}`}
          </span>
          <button
            className="btn btn-primary update-banner-btn"
            disabled={piUpdating}
            onClick={() => void useUiStore.getState().runPiUpdate()}
          >
            {piUpdating ? "更新中…" : "立即更新"}
          </button>
          <button className="update-banner-close" onClick={() => useUiStore.getState().setUpdateInfo(null)} title="关闭">×</button>
        </div>
      ) : null}
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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const pickerTargetRef = useRef<TargetRef | null>(null);
  /** Remote pi probe errors shown once per tab per session (no toast spam on
   *  repeated tab switches while the probe result is cached). */
  const probeErrorShownRef = useRef<Set<string>>(new Set());

  // --- Activation bookkeeping (refs mirror the store for the stable handler) ---
  const activeTabRef = useRef<string | null>(null);
  const activeCwdRef = useRef<string | null>(null);
  const remoteDirRef = useRef<string | null>(null);

  // --- Activation + initial load (the orchestration hub) ------------------
  useEffect(() => {
    // Initial catalog load: the sidebar project list and the remote-history
    // dropdown must be populated at start.
    void (async () => {
      const [settings] = await Promise.all([
        window.api.settings.get().catch(() => null),
        useSessionsStore.getState().refreshProjects(),
      ]);
      if (!settings?.onboarding?.seenAt && useSessionsStore.getState().projects.length === 0) {
        setShowOnboarding(true);
        void window.api.settings.set({ onboarding: { seenAt: Date.now() } }).catch(() => {});
      }
    })();
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
      const tabsState = useTabsStore.getState();
      const active = tabsState.tabs.find((t) => t.id === tabsState.activeTab);
      // A slow startup-local check must never replace a notice for a remote
      // execution target selected while the check was in flight. When tabs
      // already exist but activeTab is not hydrated yet, defer to onActiveTab.
      if (active?.isRemote || (tabsState.tabs.length > 0 && !active)) return;
      if (r.hasUpdate) {
        useUiStore.getState().setUpdateResult(null);
        useUiStore.getState().setUpdateInfo({ current: r.current, latest: r.latest, extensions: r.extensions ?? [] });
      }
    }).catch(() => {});
    window.api.update.getExtensionSynced().then((r) => {
      if (r.files.length > 0) useUiStore.getState().setExtNotice({ files: r.files });
    }).catch(() => {});
    const offTabs = window.api.onTabsUpdate((list) => {
      useTabsStore.setState({ tabs: list });
      // Tab list is authoritative: drop chat state (full transcripts) for tabs
      // that no longer exist, or memory grows with every session ever opened.
      useChatStore.getState().retainTabs(new Set(list.map((t) => t.id)));
    });
    // Main-discovered connection state (SFTP breaker / probe). The dialog host
    // component above consumes it, so App itself stays subscription-free.
    const offRemoteStatus = window.api.remote.onStatus((ev) => useRemoteStore.getState().applyStatusEvent(ev));
    const offActive = window.api.onActiveTab(async ({ id, cwd: c, isRemote: r, sessions: payloadSessions }) => {
      const prevActive = activeTabRef.current;
      if (!id) {
        useUiStore.getState().setUpdateInfo(null);
      } else if (r) {
        useUiStore.getState().setUpdateInfo(null);
        useUiStore.getState().setUpdateResult(null);
        window.api.update.checkTarget(id).then((info) => {
          if (activeTabRef.current !== id) return;
          if (info.hasUpdate) {
            useUiStore.getState().setUpdateInfo({ current: info.current, latest: info.latest, extensions: info.extensions ?? [], targetLabel: info.target.label, targetTabId: id });
            return;
          }
          // The remote pi probe failed (missing pi / runtime too old / …):
          // surface the reason once per tab instead of failing silently.
          if (info.error && !probeErrorShownRef.current.has(id)) {
            probeErrorShownRef.current.add(id);
            useUiStore.getState().showToast(`${info.target.label}：${info.error}`, "err");
          }
        }).catch(() => {});
      } else if (id && !r) {
        useUiStore.getState().setUpdateInfo(null);
        useUiStore.getState().setUpdateResult(null);
        window.api.update.check().then((info) => {
          if (activeTabRef.current !== id || !info.hasUpdate) return;
          useUiStore.getState().setUpdateInfo({ current: info.current, latest: info.latest, extensions: info.extensions });
        }).catch(() => {});
      }
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
        // The file preview is workbench state, independent of the active
        // session/tab. Its captured tab/root origin keeps reads and saves
        // pointed at the file that was originally opened.
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
          remoteLabel: remoteInfo && (remoteInfo as any).isWsl ? `WSL ${(remoteInfo as any).host}` : remoteInfo ? `${remoteInfo.user}@${remoteInfo.host}` : "远程",
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
      offRemoteStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Local project: native dir picker → project + tab --------------------
  const handleSelectDir = useCallback(async (): Promise<boolean> => {
    const dir = await window.api.selectDir();
    if (!dir) return false;
    await useSessionsStore.getState().addLocalProject(dir);
    await window.api.tab.create({ cwd: dir });
    return true;
  }, []);

  const skipOnboarding = useCallback(() => {
    setShowOnboarding(false);
  }, []);

  const completeOnboarding = useCallback(() => {
    setShowOnboarding(false);
    void window.api.settings.set({ onboarding: { completedAt: Date.now() } }).catch(() => {});
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

  // --- Remote server nodes + directory pickers ---------------------------
  /** "远程服务器" section header +: open the connect dialog (new server). */
  const handleAddRemoteServer = useCallback(() => setShowRemote(true), []);

  /** Ensure a connection tab exists for a server node; returns its tab id.
   *  Reuses an open tab (any tab with the same remoteKey), otherwise spawns a
   *  connection shell tab (startPi:false) and waits for the honest SSH state:
   *  ready (remote shell confirmed) vs failed (ssh exited) vs timeout (tab is
   *  up, probably waiting at a password prompt — the terminal is the login
   *  surface). Never claims "已连接" without the ready marker. */
  const serverConnectingRef = useRef<Set<string>>(new Set());
  const ensureRemoteConnection = useCallback(async (server: RemoteServerGroup): Promise<string | null> => {
    const tabs = useTabsStore.getState().tabs;
    // Reuse an open tab, preferring the connection shell tab ("· 连接") so
    // the server node opens the server's terminal rather than a chat view.
    // Never reuse a FAILED shell tab (ssh exited before the ready marker):
    // the renderer may still hold it briefly after main drops it, and
    // activating a dead tab would silently no-op.
    const candidates = tabs.filter((t) => t.isRemote && !t.isWsl && t.remoteKey === server.key && t.sshState !== "failed");
    const existing = candidates.find((t) => t.kind === "connection") ?? candidates[0];
    if (existing) return existing.id;
    if (serverConnectingRef.current.has(server.key)) return null; // in flight
    serverConnectingRef.current.add(server.key);
    try {
      const id = await window.api.tab.create({
        cwd: useTabsStore.getState().cwd || ".",
        remote: {
          host: server.host,
          user: server.user,
          port: server.port,
          password: server.password,
          path: server.path || undefined,
          agentDir: server.agentDir,
          startPi: false,
        },
      });
      const state = await window.api.tab.waitConnState(id, 10000, 250);
      if (state === "failed") {
        useUiStore.getState().showToast(`连接失败: ${server.user}@${server.host}（请检查地址/密码/免密配置）`, "err");
        return null;
      }
      if (state === "ready") useUiStore.getState().showToast(`已连接到 ${server.user}@${server.host}`, "ok");
      else useUiStore.getState().showToast(`已发起连接；如服务器要求密码，请在终端标签页输入`, "ok");
      // tab:create already persisted the history entry on the main side;
      // refresh the renderer copy so the node survives restarts with password.
      window.api.remote.listHistory().then((list) => useSessionsStore.getState().setRemoteHistory(list as RemoteHistoryItem[])).catch(() => {});
      return id;
    } catch (e) {
      useUiStore.getState().showToast(`连接 ${server.user}@${server.host} 失败: ${e instanceof Error ? e.message : String(e)}`, "err");
      return null;
    } finally {
      serverConnectingRef.current.delete(server.key);
    }
  }, []);

  /** Probe a server and make it the connection — NO tab is created, so the
   *  middle pane never changes when the user clicks a server. When auth needs
   *  a password the login dialog takes over (the credential is remembered
   *  through remote-history, which is what the next probe reads). */
  const connectRemoteProfile = useCallback(async (remote: RemoteProfileTarget, options?: { remember?: boolean; quiet?: boolean }): Promise<boolean> => {
    const outcome = await useRemoteStore.getState().probe(remote, { remember: options?.remember });
    if (outcome.ok) {
      if (!options?.quiet) useUiStore.getState().showToast(`已连接到 ${remote.user}@${remote.host}`, "ok");
      return true;
    }
    if (outcome.needPassword) {
      // The dialog is owned by RemoteLoginDialogHost; the click path and main's
      // own status events funnel into the same request.
      useRemoteStore.getState().requestLogin(remote, outcome.error);
      return false;
    }
    useUiStore.getState().showToast(
      `连接失败: ${remote.user}@${remote.host}${outcome.error ? `（${outcome.error}）` : "（请检查地址/端口/免密配置）"}`,
      "err",
    );
    return false;
  }, []);

  /** Server node click: probe only. The SSH handle stays out of the tab bar. */
  const handleConnectServer = useCallback(async (server: RemoteServerGroup): Promise<boolean> => {
    return connectRemoteProfile(serverProfile(server));
  }, [connectRemoteProfile]);

  /** Explicitly focus a server's raw shell terminal. This is the ONE path
   * that still creates a connection tab — the user asked for a terminal, and
   * a terminal tab is exactly where a password prompt can be answered. */
  const handleOpenServerTerminal = useCallback(async (server: RemoteServerGroup): Promise<void> => {
    const tabId = await ensureRemoteConnection(server);
    if (!tabId) return;
    const ok = await window.api.tab.activate(tabId);
    if (ok) useTabsStore.getState().setActiveTab(tabId);
  }, [ensureRemoteConnection]);

  /** Server node +: browse THAT server's directories (never the first tab).
   *  Needs a working connection, but a probe — not a tab — decides that. */
  const handleAddRemoteProjectForServer = useCallback(async (server: RemoteServerGroup) => {
    const remote = serverProfile(server);
    const ok = await connectRemoteProfile(remote, { quiet: true });
    if (!ok) return;
    pickerTargetRef.current = { remote };
    setShowRemotePicker(true);
  }, [connectRemoteProfile]);

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
      pickerTargetRef.current = id;
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
      if (leftPaneDragRef.current) pendingPaneWidthsRef.current.left = Math.max(190, Math.min(520, e.clientX));
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
        onAddRemoteServer={handleAddRemoteServer}
        onConnectServer={handleConnectServer}
        onOpenServerTerminal={(server) => void handleOpenServerTerminal(server)}
        onAddRemoteProjectForServer={(server) => void handleAddRemoteProjectForServer(server)}
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

      <OnboardingDialog
        open={showOnboarding}
        onConfigureModel={() => setShowModelConfig(true)}
        onAddLocalProject={handleSelectDir}
        onConnectRemote={() => setShowRemote(true)}
        onSkip={skipOnboarding}
        onComplete={completeOnboarding}
      />
      {showModelConfig && <ModelConfigDialog onClose={() => setShowModelConfig(false)} />}
      {/* /settings from chat opens the model config dialog via uiStore. */}
      {useUiStore((s) => s.appDialog) === "model-config" && <ModelConfigDialog onClose={() => useUiStore.getState().closeAppDialog()} />}
      {/* pi agent auto-install progress — main-driven, self-contained. */}
      <PiInstallDialog />
      {showRemote && <RemoteDialog onClose={() => setShowRemote(false)} />}
      {showRemotePicker && pickerTargetRef.current && (
        <RemoteDirPicker
          target={pickerTargetRef.current}
          onClose={() => { setShowRemotePicker(false); pickerTargetRef.current = null; }}
        />
      )}

      {/* Toast notification */}
      <RemoteLoginDialogHost />
      <ToastHost />
      <UpdateBanner />
    </div>
  );
}
