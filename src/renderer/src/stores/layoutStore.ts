// Cross-pane geometry: the middle/right pane widths and the viewer collapse
// flag are written by both sides of each resizer, so they live in a store
// (CONTEXT.md rule: cross-pane data must be in a store, not App useState).
// The sidebar's own vertical split (sidebarSplit) stays local to SidebarPane.
import { create } from "zustand";

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  viewerCollapsed: boolean;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  toggleViewer: () => void;
}

export const useLayoutStore = create<LayoutState>()((set) => ({
  leftWidth: 260,
  rightWidth: 420,
  viewerCollapsed: false,
  setLeftWidth: (leftWidth) => set({ leftWidth }),
  setRightWidth: (rightWidth) => set({ rightWidth }),
  toggleViewer: () => set((s) => ({ viewerCollapsed: !s.viewerCollapsed })),
}));
