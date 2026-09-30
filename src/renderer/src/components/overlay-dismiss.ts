import { useMemo, useRef } from "react";
import type * as React from "react";

/**
 * Dismissing a dialog by clicking its backdrop — without swallowing real drags.
 *
 * `onClick={onClose}` on `.dialog-overlay` LOOKS right and is wrong: a click's
 * target is the nearest common ancestor of the mousedown and the mouseup, so
 *   press inside the dialog (start selecting text in a field) → release past the
 * dialog's edge → the browser dispatches `click` on the OVERLAY (the ancestor of
 * both) → the dialog closes mid-edit.
 * That is the reported bug: 「我在编辑模型配置的时候，窗口容易闪退」 (the app stayed
 * alive; only the 模型配置 dialog vanished — see 2026-09-28). A 560px dialog in a
 * wide window leaves plenty of backdrop to release over, so it hits often.
 *
 * The rule here: dismiss only when the gesture STARTED on the backdrop AND ENDED
 * on the backdrop, with the PRIMARY button. Both edges are on the overlay itself,
 * so a drag that began inside the dialog can never dismiss it, no matter where it
 * is released.
 *
 * Two details that a bare `onClick` got for free and this must not lose:
 *  - only the primary button counts (`click` never fires for the right/middle
 *    button — the browser sends `auxclick` — so right-clicking the backdrop used
 *    to do nothing, and must keep doing nothing);
 *  - a gesture that never ends on the backdrop leaves no state behind, so a later
 *    release cannot fire it. `reset()` covers leaving the window; a press that is
 *    interrupted by Alt-Tab while the pointer stays inside the window keeps its
 *    arm (exactly as the old `onClick` did), which is why release is still gated
 *    on both edges.
 */

/** The subset of a DOM mouse event this needs (no React runtime types needed). */
export interface MouseEventLike {
  target: unknown;
  currentTarget: unknown;
  /** 0 = primary. Absent (a synthesized event) counts as primary. */
  button?: number;
}

/**
 * The two-edge gesture, as a pure state machine (unit-tested without a DOM):
 * arm on a primary press whose target IS the backdrop, fire on a primary release
 * whose target is still the backdrop, and disarm on anything else.
 */
export class BackdropGesture {
  private armed = false;

  /** A press landed. Armed only if it landed on the backdrop itself. */
  press(target: unknown, currentTarget: unknown, button?: number): void {
    this.armed = (button ?? 0) === 0 && target !== null && target !== undefined && target === currentTarget;
  }

  /** A release landed. Returns true exactly once per armed gesture. */
  release(target: unknown, currentTarget: unknown, button?: number): boolean {
    const fire = this.armed && (button ?? 0) === 0 && target !== null && target !== undefined && target === currentTarget;
    this.armed = false;
    return fire;
  }

  /** Forget an unfinished gesture (the pointer left the window). */
  reset(): void {
    this.armed = false;
  }

  get isArmed(): boolean {
    return this.armed;
  }
}

/** The three handlers an overlay spreads — React's own property NAMES (a typo
 *  like `onMouseleave` must be a compile error: JSX spreads are not excess-checked)
 *  carrying our DOM-free event shape. */
export type OverlayDismissHandlers = Record<
  keyof Pick<React.HTMLAttributes<HTMLDivElement>, "onMouseDown" | "onMouseUp" | "onMouseLeave">,
  (e: MouseEventLike) => void
>;

/**
 * Wire a `BackdropGesture` to the three handlers — the whole hook body, kept
 * separate from React so the wiring itself is unit-testable (a swapped press /
 * release, or a misspelled handler key, must not be able to pass the suite).
 */
export function createOverlayHandlers(
  gesture: BackdropGesture,
  getDismiss: () => () => void,
): OverlayDismissHandlers {
  return {
    onMouseDown: (e: MouseEventLike) => gesture.press(e.target, e.currentTarget, e.button),
    onMouseUp: (e: MouseEventLike) => {
      if (gesture.release(e.target, e.currentTarget, e.button)) getDismiss()();
    },
    // `mouseleave` fires only when the pointer leaves the overlay AND its children,
    // so moving between the backdrop and the dialog keeps the gesture alive; leaving
    // the window entirely drops it (otherwise the arm would survive until the next
    // press, and a release that arrives from outside could close the dialog).
    onMouseLeave: () => gesture.reset(),
  };
}

/**
 * Wire an overlay to `BackdropGesture`.
 *
 * ```tsx
 * const dismiss = useOverlayDismiss(onClose);
 * return <div className="dialog-overlay" {...dismiss}><div className="dialog">…</div></div>;
 * ```
 *
 * Spread it on the overlay. Nothing is needed on the inner panel: it never equals
 * `currentTarget`, so presses inside the dialog cannot arm.
 */
export function useOverlayDismiss(onDismiss: () => void): OverlayDismissHandlers {
  // A ref, not state: arming must not re-render the dialog (a re-render between
  // press and release would also replace the handlers mid-gesture).
  const gesture = useRef<BackdropGesture | null>(null);
  if (gesture.current === null) gesture.current = new BackdropGesture();
  // Latest callback without re-creating the handlers: callers pass inline arrows.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  return useMemo(() => createOverlayHandlers(gesture.current!, () => dismissRef.current), []);
}
