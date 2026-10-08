// The sidebar vertical divider (项目/会话 | 当前项目文件). The bug these tests
// pin down: the split was computed against the WHOLE sidebar while the panes
// only divide the sidebar minus the header — so the handle ran ahead of the
// cursor by `header * (1 - split/100)` px and the cursor ended up over the
// session list, where the pending mousedown selection dragged across rows and
// started an autoscroll ("拖动分界线，会话列表向上滚动 + 选中文字").
import { describe, expect, it } from "vitest";
import { clampSplit, frameFor, readSavedSplit, splitFromPointer, SPLIT_DEFAULT } from "../sidebar-split";

/** Minimal DOMRect stand-in: only top/height/bottom are read. */
const rect = (top: number, height: number) => ({ top, height, bottom: top + height }) as DOMRect;

describe("clampSplit", () => {
  it("keeps the split inside the draggable band", () => {
    expect(clampSplit(5)).toBe(20);
    expect(clampSplit(95)).toBe(80);
    expect(clampSplit(55)).toBe(55);
  });

  it("falls back to the default for a non-number", () => {
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(SPLIT_DEFAULT);
  });
});

describe("readSavedSplit", () => {
  it("returns the default for a key that was never written", () => {
    // The regression: Number(null) === 0 is finite, so a fresh profile opened
    // at the 20% floor instead of 55%.
    expect(readSavedSplit(null)).toBe(SPLIT_DEFAULT);
    expect(readSavedSplit(undefined)).toBe(SPLIT_DEFAULT);
    expect(readSavedSplit("")).toBe(SPLIT_DEFAULT);
    expect(readSavedSplit("   ")).toBe(SPLIT_DEFAULT);
  });

  it("returns the default for a corrupted value", () => {
    expect(readSavedSplit("abc")).toBe(SPLIT_DEFAULT);
  });

  it("clamps a real value instead of discarding it", () => {
    expect(readSavedSplit("0")).toBe(20);
    expect(readSavedSplit("42")).toBe(42);
    expect(readSavedSplit("120")).toBe(80);
  });
});

describe("splitFromPointer", () => {
  // Measured in the app: sidebar 820 tall, 40px header, 5px resizer → the panes
  // divide 775px.
  const head = 40;
  const span = 775;
  const frame = frameFor(rect(head, 0.55 * span), rect(head + 0.55 * span, 0.45 * span), head + 0.55 * span + 2.5);

  it("captures the panes, not the whole sidebar, as the draggable region", () => {
    expect(frame.top).toBe(head);
    expect(frame.span).toBe(span);
    expect(frame.grabOffset).toBe(2.5);
  });

  it("leaves the handle under the cursor for the whole drag", () => {
    for (const pointerY of [200, 300, 408, 520, 620]) {
      const pct = splitFromPointer(frame, pointerY);
      const handleTop = frame.top + (pct / 100) * frame.span; // where the divider lands
      expect(handleTop).toBeCloseTo(pointerY - frame.grabOffset, 5);
    }
  });

  it("shows the old whole-sidebar formula drifting by the header (the measured bug)", () => {
    const sidebarRect = rect(0, head + span + 5);
    const pointerY = 408;
    // What the code did before: split against the full sidebar height.
    const oldPct = clampSplit(((pointerY - sidebarRect.top) / sidebarRect.height) * 100);
    const oldHandleTop = head + (oldPct / 100) * span;
    // 17.6px — the divider stayed 17.6px above the cursor, inside the session list.
    expect(oldHandleTop - pointerY).toBeGreaterThan(15);
    const newHandleTop = head + (splitFromPointer(frame, pointerY) / 100) * span;
    expect(Math.abs(newHandleTop - pointerY)).toBeLessThan(3);
  });

  it("saturates at the band instead of inverting", () => {
    expect(splitFromPointer(frame, -10_000)).toBe(20);
    expect(splitFromPointer(frame, 10_000)).toBe(80);
  });

  it("falls back to the default for a degenerate frame", () => {
    expect(splitFromPointer(frameFor(rect(0, 0), rect(0, 0), 0), 100)).toBe(SPLIT_DEFAULT);
  });
});
