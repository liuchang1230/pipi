/**
 * scroll-anchor — the geometry of "older rows arrived above the viewport" (ADR 0011).
 *
 * The property under test is the one the browser makes hard to see: the anchored row keeps
 * the same pixel offset from the viewport's top edge. The bug this pins down is the
 * plausible-looking `index * ROW_H - offset` form, which ignores where the container was
 * already scrolled to (and the container's own border/padding).
 */
import { describe, expect, it } from "vitest";
import { restoreScrollTop, type ScrollAnchor } from "../scroll-anchor";

const ROW_H = 24;
/** Where a row sits relative to the viewport's top edge — the thing that must not change. */
const offsetInViewport = (index: number, scrollTop: number) => index * ROW_H - scrollTop;

describe("restoreScrollTop", () => {
  it("keeps the anchored row at the same offset when it moves down by prepended rows", () => {
    const anchor: ScrollAnchor = { id: "e100", index: 5, scrollTop: 120 };
    expect(offsetInViewport(8, restoreScrollTop(anchor, 8, ROW_H))).toBe(offsetInViewport(5, 120));
  });

  it("leaves the offset alone when the row did not move (star-shaped tree, older rows below)", () => {
    const anchor: ScrollAnchor = { id: "root", index: 0, scrollTop: 0 };
    expect(restoreScrollTop(anchor, 0, ROW_H)).toBe(0);
    const scrolled: ScrollAnchor = { id: "root", index: 0, scrollTop: 480 };
    expect(restoreScrollTop(scrolled, 0, ROW_H)).toBe(480);
  });

  it("moves up when the anchored row ends up earlier in the list", () => {
    const anchor: ScrollAnchor = { id: "e5", index: 10, scrollTop: 240 };
    expect(restoreScrollTop(anchor, 6, ROW_H)).toBe(240 - 4 * ROW_H);
  });

  it("does not depend on the container's border or padding (they cancel)", () => {
    // 1px border + 4px padding-top in styles.css: the row's viewport top includes both, and
    // so does the captured offset — the difference is unchanged.
    const withBox = (index: number, scrollTop: number) => 5 + index * ROW_H - scrollTop;
    const anchor: ScrollAnchor = { id: "e100", index: 3, scrollTop: 77 };
    expect(withBox(9, restoreScrollTop(anchor, 9, ROW_H))).toBe(withBox(3, 77));
  });
});
