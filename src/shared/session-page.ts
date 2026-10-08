/**
 * session-page.ts — one PAGE of a session JSONL, projected down to what the branch
 * dialog actually renders. Pure: no fs, no channel, no Electron.
 *
 * Why this exists (measured on this repo's own sessions, docs/diagnosis/2026-10-07.md):
 * the branch dialog used to read the WHOLE session file and ship every entry to the
 * renderer. On an 8 MB / 2763-entry session that is 8 MB over IPC, and a long remote
 * session is 10-50x that — which is what "打开分支就卡死" was. Two facts make a page
 * enough:
 *
 *  1. **Contents are the bytes.** Measured share of a session file: tool results 65-73%,
 *     tool-call arguments 19-24%, assistant text 2-5%, user prompts 0.0-0.2%. The dialog
 *     reads a one-line preview, the tool-call NAME + a few arguments, and (for 回退到
 *     user 消息) the user's own prompt. Projecting an entry keeps all of that for ~11-15%
 *     of the bytes (toolCallArgs and toolResult previews capped, user prompts whole).
 *     8.07 MB → 0.97 MB measured on a real 2763-entry session.
 *  2. **The dialog opens at the leaf.** The recent conversation is the tail of an
 *     append-only file, so the tail is one ranged read away; older pages are fetched
 *     only when the user scrolls up / asks for them.
 *
 * The projection is deliberately SHAPE-COMPATIBLE with a raw entry (same field names,
 * `message.content` still an array of `text`/`toolCall` blocks), so the row renderer,
 * `flattenTree`, `applyVisibility` and `searchableText` need no changes — a projected
 * entry is a smaller entry, not a different type.
 *
 * What is LOST, on purpose (documented in docs/adr/0011-session-entry-paging.md):
 *  - tool results keep a preview, not their body (the row shows the tool CALL, so the
 *    body was never rendered; it is still in the file for the chat transcript);
 *  - free text is capped at one row's worth (previews/search match the preview);
 *  - rollback is unaffected: it rebuilds the file timeline from the chat transcript's
 *    tool arguments, not from tree entries (TreeDialog.rollbackToNode).
 */
import type { TranscriptEntry } from "./transcript";
import type { TreeEntry } from "./tree-build";

/** One row's worth of text. The renderer normalizes to a single line and CSS-ellipsises. */
const PREVIEW = 200;
/** A tool-call argument that a row label may print (TreeDialog.formatToolCall). */
const ARG_PREVIEW = 200;
/** Paths stay whole: 回退 resolves them against the project cwd. */
const PATH_MAX = 4096;
/** A compaction/branch summary is prose a user may search for. */
const SUMMARY_PREVIEW = 2000;

/** Argument keys a row label prints, in the order TreeDialog tries them. */
const ARG_KEYS = ["command", "path", "filePath", "pattern", "query", "dirPath", "tool", "url", "prompt"] as const;

export interface SessionPageBudget {
  /** Entries per page. */
  maxEntries: number;
  /** Bytes per read — one round trip on a slow link. */
  maxBytes: number;
  /** Bytes per PAGE, across the reads that fill it. A page lands inside megabyte-long
   *  entries often enough that one window is not always enough to fill `maxEntries`;
   *  this is what bounds "keep reading backwards to fill the page". */
  maxPageBytes: number;
  /** Ceiling for the retry that grows ONE window to find a line boundary (a single
   *  JSONL line can be MBs: measured 1.6 MB / 325 KB / 102 KB max lines in the local
   *  sessions). Larger than this and paging stops honestly instead of looping. */
  hardMaxBytes: number;
}

/** What the dialog asks for on open: the recent conversation, bounded in every dimension
 *  (worst case one page reads `maxPageBytes` + `hardMaxBytes`). */
export const PAGE_BUDGET: SessionPageBudget = { maxEntries: 400, maxBytes: 1_500_000, maxPageBytes: 6_000_000, hardMaxBytes: 16_000_000 };

