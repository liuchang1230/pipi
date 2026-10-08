/**
 * transcript-from-file.ts — a session file's content → the messages pi's
 * `get_messages` would return for it.
 *
 * The IPC handler (`session:transcript-from-file`) is a thin shell around this
 * so the safety-critical contract stays unit-testable: **an unusable file
 * returns `null`, never an empty or partial transcript.** The caller falls back
 * to the RPC path on `null`, which is what makes a pi format change degrade to
 * "slow but correct" instead of "blank chat".
 *
 * Parsing is COOPERATIVE (`parseTreeFileAsync`): a multi-MB session file is
 * thousands of `JSON.parse` calls, and doing that synchronously on the main
 * process would stall every IPC and the terminal stream — the very
 * "未响应" this feature exists to remove.
 *
 * Resolution itself lives in `shared/transcript.ts` (mirrors pi's compaction
 * semantics; pinned by a differential test against pi).
 *
 * TWO READERS, because the chat shows the TAIL:
 *  - {@link transcriptFromContent}: whole file → the whole context. Kept as the slow,
 *    fully-verified path (and the one the tests exercise end to end).
 *  - {@link transcriptTailFromSource}: the newest PAGE(s) of the file → the newest
 *    messages. Measured on a real 62 MB / 900-message remote session, the whole-file read
 *    took 50 s over SFTP while the last 120 messages live in the last few percent of the
 *    bytes (docs/adr/0012-transcript-tail-window.md). The chat only ever renders the tail
 *    (`TRANSCRIPT_TAIL_MESSAGES` in ChatPane), so the rest was pure latency.
 *
 * The tail reader is honest about what it cannot see: whether older context exists beyond
 * the window (`complete`), and — because a window cannot be compared against pi's
 * `messageCount`, which counts the WHOLE context — the caller proves the tip separately
 * with one bounded `get_entries {since}` probe (see index.ts).
 */
import { parseTreeFileAsync } from "./tree-from-file";
import { compactionClosesContext, sessionContextMessages, type TranscriptEntry } from "../shared/transcript";
import { PAGE_BUDGET, type SessionPageBudget, type SessionPageDegradation } from "../shared/session-page";
import type { SessionPages } from "./session-pages";

/** Raw entries as the tail reader keeps them: every parsed line has a string id. */
export type RawTranscriptEntry = TranscriptEntry & { id: string };

/** The messages for a session file's content, or `null` when there is nothing
 *  usable to show (empty file, unparsable, no messages on the branch). */
export async function transcriptFromContent(content: string): Promise<unknown[] | null> {
  const { entries, leafId } = await parseTreeFileAsync(content);
  const messages = sessionContextMessages(entries as TranscriptEntry[], leafId);
  return messages.length > 0 ? messages : null;
}

/** How many messages the chat view shows on open (ChatPane's TRANSCRIPT_TAIL_MESSAGES).
 *  Reading past it buys nothing: the renderer slices it off again. */
export const TRANSCRIPT_TAIL_MIN_MESSAGES = 120;

/** Ceiling for the backwards walk in PAGES (each ≤ PAGE_BUDGET). A session whose last 120
 *  messages span more than this stops here and shows what it has — the read stays bounded
 *  even when one message is enormous. */
export const TRANSCRIPT_TAIL_MAX_PAGES = 6;

/** When the bounded walk came up short, one COMPLETE read is allowed for a session up to
 *  this size. That is the pathological case (a single 9 MB line in the tail region blocks
 *  the window), where the complete read is what the pre-paging code did for EVERY open —
 *  and it still shows the newest messages the chat is used to. Above this size the tail
 *  reader stops with what it framed: a 60 MB session must never go back to reading 60 MB
 *  because one line was awkward. */
export const TRANSCRIPT_WINDOW_ESCALATE_MAX_BYTES = 16_000_000;

