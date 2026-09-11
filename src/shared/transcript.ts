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
  const index = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e && typeof e.id === "string") index.set(e.id, e);
  }
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

  return contextEntries(path).flatMap(entryToMessages);
}
