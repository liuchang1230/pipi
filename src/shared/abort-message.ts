/**
 * abort-message.ts — "the user stopped this turn" is NOT a model error.
 *
 * Evidence (pi 0.85.1, checked in the bundle + a real session file):
 *  - an aborted request is persisted as an assistant message with
 *    `stopReason: "error"`, `errorMessage: "This operation was aborted"` and
 *    EMPTY content (`createAbortedMessage` uses `stopReason: "aborted"` +
 *    "Request was aborted", the provider path normalizes the raw AbortError
 *    into `stopReason: "error"`). So the stop reason alone is not enough.
 *  - the session file
 *    `~/.pi/agent/sessions/--D--crscu-.../2026-08-25T15-21-01-777Z_*.jsonl`
 *    contains exactly that pair (`stopReason: error`, empty content) — i.e. a
 *    perfectly normal "I pressed stop" turn.
 *
 * Rendering that as a red "⚠ 模型错误" tells the user their model failed when in
 * fact nothing failed: they cancelled it. It also made the transcript lie about
 * ordering, because the abort's message only arrives after the next prompt.
 *
 * The trap: "aborted" is ALSO how a broken connection reports itself
 * ("Connection aborted.", ECONNRESET, socket hang up). Those ARE real failures
 * and must stay visible, so connection-shaped text is excluded first.
 */

/** Connection failures phrased with "aborted" — real errors, never a user cancel. */
const CONNECTION_FAILURE_RE =
  /connection\s+(reset|closed|aborted|refused|terminated)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|broken\s+pipe|socket\s+hang\s+up|ssh_exchange_identification|kex_exchange_identification|Timeout,\s*server/i;

/**
 * Cancellation wording. Deliberately narrow: `aborted` alone is not enough
 * ("connection aborted", "request aborted by the proxy" would match), but the
 * forms providers and Node actually use are covered.
 */
const CANCEL_RE =
  /^aborted$|^cancell?ed$|\b(this|the)\s+operation\s+was\s+aborted\b|\brequest\s+was\s+aborted\b|\bAbortError\b|\buser\s+(aborted|cancell?ed)\b|\bcancell?ed\s+by\s+(the\s+)?user\b|\bmessage\s+(was\s+)?cancell?ed\b/i;

/**
 * Text that NAMES a real failure. A fresh stop must never explain these away:
 * the user aborting a turn does not turn "insufficient balance" or a dead
 * socket into a cancellation.
 */
const REAL_FAILURE_RE =
  /insufficient|quota|rate\s*limit|too\s+many\s+requests|unauthor|forbidden|invalid\s+(api\s*)?key|missing\s+(api\s*)?key|expired|finish_reason|(401|403|429|500|502|503|504)|context\s+(window|length)/i;

/** How long an explicit stop keeps justifying "this was my cancel" (2 min). */
export const ABORT_GRACE_MS = 120_000;

/** Does this text say "the request was cancelled"? Connection failures excluded. */
export function isUserAbortMessage(text: string | undefined | null): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  const t = text.trim();
  if (CONNECTION_FAILURE_RE.test(t)) return false;
  return CANCEL_RE.test(t);
}

export interface CancelledTurnInput {
  /** pi's `stopReason` on the assistant message. */
  stopReason?: string | undefined;
  /** pi's `errorMessage` on the assistant message. */
  errorMessage?: string | undefined;
  /** Character count of the message content (empty = nothing was produced). */
  contentLength?: number | undefined;
  /** When the user pressed stop for this tab (undefined = they never did). */
  abortRequestedAt?: number | undefined;
  now?: number | undefined;
}

/**
 * Was this assistant message the user's own cancellation rather than a failure?
 *
 * Three independent yes-paths, in decreasing strength:
 *  1. pi marked it `aborted` — authoritative.
 *  2. the error text is cancellation wording (and not a connection failure).
 *  3. we KNOW the user pressed stop moments ago and the message produced no
 *     content at all: whatever text it carries is the abort's fallout (the raw
 *     provider error can be anything, e.g. "The operation was aborted", or a
 *     stream error raised while the socket was being torn down). Nothing was
 *     answered, so reporting a model failure would be wrong.
 *
 * Path 3 needs the empty content guard: a turn that produced output and THEN
 * failed is a real failure even if the user happened to press stop.
 */
export function isCancelledTurnMessage(input: CancelledTurnInput): boolean {
  if (input.stopReason === "aborted") return true;
  if (isUserAbortMessage(input.errorMessage)) return true;
  if (input.abortRequestedAt === undefined) return false;
  if ((input.contentLength ?? 0) > 0) return false;
  const text = (input.errorMessage ?? "").trim();
  // A named failure outranks our stop request: a dead socket or an exhausted
  // account is news the user needs, however recently they pressed stop.
  if (text && (CONNECTION_FAILURE_RE.test(text) || REAL_FAILURE_RE.test(text))) return false;
  const now = input.now ?? Date.now();
  return now - input.abortRequestedAt >= 0 && now - input.abortRequestedAt <= ABORT_GRACE_MS;
}
