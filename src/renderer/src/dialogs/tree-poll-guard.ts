/**
 * Single-flight gate for the session-tree `get_entries` poll.
 *
 * The TreeDialog re-asks for the tree on a fixed interval, but the RPC link can
 * be much slower than that interval: ssh2 + `pi --mode rpc` (whose command loop
 * waits on stdout backpressure) has been measured at 15–18s per `get_entries`
 * response, while the poll fires every 3s. Without a gate the requests stack up
 * (observed: 12949 sends / 12932 responses for one dialog) and saturate pi's
 * serial command loop, so every other command — prompt, get_state,
 * get_messages — queues behind the flood and the app looks hung.
 *
 * The gate is a tiny state machine (no timers of its own, clock injected) so
 * the policy is unit-testable:
 *  - acquire() claims the slot, or returns false while one is outstanding;
 *  - release() frees it (called on ANY matching response);
 *  - a slot left claimed longer than `stallMs` is considered lost (dropped
 *    response / dead channel) and may be re-claimed, so a single lost frame
 *    can never stop the poll forever.
 *
 * `stallMs` must exceed the slowest legitimate round trip (30s covers the
 * measured 18s with headroom) or a slow-but-alive response is duplicated.
 */
export interface EntriesSlot {
  /** Claim the in-flight slot. False when a request is already outstanding. */
  acquire(): boolean;
  /** Free the slot after a response (any outcome). */
  release(): void;
  /** Test/introspection helper: is a request currently outstanding? */
  isInFlight(): boolean;
}

export function createEntriesSlot(stallMs: number, now: () => number = Date.now): EntriesSlot {
  let inFlight = false;
  let sentAt = 0;
  return {
    acquire(): boolean {
      if (inFlight) {
        // A response that never arrives must not wedge the poll permanently.
        if (now() - sentAt < stallMs) return false;
        inFlight = false;
      }
      inFlight = true;
      sentAt = now();
      return true;
    },
    release(): void {
      inFlight = false;
    },
    isInFlight(): boolean {
      return inFlight;
    },
  };
}

/** Default stall window: above the measured 15–18s remote round trip. */
export const ENTRIES_STALL_MS = 30_000;
