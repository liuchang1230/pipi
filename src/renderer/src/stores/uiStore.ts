// App-wide transient toast + update/extensions notices. Any store action can
// report an error via getState().showToast without a callback being threaded
// through containers; the ToastHost in App renders it. Auto-dismisses after
// 3s (timer is shared so rapid consecutive toasts replace each other cleanly).
//
// updateInfo / extNotice are read by BOTH the global UpdateBanner (terminal
// views, no chat page) and the in-chat notice bar (ChatPane), so a dismiss in
// either place is global.
import { create } from "zustand";

export type ToastType = "ok" | "err";

export interface UpdateNoticeInfo {
  current: string | null;
  latest: string | null;
  extensions: string[];
  /** Omitted for the local agent; present when the checked pi runs on SSH/WSL. */
  targetLabel?: string;
  /** Authoritative tab id used to execute a remote update in that exact target. */
  targetTabId?: string;
}

export interface AppUpdateNoticeInfo {
  current: string;
  latest: string;
  downloadUrl?: string;
  notes?: string;
}

export interface ExtensionNoticeInfo {
  files: string[];
}

/** Outcome of running the pi (agent) update, surfaced as a success/failure
 *  notice in both the chat notice bar and the global banner — so after
 *  "立即更新" the user sees 更新中… then 更新成功（到哪个版本）or 更新失败. */
export interface PiUpdateResult {
  ok: boolean;
  /** Version it updated to (ok only). */
  version?: string;
  /** Failure detail (ok=false). */
  error?: string;
}

interface UiState {
  toast: { text: string; type: ToastType } | null;
  showToast: (text: string, type: ToastType) => void;
  clearToast: () => void;
  /** A newer pipi desktop installer is published on GitHub Releases. */
  appUpdateInfo: AppUpdateNoticeInfo | null;
  setAppUpdateInfo: (info: AppUpdateNoticeInfo | null) => void;
  /** pi (and its extension packages) has a newer version available. */
  updateInfo: UpdateNoticeInfo | null;
  setUpdateInfo: (info: UpdateNoticeInfo | null) => void;
  /** Result of the last pi update attempt (shown instead of the offer once set). */
  updateResult: PiUpdateResult | null;
  setUpdateResult: (r: PiUpdateResult | null) => void;
  /** A pi update is in flight (shared by chat notice bar + global banner so
   *  both consistently show "更新中…" and a second click is prevented). */
  piUpdating: boolean;
  setPiUpdating: (updating: boolean) => void;
  /** Runs the complete update workflow once for every renderer presentation. */
  runPiUpdate: () => Promise<void>;
  /** App-bundled pi extensions were re-shipped at startup with new content. */
  extNotice: ExtensionNoticeInfo | null;
  setExtNotice: (info: ExtensionNoticeInfo | null) => void;
  /** Monotonic bump every time the model config dialog saves/deletes/transplants
   *  a model config — ChatViews consume it to hot-sync their RUNNING pi session. */
  modelConfigSavedAt: number;
  /** The save target of the LAST modelConfigSavedAt bump (local / WSL distro /
   *  remote profile), so each ChatView can decide whether the save applies to it. */
  modelConfigTarget: { kind: "local" } | { kind: "wsl"; distro: string } | { kind: "remote"; host: string; user: string; port: number; agentDir?: string };
  markModelConfigSaved: (target: UiState["modelConfigTarget"]) => void;
  /** Global app dialog requested from anywhere (e.g. /settings from chat). */
  appDialog: "model-config" | null;
  openAppDialog: (d: "model-config") => void;
  closeAppDialog: () => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useUiStore = create<UiState>()((set) => ({
  toast: null,
  showToast: (text, type) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: { text, type } });
    toastTimer = setTimeout(() => set({ toast: null }), 3000);
  },
  clearToast: () => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: null });
  },
  appUpdateInfo: null,
  setAppUpdateInfo: (appUpdateInfo) => set({ appUpdateInfo }),
  updateInfo: null,
  setUpdateInfo: (updateInfo) => set({ updateInfo }),
  updateResult: null,
  setUpdateResult: (updateResult) => set({ updateResult }),
  piUpdating: false,
  setPiUpdating: (piUpdating) => set({ piUpdating }),
  runPiUpdate: async () => {
    // The main process remains the cross-window authority; this guard avoids
    // duplicate work from the two renderer presentations in this window.
    if (useUiStore.getState().piUpdating) return;
    set({ piUpdating: true });
    try {
      const target = useUiStore.getState().updateInfo;
      const result = target?.targetTabId
        ? await window.api.update.runTarget(target.targetTabId)
        : await window.api.update.run();
      if (!result.ok) {
        set({
          updateInfo: null,
          updateResult: { ok: false, error: result.error ?? result.output.slice(0, 120) },
        });
        useUiStore.getState().showToast("更新失败", "err");
        return;
      }

      // Do not claim the version offered before update: npm may resolve a
      // different release. Force a fresh check after main invalidates its cache.
      try {
        const verified = target?.targetTabId
          ? await window.api.update.checkTarget(target.targetTabId)
          : await window.api.update.check(true);
        set({
          updateInfo: null,
          updateResult: { ok: true, version: verified.current ?? undefined },
        });
      } catch {
        // The update itself succeeded; verification is best-effort and must
        // not rewrite that outcome as a failure because IPC/network died.
        set({ updateInfo: null, updateResult: { ok: true } });
      }
      useUiStore.getState().showToast("更新完成，请重启标签页生效", "ok");
    } catch (error) {
      set({
        updateInfo: null,
        updateResult: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
      useUiStore.getState().showToast("更新失败", "err");
    } finally {
      set({ piUpdating: false });
    }
  },
  extNotice: null,
  setExtNotice: (extNotice) => set({ extNotice }),
  modelConfigSavedAt: 0,
  modelConfigTarget: { kind: "local" },
  markModelConfigSaved: (target) => set((s) => ({ modelConfigSavedAt: s.modelConfigSavedAt + 1, modelConfigTarget: target })),
  appDialog: null,
  openAppDialog: (appDialog) => set({ appDialog }),
  closeAppDialog: () => set({ appDialog: null }),
}));
