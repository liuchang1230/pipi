/**
 * "Open a session at the newest message."
 *
 * A transcript snapshot REPLACES the whole list (first open, switching back from
 * the terminal view, fork / branch navigation, `/new`). With it the reader lands
 * at `scrollTop = 0` — the OLDEST row of a TAIL-anchored window — and has to
 * scroll down to find the head of the conversation (「每次打开会话都要自己往下滚」).
 *
 * The live follow in `ChatTimeline` cannot cover this: it only nudges a viewport
 * that is ALREADY near the bottom (`distanceFromBottom > 60 → bail`), which is
 * the opposite situation. So a landed snapshot OWES one jump.
 *
 * Two rules keep the owed jump from turning into a yank:
 *  - it is spent only when there was nothing mounted to look at, or the reader
 *    was already at the bottom. A snapshot landing under a reader who is scrolled
 *    up (reachable only through an explicit re-request: retry, fork, navigation)
 *    CLEARS the debt instead of stealing their position;
 *  - a pane that cannot measure itself yet (`clientHeight` 0 — no layout) keeps
 *    owing, so the jump happens on a later pass instead of silently doing
 *    nothing (`scrollTop = scrollHeight` on an unlaid-out box is a no-op).
 *
 * Kept pure and unit-tested (`__tests__/chat-scroll.test.ts`) because chat
 * scrolling has already produced two shipped failures (see the windowing note in
 * ChatPane) and this decision has four inputs that are easy to combine wrongly.
 */
export interface JumpState {
  /** A snapshot has landed (or a load is in flight) and the viewport has not been moved to it. */
  owing: boolean;
}

/** A fresh view starts owing: a brand-new scroll container has no position to keep. */
export const INITIAL_JUMP_STATE: JumpState = { owing: true };

export interface JumpInput {
  /** A transcript snapshot has been applied at least once (chatStore `historyLoaded`). */
  historyLoaded: boolean;
  /** The scroll container's height. 0 = not laid out yet (or not visible). */
  clientHeight: number;
  /** Messages were already mounted as of the previous pass — there IS a position to keep. */
  hadContent: boolean;
  /** The reader is at the bottom (the same stickiness the live follow records). */
  atBottom: boolean;
}

export function nextJumpToNewest(
  state: JumpState,
  input: JumpInput,
): { state: JumpState; jump: boolean } {
  // A load is in flight: whatever lands owes the jump. Every path (mount, retry,
  // fork, navigation) marks history loading before it asks, so this is also what
  // re-arms the debt for a refresh of an already-loaded transcript.
  if (!input.historyLoaded) return { state: { owing: true }, jump: false };
  if (!state.owing) return { state, jump: false };
  if (input.clientHeight <= 0) return { state, jump: false };
  // Debt settled either way: jumping to the newest, or deliberately leaving a
  // reader who is scrolled up where they are.
  return { state: { owing: false }, jump: !(input.hadContent && !input.atBottom) };
}