/** Where to continue reading BACKWARDS from. `firstId` is the id of the oldest entry
 *  the previous page returned — a byte offset alone would silently follow a rewritten
 *  file, the id lets the caller notice. */
export interface SessionPageCursor {
  byteOffset: number;
  firstId: string;
}

export type SessionPageDegradation =
  /** The channel cannot read a byte range (key-auth ssh), so the whole file was read. */
  | "whole-file-read"
  /** No line boundary within `hardMaxBytes` (one enormous entry, or garbage) — paging stops. */
  | "window-too-large";

export interface SessionPage<T = TreeEntry> {
  /** Oldest → newest, in the codec's shape (projected for the branch dialog). */
  entries: T[];
  /** `null` once the page reached the start of the file. */
  cursor: SessionPageCursor | null;
  /** No entries exist before this page. */
  eof: boolean;
  /** Bytes this page actually transferred — the "bounded read" claim, measurable in logs and
   *  tests. A page that grew its window counts only the bytes it did not already hold. */
  bytesRead?: number;
  degraded?: SessionPageDegradation;
}

/** Renderer → main: which page of the session file to read (no `before` = the newest). */
export interface TreePageRequest {
  before?: SessionPageCursor;
}

/**
 * Main → renderer: one page, or an honest failure.
 *
 * `leafId` is the session's current position and is only meaningful on the NEWEST page
 * (where it is the last entry of the page). An older page returns `null`: its newest
 * entry is not the leaf, and the caller must not move the leaf backwards.
 */
export type TreePageResult = ({ ok: true; leafId: string | null } & SessionPage) | { ok: false; error: string };

/** The pure cut of one byte window (which always ENDS at the page's upper boundary). */
export interface WindowPage<T = TreeEntry> {
  entries: T[];
  /** Byte offset (inside the window) where the oldest returned entry's line starts. */
  oldestOffset: number | null;
  /** Older entries were in the window but did not fit `maxEntries` — the page was cut. */
  droppedOlder: boolean;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/[\n\t]/g, " ").trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

function capped(value: unknown, max: number): string | undefined {
  const t = text(value);
  return t === undefined ? undefined : t.slice(0, max);
}

/** The text of a message body, whether it is a string or pi's block array. */
function bodyText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

interface ToolCallBlock {
  id: string;
  name: string;
  arguments: unknown;
}

function toolCallBlocks(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ToolCallBlock[] = [];
  for (const block of content) {
    const b = block as { type?: string; id?: string; name?: string; arguments?: unknown };
    if (b?.type === "toolCall" && typeof b.id === "string") {
      out.push({ id: b.id, name: typeof b.name === "string" ? b.name : "tool", arguments: b.arguments });
    }
  }
  return out;
}

/**
 * Keep the arguments a row label or the rollback path can use — nothing else.
 *
 * `path`/`filePath` are kept whole (TreeDialog.isEditToolCall turns them into a
 * rollback target and relativizes them against the project cwd); everything else is
 * capped at one label's worth. When none of the known keys is present, the first
 * argument is kept as a string so the row still says something (mirrors
 * `formatToolCall`'s fallback).
 */
function projectArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const source = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ARG_KEYS) {
    const value = source[key];
    if (typeof value !== "string") continue;
    out[key] = key === "path" || key === "filePath" ? value.slice(0, PATH_MAX) : capped(value, ARG_PREVIEW);
  }
  if (Object.keys(out).length === 0) {
    const first = Object.entries(source)[0];
    if (first) out[first[0]] = capped(String(first[1]), ARG_PREVIEW);
  }
  return out;
}

/** A message body, projected for the row: user prompts whole, everything else a preview. */
function projectMessageContent(role: string | undefined, content: unknown): unknown {
  // A user prompt is handed BACK to the editor when navigating to it
  // (TreeDialog: onNavigated(editorText) → 「回到这里重新提问」), so it must not be
  // truncated — measured at 0.2% of a session file, it costs nothing to keep whole.
  if (role === "user") {
    const whole = typeof content === "string" ? content : bodyText(content);
    return whole.trim().length > 0 ? whole : text(whole) ?? "";
  }
  const preview = capped(bodyText(content), PREVIEW);
  const calls = toolCallBlocks(content);
  if (calls.length === 0) return preview ?? "";
  return [
    ...(preview ? [{ type: "text", text: preview }] : []),
    ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: projectArguments(c.arguments) })),
  ];
}

