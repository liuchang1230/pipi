/**
 * transcript.ts — the message list pi would return from `get_messages`, rebuilt
 * from a session JSONL's flat entry list.
 *
 * Why: on a slow remote link `get_messages` ships that list over the
 * `pi --mode rpc` channel, whose command loop is serial and sits behind a
 * stdout-backpressure gate — so transferring history makes
 * `prompt`/`get_state`/`get_entries` queue behind it and the agent LOOKS stuck
 * (measured 17–45s round trips). The session file is append-only,
 * byte-addressable, and reachable over a different channel (local FS / WSL UNC
 * / SFTP / ssh), so history belongs there.
 *
 * This MIRRORS pi's own resolution rather than inventing one:
 *   buildSessionContext().messages === sessionEntryToContextMessages(entry)
 *     over buildContextEntries(entries, leafId)
 * i.e. the root→leaf path, with the LATEST compaction applied (the summary
 * entry replaces everything before `firstKeptEntryId`). Mirroring is deliberate
 * — pi's counter-example is `session-list.ts`, which parses the JSONL itself
 * precisely so an SDK/format change cannot break us, and importing pi here
 * would pull its whole 100MB+ graph into the main process the user is already
 * reporting as memory-hungry. Fidelity is instead pinned by a differential test
 * that compares this module against pi's real `buildSessionContext` (the
 * oracle lives in the TEST, not in the app).
 *
 * Two intentional hardenings over pi (which assumes well-formed files and would
 * throw / spin on bad input): a message entry with no body is skipped, and a
 * cyclic parent chain terminates. Both only ever differ on malformed input.
 *
 * Pure and environment-agnostic (no node/electron/pi imports).
 */

/**
 * Response-id prefix for the main process's INTERNAL `get_state` probes (used
 * to learn pi's own message count before trusting a file-derived transcript).
 *
 * The renderer MUST ignore responses carrying this prefix: the transcript
 * provider's probe is not the renderer's request, and letting it reach the
 * `state_ready` branch would re-enter `requestHistory` and loop
 * (probe → state_ready → requestHistory → probe → …).
 */
export const INTERNAL_RPC_ID_PREFIX = "pipi-internal-";

/** Whether an RPC response id belongs to an INTERNAL probe (main's `get_state` / the
 *  transcript tip probe) rather than to a renderer request. Every consumer of the RPC event
 *  stream must drop those: they are not its requests, and a `get_entries` response with an
 *  id nobody recognises would otherwise be treated as a full snapshot. */
export function isInternalProbeId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(INTERNAL_RPC_ID_PREFIX);
}

/** One parsed session-file line. Mirrors pi's `SessionEntry`/`FileEntry` union
 *  loosely (fields are read defensively; the file is parsed, not validated). */
export interface TranscriptEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; [k: string]: unknown } | null;
  /** compaction */
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  /** branch_summary */
  fromId?: string;
  /** custom_message */
  customType?: string;
  content?: unknown;
  display?: unknown;
  details?: unknown;
  [k: string]: unknown;
}

/** pi `createCustomMessage` */
function customMessage(e: TranscriptEntry): unknown {
  return {
    role: "custom",
    customType: e.customType,
    content: e.content ?? [],
    display: e.display,
    details: e.details,
    timestamp: new Date(e.timestamp as string).getTime(),
  };
}

/** pi `createBranchSummaryMessage` */
function branchSummaryMessage(e: TranscriptEntry): unknown {
  return {
    role: "branchSummary",
    summary: e.summary,
    fromId: e.fromId,
    timestamp: new Date(e.timestamp as string).getTime(),
  };
}

/**
 * pi `COMPACTION_SUMMARY_PREFIX` (dist/core/messages.js): how a compaction
 * summary enters the MODEL context — as a USER message wrapped in this
 * envelope, not as a `compactionSummary` message.
 *
 * Both shapes therefore reach the chat view: the session-file path below emits
 * the unwrapped `compactionSummary` message, while a live `get_messages` (local
 * SDK tabs, whose `state.messages` IS the model context) returns the wrapped
 * user message. Neither is something the user typed, so the chat view has to
 * recognize both — treating the wrapped one as a normal user bubble put a wall
 * of English above the conversation.
 */
export const COMPACTION_SUMMARY_MARKER =
  "The conversation history before this point was compacted into the following summary:";

/**
 * The summary text inside a compaction message, or `undefined` when this is not
 * one. `role` disambiguates pi's two shapes; `text` is the message's text (for
 * a `compactionSummary` message that is its `summary` field).
 */
export function compactionSummaryOf(role: string | undefined, text: string): string | undefined {
  if (role === "compactionSummary") {
    const summary = text.trim();
    return summary.length > 0 ? summary : undefined;
  }
  if (!text.startsWith(COMPACTION_SUMMARY_MARKER)) return undefined;
  const summary = text
    .slice(COMPACTION_SUMMARY_MARKER.length)
    .replace(/^\s*<summary>\s*/, "")
    .replace(/\s*<\/summary>\s*$/, "")
    .trim();
  return summary.length > 0 ? summary : undefined;
}

