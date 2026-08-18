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
  /** App-bundled pi extensions were re-shipped at startup with new content. */
  extNotice: ExtensionNoticeInfo | null;
  setExtNotice: (info: ExtensionNoticeInfo | null) => void;
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
  extNotice: null,
  setExtNotice: (extNotice) => set({ extNotice }),
  appDialog: null,
  openAppDialog: (appDialog) => set({ appDialog }),
  closeAppDialog: () => set({ appDialog: null }),
}));