/** Free-form content of a non-message entry: a capped single-line preview, or nothing
 *  (an unknown object shape is exactly the kind of payload this module exists to drop). */
function projectFreeContent(content: unknown): string | undefined {
  if (typeof content === "string") return capped(content, SUMMARY_PREVIEW);
  if (Array.isArray(content)) return capped(bodyText(content), SUMMARY_PREVIEW);
  return undefined;
}

/**
 * One raw session-JSONL record → the row-facing entry the tree dialog renders.
 * `null` when the record is not an entry (the `session` header, a line with no id).
 *
 * Idempotent: `projectEntry(projectEntry(x))` equals `projectEntry(x)`, so the renderer
 * can project RPC deltas without caring whether they came from a page.
 */
export function projectEntry(raw: unknown): TreeEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "session") return null; // header, not an entry (parseTreeEntries skips it too)
  if (typeof r.id !== "string") return null;

  const type = typeof r.type === "string" ? r.type : "";
  const entry: TreeEntry = {
    type,
    id: r.id,
    parentId: typeof r.parentId === "string" ? r.parentId : null,
  };
  const timestamp = text(r.timestamp);
  if (timestamp !== undefined) entry.timestamp = timestamp;

  if (type === "message") {
    const message = (r.message ?? {}) as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : undefined;
    entry.message = {
      ...(role !== undefined ? { role } : {}),
      content: projectMessageContent(role, message.content),
      ...(text(message.stopReason) !== undefined ? { stopReason: text(message.stopReason) } : {}),
      ...(capped(message.errorMessage, PREVIEW) !== undefined ? { errorMessage: capped(message.errorMessage, PREVIEW) } : {}),
      ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    };
    // A bashExecution row prints its command (TreeDialog: `[bash]: …`).
    const command = capped(r.command, ARG_PREVIEW);
    if (command !== undefined) entry.command = command;
    return entry;
  }

  if (type === "label") {
    // `label` + `targetId` are load-bearing: buildTreeFromEntries resolves branch
    // labels from exactly these two fields.
    const label = capped(r.label, PREVIEW);
    if (label !== undefined) entry.label = label;
    if (typeof r.targetId === "string") entry.targetId = r.targetId;
    return entry;
  }
  if (type === "compaction") {
    if (typeof r.tokensBefore === "number") entry.tokensBefore = r.tokensBefore;
    const summary = capped(r.summary, SUMMARY_PREVIEW);
    if (summary !== undefined) entry.summary = summary;
    return entry;
  }
  if (type === "branch_summary") {
    const summary = capped(r.summary, SUMMARY_PREVIEW);
    if (summary !== undefined) entry.summary = summary;
    return entry;
  }
  if (type === "model_change") {
    if (typeof r.modelId === "string") entry.modelId = r.modelId;
    return entry;
  }
  if (type === "thinking_level_change") {
    if (typeof r.thinkingLevel === "string") entry.thinkingLevel = r.thinkingLevel;
    return entry;
  }
  if (type === "session_info") {
    const name = capped(r.name, PREVIEW);
    if (name !== undefined) entry.name = name;
    return entry;
  }

  if (typeof r.customType === "string") entry.customType = r.customType;
  const content = projectFreeContent(r.content);
  if (content !== undefined) entry.content = content;
  return entry;
}

