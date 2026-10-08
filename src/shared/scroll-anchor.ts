/**
 * scroll-anchor — where the viewport has to be after older rows are prepended above it.
 *
 * The branch dialog opens on the newest page of a session and prepends older pages on
 * demand (docs/adr/0011-session-entry-paging.md). Prepending must not move what the reader
 * is looking at, and the offset cannot be derived from the row COUNT: in a linear session
 * the older rows land above the loaded ones, but in a star-shaped one they land BELOW the
 * root row (measured: scripts/diagnose-tree-crash.mjs --shape=bush), and a search filter can
 * hide some of them entirely.
 *
 * So the anchor is the row at the viewport's top edge, captured as `{id, index, scrollTop}`
 * and restored by its NEW index. Uniform row height is what this list renders (ROW_H), which
 * makes the identity exact: the row keeps the same pixel offset from the viewport top, so
 * the container's border/padding cancel out of the subtraction instead of having to be known.
 */
export interface ScrollAnchor {
  /** Entry id of the row that was at the viewport's top edge. */
  id: string;
  /** That row's index in the visible list when the anchor was taken. */
  index: number;
  /** The scroll container's offset at that moment. */
  scrollTop: number;
}

/**
 * The scroll offset that puts `anchor`'s row back where it was, now that the row sits at
 * `newIndex`. Returns the old offset when the row did not move — the caller still assigns
 * it, since the browser clamps and rounds `scrollTop` itself.
 */
export function restoreScrollTop(anchor: ScrollAnchor, newIndex: number, rowHeight: number): number {
  return anchor.scrollTop + (newIndex - anchor.index) * rowHeight;
}