/** pi `createCompactionSummaryMessage` */
function compactionSummaryMessage(e: TranscriptEntry): unknown {
  return {
    role: "compactionSummary",
    summary: e.summary,
    tokensBefore: e.tokensBefore,
    timestamp: new Date(e.timestamp as string).getTime(),
  };
}

/** pi `sessionEntryToContextMessages` (see the module comment for the two
 *  intentional hardenings). */
function entryToMessages(e: TranscriptEntry): unknown[] {
  if (e.type === "message") {
    const message = e.message;
    if (!message || typeof message !== "object") return []; // hardening
    // Old versions / forks / hand-edited files can carry null content.
    if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult") && message.content == null) {
      return [{ ...message, content: [] }];
    }
    return [message];
  }
  if (e.type === "custom_message") return [customMessage(e)];
  if (e.type === "branch_summary" && e.summary) return [branchSummaryMessage(e)];
  if (e.type === "compaction") return [compactionSummaryMessage(e)];
  return []; // display/state-only entries never participate in context
}

/**
 * pi `buildContextEntries`: if the path contains compactions, only the LATEST
 * one survives — it contributes its summary message, the entries from
 * `firstKeptEntryId` onward are kept, and everything older is omitted.
 */
function contextEntries(path: TranscriptEntry[]): TranscriptEntry[] {
  let compaction: TranscriptEntry | null = null;
  for (const e of path) {
    if (e.type === "compaction") compaction = e; // last one on the path wins
  }
  if (!compaction) return path;
  const idx = path.findIndex((e) => e.id === compaction!.id);
  if (idx < 0) return path; // unreachable for a walked path; mirrors pi
  const out: TranscriptEntry[] = [compaction];
  let foundFirstKept = false;
  for (let i = 0; i < idx; i++) {
    const e = path[i]!;
    if (e.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) out.push(e);
  }
  out.push(...path.slice(idx + 1));
  return out;
}

/** `id → entry` for a set of entries (first occurrence wins, like `parseTreeEntries`). */
function indexById(entries: readonly TranscriptEntry[]): Map<string, TranscriptEntry> {
  const index = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e && typeof e.id === "string" && !index.has(e.id)) index.set(e.id, e);
  }
  return index;
}

/** The root→leaf path within `entries` (leaf resolution mirrors pi's `buildSessionPath`:
 *  an unknown id falls back to the LAST entry by position; a broken parent chain ends the
 *  walk; a ring terminates). `[]` only when there is nothing to walk. */
function leafPath(entries: readonly TranscriptEntry[], index: Map<string, TranscriptEntry>, leafId: string | null): TranscriptEntry[] {
  let leaf: TranscriptEntry | undefined;
  if (leafId) leaf = index.get(leafId);
  leaf ??= entries[entries.length - 1];
  if (!leaf) return [];

  const path: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = leaf;
  while (current) {
    if (current.id && seen.has(current.id)) break; // hardening: ring-safe
    if (current.id) seen.add(current.id);
    path.push(current);
    const parentId: string | null | undefined = current.parentId;
    current = parentId ? index.get(parentId) : undefined;
  }
  path.reverse(); // root → leaf
  return path;
}

/**
 * Whether the LAST compaction on this leaf path kept entries that are ON that path — the
 * exact `foundFirstKept` condition in pi's `buildContextEntries`. When it holds, the
 * resolver drops nothing the path still needs, so resolving these entries yields the whole
 * context rather than a suffix of it.
 *
 * Why it exists: a windowed reader (main/transcript-from-file.ts) must know whether its
 * window is the whole context, and "a compaction appears somewhere in the window" is NOT
 * enough — the kept entry id could belong to a side branch, or lie outside the window, in
 * which case the resolver silently drops the in-window pre-compaction entries and the
 * result is a post-compaction suffix, not the context.
 */
export function compactionClosesContext(entries: readonly TranscriptEntry[], leafId: string | null): boolean {
  const index = indexById(entries);
  const path = leafPath(entries, index, leafId);
  let compaction: TranscriptEntry | null = null;
  for (const e of path) {
    if (e.type === "compaction" && typeof e.firstKeptEntryId === "string") compaction = e;
  }
  if (!compaction) return false;
  const idx = path.findIndex((e) => e.id === compaction!.id);
  return path.slice(0, idx).some((e) => e.id === compaction!.firstKeptEntryId);
}

/**
 * The `messages` array pi's `get_messages` returns for this session file.
 *
 * Leaf resolution mirrors pi's `buildSessionPath`: `null` means "no leaf" ([]),
 * an unknown id falls back to the LAST entry by position (append order), and a
 * broken parent chain ends the walk. Returns `[]` rather than throwing, so a
 * caller can fall back to the RPC path on an empty result.
 */
export function sessionContextMessages(
  entries: readonly TranscriptEntry[],
  leafId: string | null,
): unknown[] {
  if (leafId === null) return [];
  const path = leafPath(entries, indexById(entries), leafId);
  if (path.length === 0) return [];
  return contextEntries(path).flatMap(entryToMessages);
}