/**
 * Parse one byte window into projected entries with the byte offset of each entry's own
 * LINE start. Pure, and the primitive both readers are built on.
 *
 * The window always ENDS at a page boundary (EOF, or a byte a previous page named as a
 * line start), so:
 *  - the leading fragment is a line the window start cut in half. It simply fails to
 *    parse and is skipped — which is what makes every returned `start` a real LINE START
 *    and therefore usable as the next page's boundary;
 *  - the trailing fragment without a newline is either the file's last line (EOF) or a
 *    complete line whose newline fell just past the boundary (an older page). Both parse
 *    when the write was complete; a torn write (pi mid-append) is skipped and re-delivered
 *    by the next delta poll.
 */
export type LineParser<T> = (raw: unknown) => T | null;

/**
 * How the byte engine turns a window's lines into entries. Two readers share the engine
 * (main/session-pages.ts) but not the shape:
 *  - the branch dialog projects an entry down to what a row renders (`projectEntry`),
 *  - the chat transcript must keep the real message bodies and compaction pointers its
 *    resolver reads, so it takes raw entries (main/transcript-from-file.ts).
 * Both shapes carry an `id`, which is what a page cursor is built from.
 */
export interface EntryCodec<T extends { id: string }> {
  /** Window bytes → entries with the byte offset their line starts at. */
  window(buf: Buffer): Array<{ entry: T; start: number }>;
  /** Whole buffer → the newest page (the degraded path for channels without range reads). */
  page(buf: Buffer, budget: SessionPageBudget): WindowPage<T>;
}

const parseProjectedEntry: LineParser<TreeEntry> = (raw) => projectEntry(raw);

/**
 * Raw entries — what the chat transcript reads. Mirrors `parseTreeEntries`
 * (main/tree-from-file.ts) exactly: skip the `session` header, skip anything that is not
 * an object or has no string id, keep every other field untouched.
 */
export function parseRawEntry(raw: unknown): (TranscriptEntry & { id: string }) | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.type === "session") return null; // header only
  return typeof record.id === "string" ? (record as TranscriptEntry & { id: string }) : null;
}

function windowLines<T>(buf: Buffer, parse: LineParser<T>): Array<{ entry: T; start: number }> {
  const parsed: Array<{ entry: T; start: number }> = [];
  let from = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, from);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(from, end).toString("utf8").trim();
    if (line.length > 0) {
      try {
        const entry = parse(JSON.parse(line));
        if (entry) parsed.push({ entry, start: from });
      } catch {
        /* malformed line (or a fragment the window cut) — same policy as parseTreeEntries */
      }
    }
    if (nl === -1) break;
    from = nl + 1;
  }
  return parsed;
}

/**
 * One window → one page: the newest `maxEntries` entries of the window, plus the byte
 * offset the next (older) page must end at. This is the whole-file fallback's reader.
 */
function pageOfWindow<T>(buf: Buffer, budget: SessionPageBudget, parse: LineParser<T>): WindowPage<T> {
  const parsed = windowLines(buf, parse);
  const kept = budget.maxEntries > 0 ? parsed.slice(-budget.maxEntries) : [];
  return {
    entries: kept.map((p) => p.entry),
    oldestOffset: kept.length > 0 ? kept[0]!.start : null,
    droppedOlder: parsed.length > kept.length,
  };
}

/** The branch dialog's window: entries projected down to row-renderable fields. */
export function parseWindow(buf: Buffer): Array<{ entry: TreeEntry; start: number }> {
  return windowLines(buf, parseProjectedEntry);
}

/** The chat transcript's window: entries kept whole (message bodies matter there). */
export function parseRawWindow(buf: Buffer): Array<{ entry: TranscriptEntry & { id: string }; start: number }> {
  return windowLines(buf, parseRawEntry);
}

export function pageFromWindow(buf: Buffer, budget: SessionPageBudget): WindowPage {
  return pageOfWindow(buf, budget, parseProjectedEntry);
}

export const projectedCodec: EntryCodec<TreeEntry> = { window: parseWindow, page: pageFromWindow };

export const rawCodec: EntryCodec<TranscriptEntry & { id: string }> = {
  window: parseRawWindow,
  page: (buf, budget) => pageOfWindow(buf, budget, parseRawEntry),
};