export interface TranscriptWindow {
  /** Raw entries, oldest → newest (what the tip probe merges into). */
  entries: RawTranscriptEntry[];
  /**
   * The context resolver's output for `entries`.
   *
   * When `complete` is false this is the context's TAIL, with one caveat that is worth
   * stating exactly: if the window holds a compaction whose `firstKeptEntryId` lies OUTSIDE
   * it, the resolver mirrors pi (which hoists the summary to the front and drops the
   * pre-compaction entries) — so the result is `[summary, post-compaction messages]`, i.e.
   * the tail of the post-compaction region rather than a raw suffix of the whole context.
   * The newest messages are still the newest, and the summary is exactly what the chat
   * renders as a 「上下文摘要」 row.
   */
  messages: unknown[];
  /** The window covered the WHOLE context: it reached the file start (or the file was read
   *  in full) or a compaction whose kept entries are all inside it. Then and only then is
   *  `messages.length` the real context length, comparable to pi's `messageCount`. */
  complete: boolean;
  /** Newest entry id in the window — the `since` cursor for the tip probe. */
  lastId: string | null;
  degraded?: SessionPageDegradation;
}

/**
 * The newest messages of a session file: read pages back from EOF until at least
 * `minMessages` messages resolve, the file start is reached, a compaction boundary closes
 * the context, or a cap stops us. Returns `null` when the file yields no usable message
 * at all (empty/absent/unparsable) so the caller can fall back.
 */
export async function transcriptTailFromSource(
  pages: SessionPages<RawTranscriptEntry>,
  sessionPath: string,
  opts?: { minMessages?: number; maxPages?: number; budget?: SessionPageBudget; escalateMaxBytes?: number },
): Promise<TranscriptWindow | null> {
  const min = Math.max(1, Math.floor(opts?.minMessages ?? TRANSCRIPT_TAIL_MIN_MESSAGES));
  const maxPages = Math.max(1, Math.floor(opts?.maxPages ?? TRANSCRIPT_TAIL_MAX_PAGES));
  const budget = opts?.budget ?? PAGE_BUDGET;
  const escalateMaxBytes = opts?.escalateMaxBytes ?? TRANSCRIPT_WINDOW_ESCALATE_MAX_BYTES;

  const newest = await pages.tail(sessionPath, budget);
  if (newest.entries.length === 0) return null; // nothing usable → the caller falls back
  let entries = newest.entries;
  let cursor = newest.cursor;
  let degraded = newest.degraded;
  let messages = resolve(entries);
  let pagesRead = 1;
  while (messages.length < min && cursor && !degraded && pagesRead < maxPages) {
    const older = await pages.before(sessionPath, cursor, budget);
    pagesRead += 1;
    // Overwrite (not accumulate): any degraded page ends the walk right below, so the flag
    // is a single "why we stopped" value rather than a history.
    degraded = older.degraded;
    if (older.entries.length === 0) {
      cursor = null; // nothing older in the file: we have all of it
      break;
    }
    entries = [...older.entries, ...entries];
    cursor = older.cursor;
    messages = resolve(entries);
  }
  // The bounded walk could not reach the message budget (a huge line it could not frame, or
  // very sparse messages). For a SMALL session, read it completely instead of showing a
  // handful of messages — the cost is what every open used to cost, and the result is the
  // whole context (so the caller's count check applies again).
  //
  // `complete` needs BOTH halves: a page that degraded reports `cursor: null` (so the UI
  // cannot page into a loop), so "no cursor" alone would call a truncated window complete —
  // and then the count check would reject the transcript, which is how the fast path could
  // silently never apply.
  const reachedStart = cursor === null && (degraded === undefined || degraded === "whole-file-read");
  // The compaction half has to ask the resolver's own question ("is the kept entry ON this
  // leaf path, before the compaction?") — a mere id match would count a side branch's entry
  // and claim completeness for a window that only holds a post-compaction suffix.
  const leafGuess = entries.length > 0 ? entries[entries.length - 1]!.id : null;
  const completeAlready = reachedStart || (leafGuess !== null && compactionClosesContext(entries, leafGuess));
  if (!completeAlready && messages.length < min) {
    const size = await pages.size(sessionPath);
    if (size !== null && size <= escalateMaxBytes) {
      const whole = await pages.all(sessionPath, budget);
      if (whole.entries.length > 0) {
        return {
          entries: whole.entries,
          messages: resolve(whole.entries),
          complete: whole.cursor === null, // `all` reads the file from 0: it is the context
          lastId: whole.entries[whole.entries.length - 1]!.id,
        };
      }
    }
  }
  return {
    entries,
    messages,
    complete: completeAlready,
    lastId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
    ...(degraded !== undefined ? { degraded } : {}),
  };

  /** What the context resolver says for this window, using the file's own newest entry as
   *  the leaf — the tip probe may replace it with pi's authoritative leaf id afterwards. */
  function resolve(windowEntries: RawTranscriptEntry[]): unknown[] {
    const leaf = windowEntries.length > 0 ? windowEntries[windowEntries.length - 1]!.id : null;
    return sessionContextMessages(windowEntries, leaf);
  }
}

