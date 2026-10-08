// extensionUiStore: the renderer's MIRROR of the extension UI surface.
//
// It owns no authority. The authoritative state is main/extension-ui.ts, because
// the renderer layer that receives pi's frames (ChatView) unmounts whenever the
// tab shows the terminal view — and those frames are one-shot: pi never re-sends
// them and `get_state` does not carry them. So this store attaches to a tab's
// state channel ONCE per open tab and pulls a snapshot; the tab list owns that
// lifetime (TerminalPane), never a view's mount.
//
// Consumers: the chat header (title), the zone above/below the composer
// (status + widgets). See extension-ui-view.ts for what is drawn.
import { create } from "zustand";
import { emptySurface, type ExtensionUiSurface } from "../../../shared/extension-ui";

export interface SurfaceState {
  /** Bumped by main on every change; a snapshot older than what we hold is dropped. */
  seq: number;
  surface: ExtensionUiSurface;
}

interface ExtensionUiStore {
  /** tabId → mirrored surface. Absent = nothing declared. */
  surfaces: Record<string, SurfaceState>;
  /** Mirror one state frame (push or snapshot), ignoring out-of-order ones. */
  applyState: (tabId: string, state: { seq: number; surface: ExtensionUiSurface }) => void;
  attach: (tabId: string) => void;
  detach: (tabId: string) => void;
  /** Attach every id in the list and detach the ones that disappeared. */
  syncAttached: (tabIds: string[]) => void;
}

/** Stable empty surface: a selector returning a fresh object every call would
 *  re-render forever (useSyncExternalStore compares with Object.is). */
const EMPTY: ExtensionUiSurface = emptySurface();

/** Live subscriptions, keyed by tab. Not reactive state: only the surfaces are. */
const unsubscribers = new Map<string, () => void>();
/** Tabs this store currently holds a subscription for. */
const attached = new Set<string>();
/** Attach generation per tab. A snapshot that resolves AFTER its own attach was
 *  superseded must not be applied: main forgets a closed tab's `seq` (it starts
 *  over at 0), so a stale snapshot carrying seq 5 would out-seat the new tab's
 *  seq 1 — and from then on the `seq` guard would drop every newer push, leaving
 *  a permanently stale status. Tab ids are not reused today; the epoch keeps
 *  that from mattering. */
const epochs = new Map<string, number>();

export const useExtensionUiStore = create<ExtensionUiStore>((set, get) => ({
  surfaces: {},

  applyState: (tabId, state) => {
    const prev = get().surfaces[tabId];
    if (prev && state.seq < prev.seq) return; // stale: a push already overtook this snapshot
    set({ surfaces: { ...get().surfaces, [tabId]: { seq: state.seq, surface: state.surface } } });
  },

  attach: (tabId) => {
    if (unsubscribers.has(tabId)) return;
    attached.add(tabId);
    const epoch = (epochs.get(tabId) ?? 0) + 1;
    epochs.set(tabId, epoch);
    const off = window.api.onRpcUiState(tabId, (state) => {
      get().applyState(tabId, state);
    });
    unsubscribers.set(tabId, off);
    // The frames this tab emitted before the effect ran (a tab's first
    // session_start declaration lands before the renderer even knows the tab
    // exists) are only reachable through this snapshot.
    void window.api
      .rpcUiSnapshot(tabId)
      .then((state) => {
        if (!attached.has(tabId) || epochs.get(tabId) !== epoch) return;
        get().applyState(tabId, state);
      })
      // A rejected invoke (channel gone, window torn down) must not be an
      // unhandled rejection, and it is also the ONLY recovery path for this
      // tab — say so instead of losing it silently.
      .catch((error: unknown) => {
        window.api.debug.log(
          `extension-ui snapshot failed for ${tabId}: ${error instanceof Error ? error.message : String(error)}`,
          "warn",
        );
      });
  },

  detach: (tabId) => {
    unsubscribers.get(tabId)?.();
    unsubscribers.delete(tabId);
    attached.delete(tabId);
    const surfaces = { ...get().surfaces };
    delete surfaces[tabId];
    set({ surfaces });
  },

  syncAttached: (tabIds) => {
    const wanted = new Set(tabIds);
    for (const id of [...unsubscribers.keys()]) if (!wanted.has(id)) get().detach(id);
    for (const id of tabIds) get().attach(id);
  },
}));

/** The surface for a tab (never null — a tab with nothing declared is empty). */
export function useExtensionUi(tabId: string): ExtensionUiSurface {
  return useExtensionUiStore((s) => s.surfaces[tabId]?.surface ?? EMPTY);
}
