import { describe, expect, it, vi } from "vitest";
import { BackdropGesture, createOverlayHandlers } from "../overlay-dismiss";

/**
 * The reported bug (2026-09-28, 「我在编辑模型配置的时候，窗口容易闪退」): with
 * `onClick={onClose}` on `.dialog-overlay`, starting a text selection inside the
 * dialog and releasing outside it dispatched `click` on the OVERLAY (a click's
 * target is the common ancestor of the press and the release) and closed the
 * dialog mid-edit. These cases fix the rule: the gesture must start AND end on
 * the backdrop. DOM-free on purpose — the renderer tests run in the node
 * environment (no jsdom), so the state machine is what gets tested.
 */
describe("BackdropGesture (dismiss only on a press AND release on the backdrop)", () => {
  const backdrop = { id: "overlay" };
  const dialog = { id: "dialog" };
  const field = { id: "input" };

  it("fires when the press and the release are both on the backdrop", () => {
    const g = new BackdropGesture();
    g.press(backdrop, backdrop);
    expect(g.isArmed).toBe(true);
    expect(g.release(backdrop, backdrop)).toBe(true);
    // One gesture, one dismissal: the release consumed the arm.
    expect(g.isArmed).toBe(false);
    expect(g.release(backdrop, backdrop)).toBe(false);
  });

  it("does NOT fire when the press was inside the dialog (drag-out) — the bug", () => {
    const g = new BackdropGesture();
    // press inside a field, drag out, release over the backdrop: the browser
    // dispatches `click` on the overlay, which is exactly what closed the dialog.
    g.press(field, backdrop);
    expect(g.isArmed).toBe(false);
    expect(g.release(backdrop, backdrop)).toBe(false);
  });

  it("does not fire when the release is inside the dialog", () => {
    const g = new BackdropGesture();
    g.press(backdrop, backdrop);
    expect(g.release(dialog, backdrop)).toBe(false);
    // and the gesture is over, so a later stray release cannot dismiss either
    expect(g.release(backdrop, backdrop)).toBe(false);
  });

  it("never fires from a release alone (a native <select> synthesizes a click)", () => {
    const g = new BackdropGesture();
    expect(g.release(backdrop, backdrop)).toBe(false);
  });

  it("re-arms after an aborted gesture", () => {
    const g = new BackdropGesture();
    g.press(field, backdrop);
    g.press(backdrop, backdrop);
    expect(g.release(backdrop, backdrop)).toBe(true);
  });

  it("treats a null/undefined target as not-the-backdrop", () => {
    const g = new BackdropGesture();
    g.press(null, backdrop);
    expect(g.isArmed).toBe(false);
    g.press(undefined, backdrop);
    expect(g.isArmed).toBe(false);
    expect(g.release(null, backdrop)).toBe(false);
  });

  it("is per-overlay state (two dialogs do not share an arm)", () => {
    const a = new BackdropGesture();
    const b = new BackdropGesture();
    a.press(backdrop, backdrop);
    expect(b.release(backdrop, backdrop)).toBe(false);
    expect(a.release(backdrop, backdrop)).toBe(true);
  });

  // The right/middle button used to be ignored for free: `click` is not fired for
  // them (the browser sends `auxclick`), but a mousedown/mouseup pair is, so the
  // guard has to be explicit or right-clicking the backdrop would close dialogs.
  it("ignores a non-primary press", () => {
    const g = new BackdropGesture();
    g.press(backdrop, backdrop, 2); // right button
    expect(g.isArmed).toBe(false);
    expect(g.release(backdrop, backdrop, 2)).toBe(false);
    g.press(backdrop, backdrop, 1); // middle button
    expect(g.release(backdrop, backdrop, 1)).toBe(false);
  });

  it("ignores a non-primary release of a primary press", () => {
    const g = new BackdropGesture();
    g.press(backdrop, backdrop);
    expect(g.release(backdrop, backdrop, 2)).toBe(false);
    // …and it consumed the arm rather than leaving it for the next release
    expect(g.release(backdrop, backdrop)).toBe(false);
  });

  it("treats a button-less event (a synthesized MouseEvent) as primary", () => {
    const g = new BackdropGesture();
    g.press(backdrop, backdrop, undefined);
    expect(g.release(backdrop, backdrop, undefined)).toBe(true);
  });

  it("drops an unfinished gesture when the pointer leaves the window", () => {
    const g = new BackdropGesture();
    g.press(backdrop, backdrop);
    g.reset();
    expect(g.isArmed).toBe(false);
    expect(g.release(backdrop, backdrop)).toBe(false);
  });

  it("does not fire when a reset lands between the press and the release", () => {
    // The literal interaction with the new onMouseLeave handler.
    const g = new BackdropGesture();
    g.press(backdrop, backdrop);
    g.reset(); // pointer left the overlay (or the window)
    g.press(backdrop, backdrop); // …and came back to press again
    expect(g.isArmed).toBe(true);
    g.reset();
    expect(g.release(backdrop, backdrop)).toBe(false);
  });
});

/**
 * The hook body is `createOverlayHandlers`, so its wiring is testable without a
 * DOM — the 11 call sites spread the returned object, and a swap or a typo there
 * would otherwise be invisible to every test.
 */
describe("createOverlayHandlers (the glue the 11 overlays spread)", () => {
  const backdrop = { id: "overlay" };
  const field = { id: "input" };
  const event = (target: unknown) => ({ target, currentTarget: backdrop });

  it("exposes exactly the three handlers an overlay needs", () => {
    expect(Object.keys(createOverlayHandlers(new BackdropGesture(), () => () => {})).sort()).toEqual([
      "onMouseDown",
      "onMouseLeave",
      "onMouseUp",
    ]);
  });

  it("dismisses once on a press+release on the backdrop", () => {
    const dismiss = vi.fn();
    const h = createOverlayHandlers(new BackdropGesture(), () => dismiss);
    h.onMouseDown(event(backdrop));
    h.onMouseUp(event(backdrop));
    expect(dismiss).toHaveBeenCalledTimes(1);
    // and not on the release that follows the spent gesture
    h.onMouseUp(event(backdrop));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("never dismisses when the press was inside the dialog", () => {
    const dismiss = vi.fn();
    const h = createOverlayHandlers(new BackdropGesture(), () => dismiss);
    h.onMouseDown(event(field));
    h.onMouseUp(event(backdrop));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("drops the gesture when the pointer leaves the window (onMouseLeave → reset)", () => {
    const dismiss = vi.fn();
    const h = createOverlayHandlers(new BackdropGesture(), () => dismiss);
    h.onMouseDown(event(backdrop));
    h.onMouseLeave(event(backdrop)); // pointer left the overlay/window
    h.onMouseUp(event(backdrop)); // …and the release arrives back on the backdrop
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("still dismisses after leaving and re-pressing the backdrop", () => {
    const dismiss = vi.fn();
    const h = createOverlayHandlers(new BackdropGesture(), () => dismiss);
    h.onMouseDown(event(backdrop));
    h.onMouseLeave(event(backdrop));
    h.onMouseDown(event(backdrop));
    h.onMouseUp(event(backdrop));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("hands over the CURRENT callback (it is read at event time, not at wiring)", () => {
    let current = vi.fn();
    const h = createOverlayHandlers(new BackdropGesture(), () => current);
    const first = current;
    current = vi.fn();
    h.onMouseDown(event(backdrop));
    h.onMouseUp(event(backdrop));
    expect(first).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });
});
