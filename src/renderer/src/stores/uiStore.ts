// App-wide transient toast. Any store action can report an error via
// getState().showToast without a callback being threaded through containers;
// the ToastHost in App renders it. Auto-dismisses after 3s (timer is shared
// so rapid consecutive toasts replace each other cleanly).
import { create } from "zustand";

export type ToastType = "ok" | "err";

interface UiState {
  toast: { text: string; type: ToastType } | null;
  showToast: (text: string, type: ToastType) => void;
  clearToast: () => void;
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
}));
