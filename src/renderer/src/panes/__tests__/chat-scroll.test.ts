import { describe, expect, it } from "vitest";
import { INITIAL_JUMP_STATE, nextJumpToNewest, type JumpInput, type JumpState } from "../chat-scroll";

/** Walk a sequence of passes the way ChatTimeline's layout effect does. */
function run(passes: JumpInput[], state: JumpState = INITIAL_JUMP_STATE) {
  let cur = state;
  const jumps: boolean[] = [];
  for (const input of passes) {
    const next = nextJumpToNewest(cur, input);
    cur = next.state;
    jumps.push(next.jump);
  }
  return { state: cur, jumps };
}

const loaded = (over: Partial<JumpInput> = {}): JumpInput => ({
  historyLoaded: true,
  clientHeight: 600,
  hadContent: false,
  atBottom: true,
  ...over,
});

describe("opening a session lands on the newest message", () => {
  it("jumps once when the transcript is already on screen at mount, then never again", () => {
    // Remount (terminal view → chat view) with the store still holding the
    // transcript: the container is new, so there is nothing to keep.
    expect(run([loaded(), loaded()]).jumps).toEqual([true, false]);
  });

  it("waits for the snapshot when a load is still in flight", () => {
    // mount → markHistoryLoading → … → initMessages (the real open sequence).
    const { state, jumps } = run([
      loaded({ historyLoaded: false }),
      loaded({ historyLoaded: false }),
      loaded(),
    ]);
    expect(jumps).toEqual([false, false, true]);
    expect(state.owing).toBe(false);
  });

  it("does NOT yank a reader who is scrolled up when a refresh replaces the list", () => {
    const { state, jumps } = run([
      loaded(), // opened at the newest
      loaded({ hadContent: true, atBottom: false }), // reader scrolled up, then a re-request lands
      loaded({ hadContent: true, atBottom: false }), // …and later passes stay put
    ]);
    expect(jumps).toEqual([true, false, false]);
    expect(state.owing).toBe(false);
  });

  it("still follows the tail when the reader is at the bottom", () => {
    // A re-request always passes through "loading" first, and that is what
    // re-arms the debt — so a refresh under a reader at the bottom keeps them
    // pinned to the newest message.
    const { jumps } = run([
      loaded(),
      loaded({ historyLoaded: false, hadContent: true, atBottom: true }),
      loaded({ hadContent: true, atBottom: true }),
    ]);
    expect(jumps).toEqual([true, false, true]);
  });

  it("keeps owing until the pane can measure itself", () => {
    const { state, jumps } = run([
      loaded({ clientHeight: 0 }), // not laid out yet (background / mid-switch)
      loaded({ clientHeight: 0 }),
      loaded({ clientHeight: 600 }),
    ]);
    expect(jumps).toEqual([false, false, true]);
    expect(state.owing).toBe(false);
  });

  it("an idle re-render (no snapshot landing) is not a jump", () => {
    const { jumps } = run([
      loaded(),
      loaded({ hadContent: true, atBottom: true }),
      loaded({ hadContent: true, atBottom: false }),
    ]);
    expect(jumps).toEqual([true, false, false]);
  });
});
