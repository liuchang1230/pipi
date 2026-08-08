// Right-pane viewer state: the open file, follow settings, and their flags.
// openFile lives here as a store action so tree clicks and auto-follow share
// one race-safe seam (seq-guarded, latest-wins). The counters are module-level
// (like treeReqSeq) — they are not reactive state.
import { create } from "zustand";
import { useTabsStore } from "./tabsStore";
import { useTreeStore } from "./treeStore";
import { useUiStore } from "./uiStore";
import { useLayoutStore } from "./layoutStore";
import type { CurrentFile } from "../FileViewer";
import type { AutoFollowSettings } from "./types";

/** Module-level open sequencing: every open gets a number; only the latest
 *  may render. `manualSeq` marks an in-flight MANUAL open so auto-follow
 *  stands down until it settles (a follow read must never clobber a manual
 *  open, and vice versa). */
const openReq = { seq: 0, manualSeq: null as number | null };

/** True while a manual open is in flight — consulted by the viewer's
 *  auto-follow debounce (which stays out of the store). */
export const isManualOpenPending = (): boolean => openReq.manualSeq !== null;

/** Write-tool race: auto-follow fires when pi's toolCall is recorded in the
 *  session JSONL, possibly BEFORE a just-created file exists on disk
 *  (ENOENT locally, "No such file" over SFTP). Only those are worth retrying;
 *  a permission/unreachable error should fail fast, not stall ~1s. */
function isRetryableReadError(error: string): boolean {
  return error.includes("ENOENT") || error.includes("No such file");
}

interface ViewerState {
  currentFile: CurrentFile | null;
  /** Right-pane mode: file viewer or changes/version-compare panel. */
  viewerMode: "viewer" | "changes";
  setViewerMode: (mode: "viewer" | "changes") => void;
  /** File to focus when the changes panel opens (e.g. the file in the viewer). */
  changesFocusPath: string | null;
  setChangesFocusPath: (path: string | null) => void;
  fileLoading: boolean;
  followCfg: AutoFollowSettings;
  followDegraded: boolean;
  setCurrentFile: (file: CurrentFile | null) => void;
  setFileLoading: (v: boolean) => void;
  setFollowCfg: (cfg: AutoFollowSettings | ((prev: AutoFollowSettings) => AutoFollowSettings)) => void;
  setFollowDegraded: (v: boolean) => void;
  /** Open a file (relative to the tree origin) into the viewer. `followed`
   *  marks auto-follow opens (retried on ENOENT, never clobbering a manual
   *  open). Resolves reads against the TREE's origin, not the active tab. */
  openFile: (relPath: string, followed: boolean, originOverride?: { tabId?: string; rootPath?: string }) => Promise<void>;
}

export const useViewerStore = create<ViewerState>()((set, get) => ({
  currentFile: null,
  fileLoading: false,
  followCfg: { enabled: true, followReads: true },
  followDegraded: false,
  viewerMode: "viewer",
  setViewerMode: (mode) => set({ viewerMode: mode }),
  changesFocusPath: null,
  setChangesFocusPath: (path) => set({ changesFocusPath: path }),
  setCurrentFile: (currentFile) => set({ currentFile }),
  setFileLoading: (fileLoading) => set({ fileLoading }),
  setFollowCfg: (cfg) =>
    set((s) => ({ followCfg: typeof cfg === "function" ? (cfg as (prev: AutoFollowSettings) => AutoFollowSettings)(s.followCfg) : cfg })),
  setFollowDegraded: (followDegraded) => set({ followDegraded }),

  openFile: async (relPath, followed, originOverride) => {
    const tabs = useTabsStore.getState();
    const origin = useTreeStore.getState().treeOrigin;
    const tabId = originOverride?.tabId ?? origin?.tabId ?? tabs.activeTab ?? undefined;
    const rootPath = originOverride?.rootPath ?? origin?.rootPath;
    const seq = ++openReq.seq;
    if (!followed) openReq.manualSeq = seq;
    set({ fileLoading: true });
    try {
      let res = await window.api.file.read(tabId, relPath, rootPath);
      // Write-tool race: auto-follow fires when pi's toolCall is recorded in
      // the session JSONL, possibly BEFORE a just-created file exists on disk
      // (ENOENT). Retry briefly so the viewer lands on the real content.
      if (followed && res.error && isRetryableReadError(res.error) && seq === openReq.seq) {
        for (let attempt = 0; attempt < 4 && seq === openReq.seq; attempt++) {
          await new Promise((r) => setTimeout(r, 250));
          res = await window.api.file.read(tabId, relPath, rootPath);
          if (!res.error) break;
        }
      }
      if (seq !== openReq.seq) return; // a newer request already won
      if (res.error) {
        if (followed) return; // don't clobber the current view for a follow miss
        // Stale tree row (file deleted/moved): refresh the listing at its
        // origin so the dead row disappears, then show a clear error pane.
        void useTreeStore.getState().refresh();
        set({
          currentFile: {
            path: relPath,
            content: res.content,
            bytes: res.bytes,
            isBinary: false,
            followed: false,
            error: res.error,
            tabId,
            rootPath,
            source: tabs.isRemote ? "remote" : "local",
            sourceLabel: tabs.isRemote ? `${tabs.remoteLabel}${tabs.remoteDir ? `:${tabs.remoteDir}` : ""}` : tabs.cwd,
          },
        });
        // Opening a file always reveals the viewer, even if the user had
        // collapsed it (a click means they want to see the content).
        useLayoutStore.getState().setViewerCollapsed(false);
        return;
      }
      set({
        currentFile: {
          path: relPath,
          content: res.content,
          bytes: res.bytes,
          isBinary: res.isBinary,
          followed,
          tabId,
          rootPath,
          source: tabs.isRemote ? "remote" : "local",
          sourceLabel: tabs.isRemote ? `${tabs.remoteLabel}${tabs.remoteDir ? `:${tabs.remoteDir}` : ""}` : tabs.cwd,
        },
      });
      // Opening a file always reveals the viewer, even if the user had
      // collapsed it (a click means they want to see the content).
      useLayoutStore.getState().setViewerCollapsed(false);
    } catch (error) {
      if (seq === openReq.seq) {
        useUiStore.getState().showToast(error instanceof Error ? error.message : "读取文件失败", "err");
      }
    } finally {
      if (openReq.manualSeq === seq) openReq.manualSeq = null;
      if (seq === openReq.seq) set({ fileLoading: false });
    }
  },
}));

export type { AutoFollowSettings };
