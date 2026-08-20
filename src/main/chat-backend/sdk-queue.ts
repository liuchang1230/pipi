/**
 * SDK worker command-routing decision (pure, no SDK deps so it unit-tests
 * cleanly). The worker must not drop commands that arrive while a tab is
 * still opening (boot-time get_messages/get_state, an early user prompt):
 * those are queued and replayed FIFO once the session is registered.
 */

/** Cap on queued commands per opening tab; beyond it we fail fast instead of
 *  letting an pathological backlog pile up in the worker's memory. */
export const OPENING_CMD_QUEUE_MAX = 100;

export type CmdRoute = "run" | "queue" | "drop";

export interface CmdRoutingContext {
  /** Session registered in `tabs` (openTab finished). */
  registered: boolean;
  /** Tab is being torn down. */
  closing: boolean;
  /** openTab is still in flight for this tab id. */
  opening: boolean;
}

export function decideCmdRouting({ registered, closing, opening }: CmdRoutingContext): CmdRoute {
  if (registered && !closing) return "run";
  // Not registered yet but currently opening → hold the command for replay.
  // (registered:false + closing:true + opening:true is unreachable — closeTab
  // only sets closing on a registered tab and cancels the open otherwise.)
  if (!registered && opening) return "queue";
  // Unknown/closing tab → fail fast (nothing to replay onto).
  return "drop";
}

/** True when a queued command must be failed instead of appended (cap hit). */
export function queueAtCapacity(queuedCount: number): boolean {
  return queuedCount >= OPENING_CMD_QUEUE_MAX;
}
