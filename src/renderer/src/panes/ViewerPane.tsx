// Right pane: the editable file viewer + auto-follow. Subscribes only to the
// viewer slice (plus tab context for the badge/save target and layout for the
// pane width). Auto-follow lives here end-to-end: it consumes main's
// file:autofollow events, debounces them, and routes through the viewer
// store's race-safe openFile action.
import { useCallback, useEffect, useRef, useState } from "react";
import FileViewer, { type CurrentFile } from "../FileViewer";
import { useTabsStore } from "../stores/tabsStore";
import { useTreeStore } from "../stores/treeStore";
import { useUiStore } from "../stores/uiStore";
import { useViewerStore, isManualOpenPending } from "../stores/viewerStore";
import { ChangesView } from "./ChangesView";
import { useLayoutStore } from "../stores/layoutStore";

export function ViewerPane() {
  const currentFile = useViewerStore((s) => s.currentFile);
  const fileLoading = useViewerStore((s) => s.fileLoading);
  const followCfg = useViewerStore((s) => s.followCfg);
  const setFollowCfg = useViewerStore((s) => s.setFollowCfg);
  const followDegraded = useViewerStore((s) => s.followDegraded);
  const setFollowDegraded = useViewerStore((s) => s.setFollowDegraded);
  const openFile = useViewerStore((s) => s.openFile);
  const viewerMode = useViewerStore((s) => s.viewerMode);
  const setViewerMode = useViewerStore((s) => s.setViewerMode);
  const changesFocusPath = useViewerStore((s) => s.changesFocusPath);
  const setChangesFocusPath = useViewerStore((s) => s.setChangesFocusPath);
  const activeTab = useTabsStore((s) => s.activeTab);
  const isRemote = useTabsStore((s) => s.isRemote);
  const remoteLabel = useTabsStore((s) => s.remoteLabel);
  const rightWidth = useLayoutStore((s) => s.rightWidth);
  const viewerCollapsed = useLayoutStore((s) => s.viewerCollapsed);
  const toggleViewer = useLayoutStore((s) => s.toggleViewer);
  const wasCollapsedRef = useRef(viewerCollapsed);

  const [followSettingsState, setFollowSettingsState] = useState<"loading" | "ready" | "error">("loading");
  const [followMenuOpen, setFollowMenuOpen] = useState(false);

  // A width transition gives xterm's ResizeObserver a stable sequence of
  // dimensions instead of a single abrupt reflow when the preview collapses.
  // That eliminates the visible one-to-two-frame terminal distortion.
  useEffect(() => {
    if (wasCollapsedRef.current === viewerCollapsed) return;
    wasCollapsedRef.current = viewerCollapsed;
    const timer = setTimeout(() => window.dispatchEvent(new Event("resize")), 180);
    return () => clearTimeout(timer);
  }, [viewerCollapsed]);

  // Refs so the stable auto-follow listener never reads stale closures.
  const currentFileRef = useRef<CurrentFile | null>(null);
  const followCfgRef = useRef(followCfg);
  const followTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    currentFileRef.current = currentFile;
    followCfgRef.current = followCfg;
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
  }, [setFollowCfg]);

  // Persist on change (never during the initial load, to avoid clobbering
  // stored values with defaults).
  useEffect(() => {
    if (followSettingsState === "loading") return;
    void window.api.settings.set({ autoFollow: followCfg }).catch(() => {
      /* persistence is best-effort */
    });
  }, [followCfg, followSettingsState]);

  const handleFollowChange = useCallback(
    (patch: Partial<typeof followCfg>) => {
      setFollowCfg((prev) => ({ ...prev, ...patch }));
    },
    [setFollowCfg],
  );

  // Trailing debounce + latest-wins sequencing: a burst of follow events
  // (e.g. session-resume replay) collapses to the last file, and a stale
  // in-flight read can never overwrite a newer one.
  const scheduleFollow = useCallback((path: string) => {
    if (followTimer.current) clearTimeout(followTimer.current);
    followTimer.current = setTimeout(() => {
      // Re-verify at fire time — the user may have acted during the debounce.
      if (!followCfgRef.current.enabled) return;
      if (isManualOpenPending()) return; // a manual open is in flight
      const cur = currentFileRef.current;
      if (cur && !cur.followed) return; // now pinned by a manual open
      void useViewerStore.getState().openFile(path, true);
    }, 180);
  }, []);

  // Keep the file tree in sync with pi's writes: newly created files must
  // appear and deleted/moved ones must vanish, or stale rows linger and
  // clicking them yields ENOENT. Refreshes at the tree's ORIGIN so previews
  // of other projects are never clobbered by the active tab's activity.
  // Debounced; remote/WSL listings and previews are skipped (they would
  // churn or target the wrong project).
  const treeRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleTreeRefresh = useCallback(() => {
    const ts = useTreeStore.getState();
    const origin = ts.treeOrigin;
    if (!origin || origin.isRemote || origin.rootPath) return;
    if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current);
    treeRefreshTimer.current = setTimeout(() => {
      treeRefreshTimer.current = null;
      void ts.refresh();
    }, 400);
  }, []);

  // A tab switch makes any pending auto-follow open's context stale.
  useEffect(() => {
    if (followTimer.current) clearTimeout(followTimer.current);
  }, [activeTab, isRemote]);

  useEffect(() => {
    const off = window.api.onAutoFollow(({ path, kind, tabId }) => {
      // The preview is workbench state. Ignore a watcher seed/event from a
      // session that has ceased to be active while it was in flight.
      if (tabId && tabId !== useTabsStore.getState().activeTab) return;
      // Preview mode: the tree+viewer show another project; the active tab's
      // pi activity must not hijack them.
      if (useTreeStore.getState().treeOrigin?.rootPath) return;
      const cfg = followCfgRef.current;
      if (!cfg.enabled) return;
      if (kind === "read" && !cfg.followReads) return;
      const cur = currentFileRef.current;
      // Pin: a manually opened file is never yanked away by auto-follow.
      if (cur && !cur.followed) return;
      // Dedup: a read of the currently displayed file changes nothing.
      if (cur && cur.path === path && kind === "read") return;
      // Writes create/mutate files — refresh the tree so new files show up
      // and deleted ones disappear (stale rows currently yield ENOENT).
      if (kind === "write") scheduleTreeRefresh();
      scheduleFollow(path);
    });
    const offStatus = window.api.onAutoFollowStatus((status) => {
      if (status.ok) {
        setFollowDegraded(false);
        return;
      }
      setFollowDegraded(true);
      useUiStore.getState().showToast("自动跟随已降级：会话日志格式不兼容", "err");
    });
    return () => {
      off();
      offStatus();
    };
    // No isRemote guard here: main stops the watcher before activating a remote
    // tab, and IPC ordering guarantees pending follow events arrive first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleFollow, scheduleTreeRefresh, setFollowDegraded]);

  const handleFileSaved = useCallback(
    async (path: string) => {
      await useTreeStore.getState().refresh();
      await useViewerStore.getState().openFile(path, false);
    },
    [],
  );

  return (
    <aside
      className={`viewer${viewerCollapsed ? " collapsed" : ""}`}
      style={{ width: viewerCollapsed ? 0 : rightWidth, transition: "width 160ms ease" }}
    >
      <div className="viewer-header">
        <button className="viewer-toggle" onClick={toggleViewer} title={viewerCollapsed ? "展开预览" : "收起预览"} aria-label={viewerCollapsed ? "展开预览" : "收起预览"}>
          <span className="viewer-toggle-icon">{viewerCollapsed ? "❮" : "❯"}</span>
        </button>
        {!viewerCollapsed && (
          <div className="viewer-modes" role="tablist">
            <button
              className={`viewer-mode${viewerMode === "viewer" ? " active" : ""}`}
              onClick={() => setViewerMode("viewer")}
              title="文件查看器"
            >查看</button>
            <button
              className={`viewer-mode${viewerMode === "changes" ? " active" : ""}`}
              onClick={() => {
                setViewerMode("changes");
                // 变更面板默认聚焦当前查看器打开的文件。
                setChangesFocusPath(useViewerStore.getState().currentFile?.path ?? null);
              }}
              title="当前文件的变更与版本对比"
            >变更</button>
          </div>
        )}
        {!viewerCollapsed && viewerMode === "viewer" && <span className="viewer-path">{currentFile?.path ?? "（未选择文件）"}</span>}
        {!viewerCollapsed && viewerMode === "viewer" && <div className="viewer-meta">
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
                      onChange={(e) => handleFollowChange({ enabled: e.target.checked })}
                    />
                    <span>自动跟随（AI 操作文件时自动显示）</span>
                  </label>
                  <label className={`follow-option${followCfg.enabled ? "" : " disabled"}`}>
                    <input
                      type="checkbox"
                      checked={followCfg.followReads}
                      disabled={!followCfg.enabled}
                      onChange={(e) => handleFollowChange({ followReads: e.target.checked })}
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
      {!viewerCollapsed && viewerMode === "viewer" && (
        <FileViewer
          file={currentFile}
          loading={fileLoading}
          tabId={activeTab ?? undefined}
          onSaved={handleFileSaved}
          onToast={(msg, type) => useUiStore.getState().showToast(msg, type)}
        />
      )}
      {!viewerCollapsed && viewerMode === "changes" && (
        <ChangesView
          tabId={activeTab ?? ""}
          focusPath={changesFocusPath}
          onFocusPathHandled={() => setChangesFocusPath(null)}
        />
      )}
    </aside>
  );
}
