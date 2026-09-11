/**
 * Single-flight + coalescing gate for the transcript (`get_messages`) download.
 *
 * Regression context (pipi-debug.log, 36-server tab, 2026-09-11): ONE
 * `get_messages` round trip measured 17–45s on that link, while triggers
 * arrive from three independent places — the mount effect, the `state_ready`
 * branch (which re-fires whenever `historyLoaded` is false), and branch
 * navigation. With no gate they overlapped three multi-MB downloads on one
 * link (08:32:03.062 / 08:32:03.071 / 08:32:04.923, responses at 17.8s / 33s /
 * 44s): the link saturated ("连接非常卡"), the main process stalled parsing the
 * payloads ("未响应"), and `[mem]` peaked at rss 631MB inside a get_messages
 * window.
 *
 * The gate is a tiny state machine (no timers, no DOM) so the policy is
 * unit-testable:
 *  - `begin()` claims the slot, or returns false while one is outstanding —
 *    and in that case RECORDS the trigger instead of dropping it;
 *  - `settle()` frees the slot and reports whether a recorded trigger still
 *    needs one re-run.
 *
 * It deliberately has no stall window (unlike `tree-poll-guard`): the caller
 * owns the request timeout, and the gate must free the slot in `finally` on
 * every outcome — including a timeout — so a lost payload can never wedge it.
 */
export interface HistoryGate {
  /** Claim the slot. False = a request is outstanding (trigger recorded). */
  begin(): boolean;
  /** Free the slot. True = a trigger arrived mid-flight → run exactly once more. */
  settle(): boolean;
  /** Introspection helper (tests): is a request currently outstanding? */
  isInFlight(): boolean;
}

export function createHistoryGate(): HistoryGate {
  let inFlight = false;
  let queued = false;
  return {
    begin(): boolean {
      if (inFlight) {
        // Coalesce: any number of triggers arriving mid-flight collapse into
        // ONE re-run, never a parallel download.
        queued = true;
        return false;
      }
      inFlight = true;
      queued = false; // defensive: a free slot can never carry a stale trigger
      return true;
    },
    settle(): boolean {
      inFlight = false;
      const rerun = queued;
      queued = false;
      return rerun;
    },
    isInFlight(): boolean {
      return inFlight;
    },
  };
}
