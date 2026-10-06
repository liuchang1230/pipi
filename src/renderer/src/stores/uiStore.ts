// App-wide transient toast + update/extensions notices. Any store action can
// report an error via getState().showToast without a callback being threaded
// through containers; the ToastHost in App renders it. Auto-dismisses after
// 3s (timer is shared so rapid consecutive toasts replace each other cleanly).
//
// updateInfo / extNotice are read by BOTH the global UpdateBanner (terminal
// views, no chat page) and the in-chat notice bar (ChatPane), so a dismiss in
// either place is global.
import { create } from "zustand";
import { useFailureStore } from "./failureStore";
import type { AppErrorTarget } from "../../../shared/outcome";
import type { PiDrift } from "../../../shared/pi-drift";

export type ToastType = "ok" | "err";

export interface UpdateNoticeInfo {
  /** 目标机上那个 pi 的漂移（ADR 0008）：横幅读它说话，不再自己拼
   *  「版本不一致」的判定。只有目标机（SSH/WSL）会有这项 —— 本机的升级提示
   *  在 ADR 0009 删掉了，本机 pi 坏掉由 `PiPresence` 那条路说。 */
  drift: PiDrift;
  /** 目标机标签（`label` 形如 `user@host` 或 WSL 发行版名）。 */
  targetLabel?: string;
  /** Authoritative tab id used to align the pi on that exact target. */
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

/** Outcome of aligning a target machine's pi to the app's bundled pin,
 *  surfaced as a success/failure notice in both the chat notice bar and the
 *  global banner — so after "对齐版本" the user sees 对齐中… then 已对齐（到哪
 *  个版本）or 对齐失败. */
export interface PiUpdateResult {
  ok: boolean;
  /** Version it updated to (ok only). */
  version?: string;
  /** Failure detail (ok=false). */
  error?: string;
}

interface UiState {
  toast: { text: string; type: ToastType } | null;
  /**
   * Transient feedback. Pass `failure: true` when this is a real failure rather
   * than a hint ("请把 <会话名> 替换成实际名称"): it is ALSO recorded in the failure
   * center, which persists, carries advice, and can offer a retry. A 3s toast
   * must never be the only trace that something failed.
   */
  showToast: (text: string, type: ToastType, opts?: { failure?: boolean; cause?: string; target?: AppErrorTarget; retry?: () => void }) => void;
  clearToast: () => void;
  /** A newer pipi desktop installer is published on GitHub Releases. */
  appUpdateInfo: AppUpdateNoticeInfo | null;
  setAppUpdateInfo: (info: AppUpdateNoticeInfo | null) => void;
  /** pi (and its extension packages) has a newer version available. */
  updateInfo: UpdateNoticeInfo | null;
  setUpdateInfo: (info: UpdateNoticeInfo | null) => void;
  /** Result of the last target align attempt (shown instead of the offer once set). */
  updateResult: PiUpdateResult | null;
  setUpdateResult: (r: PiUpdateResult | null) => void;
  /** An align is in flight (shared by chat notice bar + global banner so both
   *  consistently show "对齐中…" and a second click is prevented). */
  piAligning: boolean;
  /** Aligns the active target's pi to the bundled pin once for every renderer
   *  presentation. Local pi is not aligned by us (ADR 0009) — without a target
   *  tab there is nothing to do. */
  runPiAlign: () => Promise<void>;
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
  /**
   * Main-process event-loop lag crossed the busy threshold. This is the honest
   * answer to "为什么这么卡": the app IS busy, here is the delay and the
   * operation it is waiting on (see src/main/perf.ts + in-flight.ts). Null = fine.
   */
  busy: { p95Ms: number; maxMs: number; ops: string } | null;
  setBusy: (busy: UiState["busy"]) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useUiStore = create<UiState>()((set) => ({
  toast: null,
  showToast: (text, type, opts) => {
    if (opts?.failure) {
      useFailureStore.getState().report({ title: text, cause: opts.cause, target: opts.target, retry: opts.retry });
    }
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
  piAligning: false,
  runPiAlign: async () => {
    // The main process remains the cross-window authority; this guard avoids
    // duplicate work from the two renderer presentations in this window.
    if (useUiStore.getState().piAligning) return;
    const target = useUiStore.getState().updateInfo;
    // 对齐只对目标机有意义：本机那个 pi 由 app 安装/修复（ADR 0009），没有
    // 「对齐」这个动作。没有目标标签就没什么可做 —— 按钮也只在这种情况下出现。
    if (!target?.targetTabId) return;
    set({ piAligning: true });
    try {
      const result = await window.api.update.runTarget(target.targetTabId);
      if (!result.ok) {
        set({
          updateInfo: null,
          updateResult: { ok: false, error: result.error ?? result.output.slice(0, 120) },
        });
        useUiStore.getState().showToast("对齐失败", "err");
        return;
      }

      // Do not claim the version offered before the align: npm may resolve a
      // different release. Force a fresh check after main invalidates its cache.
      try {
        const verified = await window.api.update.checkTarget(target.targetTabId);
        set({
          updateInfo: null,
          updateResult: { ok: true, version: verified.current ?? undefined },
        });
      } catch {
        // The align itself succeeded; verification is best-effort and must
        // not rewrite that outcome as a failure because IPC/network died.
        set({ updateInfo: null, updateResult: { ok: true } });
      }
      useUiStore.getState().showToast("已对齐，请重启标签页生效", "ok");
    } catch (error) {
      set({
        updateInfo: null,
        updateResult: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
      useUiStore.getState().showToast("对齐失败", "err");
    } finally {
      set({ piAligning: false });
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
  busy: null,
  setBusy: (busy) => set({ busy }),
}));
