/**
 * Pure math for the sidebar's vertical split — the divider between
 * 项目 / 会话 (top pane) and 当前项目文件 (bottom pane) — plus the persisted
 * read for that split.
 *
 * Why this lives in a module instead of inline in the drag handler: the
 * pointer→split mapping is the one part of the gesture that fails silently.
 * The failure mode is geometric (the handle drifts away from the cursor, and
 * the cursor ends up over the session list), so nothing throws, nothing logs,
 * and a component test in jsdom could not see it either. Pure functions can be
 * asserted in node (`__tests__/sidebar-split.test.ts`); the browser-only half
 * (text selection / autoscroll) is covered by
 * `scripts/diagnose-sidebar-resizer.mjs`.
 */

export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
export const SPLIT_DEFAULT = 55;

export function clampSplit(pct: number): number {
  if (!Number.isFinite(pct)) return SPLIT_DEFAULT;
  return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, pct));
}

/**
 * `Number(null)` is 0, which is finite — so a missing key used to "parse" to 0
 * and then clamp to the floor. A fresh profile therefore opened at 20% (top
 * pane ~118px) instead of the intended 55%, which is also how a divider drag
 * first lands the cursor inside a session row.
 */
export function readSavedSplit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") return SPLIT_DEFAULT;
  return clampSplit(Number(raw));
}

/**
 * The geometry of one drag, captured once on mousedown.
 *
 * The frame must be captured at press time, not recomputed per move: the
 * panes' heights are what the split is changing, so re-measuring them mid-drag
 * would feed the drag its own output back as the coordinate system.
 *
 * `span` is the two panes (resizer excluded) — that is exactly the space the
 * split divides. Measuring against the whole sidebar instead is what made the
 * handle run away from the cursor by `header * (1 - split/100)` px.
 */
export interface SplitFrame {
  /** Viewport y of the top of the draggable region (the top pane's top edge). */
  top: number;
  /** Height of the draggable region: the two panes, resizer excluded. */
  span: number;
  /** Pointer y minus the handle's top edge at press time — keeps the grab point stable. */
  grabOffset: number;
}

export function frameFor(topPane: DOMRect, bottomPane: DOMRect, pointerY: number): SplitFrame {
  return {
    top: topPane.top,
    span: topPane.height + bottomPane.height,
    // The resizer is the immediate next sibling of the top pane, so the handle's
    // top edge is the top pane's bottom edge.
    grabOffset: pointerY - topPane.bottom,
  };
}

/** Split % whose divider lands on the pointer — the inverse of the layout. */
export function splitFromPointer(frame: SplitFrame, pointerY: number): number {
  if (!(frame.span > 0)) return SPLIT_DEFAULT;
  const handleTop = pointerY - frame.grabOffset;
  return clampSplit(((handleTop - frame.top) / frame.span) * 100);
}
