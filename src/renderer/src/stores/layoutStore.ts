// Cross-pane geometry: the middle/right pane widths and the viewer collapse
// flag are written by both sides of each resizer, so they live in a store
// (CONTEXT.md rule: cross-pane data must be in a store, not App useState).
// The sidebar's own vertical split (sidebarSplit) stays local to SidebarPane.
import { create } from "zustand";

const LAYOUT_STORAGE_KEY = "pipi-layout";
// Narrower sidebar: 232 default / 190 floor (was 260/220). Saved layouts are
// honored as-is; this only changes the default and the drag floor.
const DEFAULT_LAYOUT = { leftWidth: 232, rightWidth: 420, viewerCollapsed: false };

type PersistedLayout = Partial<typeof DEFAULT_LAYOUT>;

function readLayout(): typeof DEFAULT_LAYOUT {
  if (typeof localStorage === "undefined") return { ...DEFAULT_LAYOUT };
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null") as PersistedLayout | null;
    return {
      leftWidth: typeof value?.leftWidth === "number" ? Math.max(190, Math.min(520, value.leftWidth)) : DEFAULT_LAYOUT.leftWidth,
      rightWidth: typeof value?.rightWidth === "number" ? Math.max(320, Math.min(900, value.rightWidth)) : DEFAULT_LAYOUT.rightWidth,
      viewerCollapsed: value?.viewerCollapsed === true,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveLayout(layout: PersistedLayout) {
  if (typeof localStorage === "undefined") return;
  // Resizers can emit dozens of updates per second; defer the synchronous
  // storage write so dragging remains on the render path only.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Storage can be unavailable in private/sandboxed renderers. Layout still works in memory.
    }
  }, 160);
}

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  viewerCollapsed: boolean;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setViewerCollapsed: (v: boolean) => void;
  toggleViewer: () => void;
}

const initial = readLayout();

export const useLayoutStore = create<LayoutState>()((set) => ({
  ...initial,
  setLeftWidth: (leftWidth) => set((state) => {
    const next = { leftWidth: Math.max(190, Math.min(520, leftWidth)) };
    saveLayout({ ...state, ...next });
    return next;
  }),
  setRightWidth: (rightWidth) => set((state) => {
    const next = { rightWidth: Math.max(320, Math.min(900, rightWidth)) };
    saveLayout({ ...state, ...next });
    return next;
  }),
  setViewerCollapsed: (viewerCollapsed) => set((state) => {
    const next = { viewerCollapsed };
    saveLayout({ ...state, ...next });
    return next;
  }),
  toggleViewer: () => set((state) => {
    const next = { viewerCollapsed: !state.viewerCollapsed };
    saveLayout({ ...state, ...next });
    return next;
  }),
}));