/** What the tail probe found at the tip: pi's entries after the window's newest one, plus
 *  pi's authoritative leaf id. `null` means the probe did not answer (pi booting/gone). */
export interface TranscriptTip {
  entries: RawTranscriptEntry[];
  leafId: string | null;
}

/** What the handler should answer for a window read — `ok:false` means "use the whole-file
 *  path", never "show a partial transcript as truth". */
export type TranscriptAttempt = { ok: true; messages: unknown[]; total: number } | { ok: false; reason: string };

/**
 * The tail reader's verdict, separated from the IPC handler so the contract is testable:
 * the window's resolve is what the chat shows, the tip probe is what makes a window
 * trustworthy, and `total` is what `chatStore.initMessages` stitches the older rendered
 * history with.
 *
 * The count check survives EXACTLY where it used to apply — when the window is the whole
 * context (`win.complete`) — and is replaced elsewhere by the tip probe, which proves the
 * file is not behind pi at the tip (and repairs it if it is) instead of proving it over the
 * whole file.
 */
export function resolveTranscriptAttempt(input: {
  window: TranscriptWindow | null;
  tip: TranscriptTip | null;
  /** pi's `get_state.messageCount` — the length of the list `get_messages` would return. */
  expected: number;
  /** How many messages the renderer asked for (undefined = all of them). */
  tail?: number;
}): TranscriptAttempt {
  const win = input.window;
  if (!win || win.entries.length === 0) return { ok: false, reason: "empty transcript" };
  const entries = input.tip ? mergeRawEntries(win.entries, input.tip.entries) : win.entries;
  // A probe that named a leaf we do not hold (a navigation deeper than the window) must NOT
  // be resolved: `sessionContextMessages` would fall back to the newest entry BY POSITION —
  // the branch the user navigated away from — and answer `ok:true` with the wrong branch.
  // The pre-window code caught this by comparing lengths; the count check only runs for a
  // complete window, so the check has to be explicit here.
  if (input.tip && typeof input.tip.leafId === "string" && !entries.some((e) => e.id === input.tip!.leafId)) {
    return { ok: false, reason: "leaf outside window" };
  }
  // `null` means "no leaf at all" to the resolver (it returns []), so an absent probe leaf is
  // expressed as "resolve from the newest entry we hold" — which is the tip's newest when the
  // probe delivered anything, and the window's newest when it delivered nothing. Using
  // `win.lastId` here instead would drop freshly-fetched tip entries from the resolve.
  const leaf = input.tip?.leafId ?? (entries.length > 0 ? entries[entries.length - 1]!.id : null);
  const messages = sessionContextMessages(entries, leaf);
  if (win.complete && messages.length !== input.expected) {
    // The window WAS the whole context, so this is the historical verdict: the file
    // disagrees with pi's in-memory state (unflushed navigation / session switch).
    return { ok: false, reason: `file behind pi state (${messages.length} != ${input.expected})` };
  }
  if (messages.length === 0) return { ok: false, reason: "empty transcript" };
  const tail = input.tail !== undefined && input.tail > 0 ? Math.floor(input.tail) : undefined;
  const sliced = tail !== undefined && messages.length > tail ? messages.slice(-tail) : messages;
  return {
    ok: true,
    messages: sliced,
    // An incomplete window is a suffix of the real context, so the real length is pi's
    // count; a complete one knows its own length exactly. Both are "how many messages the
    // session has", which is what the renderer stitches against.
    total: win.complete ? messages.length : Math.max(messages.length, input.expected),
  };
}

/**
 * Merge the tip probe's entries into a window: append the ones we do not have yet, in file
 * order, dropping ids we already read (pi re-sends the boundary entry the probe asked
 * after). Pure — the caller decides whether the merged result is worth resolving.
 */
export function mergeRawEntries(base: readonly RawTranscriptEntry[], extra: readonly RawTranscriptEntry[]): RawTranscriptEntry[] {
  if (extra.length === 0) return [...base];
  const known = new Set(base.map((e) => e.id));
  const fresh = extra.filter((e) => !known.has(e.id));
  return fresh.length === 0 ? [...base] : [...base, ...fresh];
}


