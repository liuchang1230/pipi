/**
 * session-pages.ts — the branch dialog's session-file reader: the NEWEST page first,
 * older pages on demand, each one a bounded byte window.
 *
 * Why a page and not the file (docs/adr/0011-session-entry-paging.md): the dialog used
 * to read the whole JSONL and ship every entry to the renderer — measured 8 MB over IPC
 * for a 2763-entry session, and the long remote session that froze the app was 10-50x
 * that (60 s SFTP read, 1.3 GB main heap). A session file is append-only, so the recent
 * conversation is one ranged read away and the rest is only needed if the user asks.
 *
 * Interface (deep on purpose — callers never see byte offsets, line boundaries, channel
 * capabilities or the degraded paths):
 *   tail(path)              → the newest `maxEntries`/`maxBytes` entries, projected
 *   before(path, cursor)    → the page ending at the cursor the previous page returned
 *
 * Both return a page whose `cursor` is where to continue backwards (`null` = the file
 * start, i.e. nothing older). A page is cut on LINE boundaries, so a cache of pages can
 * be concatenated without repairing anything.
 *
 * Transport: byte ranges where the channel has them (local disk, WSL via UNC, SFTP —
 * all three implement `readRange`), one whole-file read where it does not (key-auth
 * `ssh cat`) — reported as `degraded: "whole-file-read"`, which is exactly the old
 * behaviour, so nothing regresses on those targets.
 *
 * The adaptive window (`maxBytes` → ×4 → `hardMaxBytes`) exists because one JSONL line
 * can be megabytes (measured 1.6 MB / 325 KB / 102 KB in the local sessions): a window
 * that lands inside such a line has no complete entry, and a fixed window would then
 * either skip the line or loop forever. Growing finds the line boundary; past the hard
 * cap the page says `window-too-large` and paging stops — bounded and honest, never a
 * loop. The same flag covers "this region cannot be framed at all" (a short read from a
 * file rewritten under us): what was framed is still returned, and paging stops instead
 * of splicing across a hole.
 */
import { PAGE_BUDGET, projectedCodec, type EntryCodec, type SessionPage, type SessionPageBudget, type SessionPageCursor, type SessionPageDegradation } from "../shared/session-page";
import type { TreeEntry } from "../shared/tree-build";
import { isTargetFsError, type TargetFs } from "./target-fs";

/** The byte primitives a page needs. Injected so the paging logic is testable without
 *  a channel, a network or an Electron app. */
export interface ByteSource {
  /** File size in bytes; `null` when the channel cannot report it. */
  size(path: string): Promise<number | null>;
  /** Bytes `[start, start + length)`. Throws {@link ByteRangeUnsupported} when this
   *  channel has no ranged read (the caller then falls back to a whole-file read). */
  read(path: string, start: number, length: number): Promise<Buffer>;
  /** The whole file — the degraded path only. */
  readAll(path: string): Promise<Buffer>;
}

/** A budget dimension: a finite positive integer, or the default when it is not. */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** The transport cannot read a byte range (`免密远程不支持分段读取`). */
export class ByteRangeUnsupported extends Error {
  constructor(message = "channel has no ranged read") {
    super(message);
    this.name = "ByteRangeUnsupported";
  }
}

export interface SessionPages<T extends { id: string } = TreeEntry> {
  /** The newest page (what the dialog shows on open). */
  tail(path: string, budget?: SessionPageBudget): Promise<SessionPage<T>>;
  /** The page that ends where `cursor` begins. */
  before(path: string, cursor: SessionPageCursor, budget?: SessionPageBudget): Promise<SessionPage<T>>;
  /**
   * The WHOLE file as one page — every entry, `eof`, no cursor. The expensive read this
   * engine exists to avoid, kept for the one caller that sometimes needs completeness
   * rather than latency (the chat transcript escalates to it for a small session whose tail
   * could not be framed). One whole-file read, at most one.
   */
  all(path: string, budget?: SessionPageBudget): Promise<SessionPage<T>>;
  /** File size, or `null` when the channel cannot tell. Lets a caller bound its own
   *  escalation ("only read everything if everything is small"). */
  size(path: string): Promise<number | null>;
}

export interface PageReaderOptions<T extends { id: string }> {
  /** What a line becomes. Defaults to the branch dialog's projection. */
  codec?: EntryCodec<T>;
  /**
   * A channel that cannot range-read (key-auth ssh) gets the WHOLE file in one call anyway,
   * so capping that page at `maxEntries` only hides entries the read already paid for. The
   * chat transcript wants the whole context then (its tail walk would otherwise re-read the
   * file page by page); the branch dialog keeps the cap, because a bounded first paint is
   * the whole point there.
   */
  wholeFileUncapped?: boolean;
}

/**
 * The byte window engine, parameterized by what a LINE becomes ({@link EntryCodec}): the
 * branch dialog projects entries (the default), the chat transcript keeps them whole. Both
 * callers get the same line-boundary cuts, bounded reads, adaptive growth and honest
 * degradation — the only difference is the shape handed to them.
 */
export function createSessionPages(source: ByteSource, opts?: PageReaderOptions<TreeEntry>): SessionPages<TreeEntry>;
export function createSessionPages<T extends { id: string }>(source: ByteSource, opts: PageReaderOptions<T>): SessionPages<T>;
export function createSessionPages<T extends { id: string }>(source: ByteSource, opts?: PageReaderOptions<T>): SessionPages<T> {
  const lines = (opts?.codec ?? projectedCodec) as EntryCodec<T>;
  const uncapped = opts?.wholeFileUncapped === true;

  /** A page over the bytes `[0, endByte)`; `endByte === null` means "to EOF". */
  /** A nonsense budget must not spin the main process: every dimension needs a floor.
   *  `Number.isFinite` is the guard that matters — `Math.floor(undefined)` is NaN, and a NaN
   *  dimension turns the fill loop into a no-op whose `newestFirst[-1]` deref throws. */
  function normalize(rawBudget: SessionPageBudget): SessionPageBudget {
    const maxBytes = positive(rawBudget.maxBytes, PAGE_BUDGET.maxBytes);
    return {
      maxEntries: positive(rawBudget.maxEntries, PAGE_BUDGET.maxEntries),
      maxBytes,
      maxPageBytes: Math.max(maxBytes, positive(rawBudget.maxPageBytes, PAGE_BUDGET.maxPageBytes)),
      hardMaxBytes: Math.max(maxBytes, positive(rawBudget.hardMaxBytes, PAGE_BUDGET.hardMaxBytes)),
    };
  }

  /** File size, or `null` when the channel cannot tell (an un-stat-able path cannot be
   *  ranged either, so callers read it all instead). */
  async function fileSize(path: string): Promise<number | null> {
    try {
      return await source.size(path);
    } catch {
      return null;
    }
  }

  async function readPage(path: string, endByte: number | null, rawBudget: SessionPageBudget): Promise<SessionPage<T>> {
    const budget = normalize(rawBudget);
    const size = await fileSize(path);
    if (size === null) return wholeFile(path, endByte, budget, "whole-file-read");
    const end = endByte === null ? size : Math.min(endByte, size);
    if (end <= 0) return { entries: [], cursor: null, eof: true, bytesRead: 0 };

    /** The byte the NEXT (older) page must end at — a line start, so no entry is ever
     *  split across pages. Starts at this page's own boundary and walks backwards. */
    let boundary = end;
    /** Newest-first accumulation, so filling the entry budget never reorders anything. */
    const newestFirst: T[] = [];
    let bytesRead = 0;
    let degraded: SessionPageDegradation | undefined;

    // One window per round trip, and keep going while the page still has room — a window
    // that lands inside a megabyte-long tool result yields few entries, and a first paint
    // with 1 row would be useless. Bounded by maxPageBytes, so a page can never turn into
    // "read the file after all".
    while (boundary > 0 && newestFirst.length < budget.maxEntries && bytesRead < budget.maxPageBytes) {
      const progress = await fillOneWindow();
      if (!progress) break;
    }

    if (degraded === "window-too-large") {
      // A single entry is bigger than the hard cap, or the region cannot be framed at all
      // (the file was rewritten mid-read). Keep whatever WAS framed — one huge OLD line
      // must not blank the recent conversation — and stop: no cursor, so the UI cannot
      // click its way into a loop, and nothing is silently skipped.
      return { entries: newestFirst.slice().reverse(), cursor: null, eof: false, degraded, bytesRead };
    }
    const eof = boundary <= 0;
    return {
      entries: newestFirst.slice().reverse(),
      cursor: eof ? null : { byteOffset: boundary, firstId: newestFirst[newestFirst.length - 1]!.id },
      eof,
      bytesRead,
      ...(degraded !== undefined ? { degraded } : {}),
    };

    /** Read ONE window backwards from `boundary` and fold it in. False = stop paging.
     *
     *  Growth is INCREMENTAL: a retry reads only the bytes it did not have yet and prepends
     *  them, so `bytesRead` is the transfer, not a sum of overlapping spans. (Measured on a
     *  real 10 MB session whose tail sat behind a 9 MB single line: growing x4 by re-reading
     *  the whole window transferred 37 MB for a 10 MB file.)
     *
     *  A growth step also has to fit the PAGE budget, so "one page" stays a bounded transfer
     * instead of "maxPageBytes plus one hardMaxBytes window". */
    async function fillOneWindow(): Promise<boolean> {
      let span = Math.min(budget.maxBytes, boundary);
      let start = boundary - span;
      let buf = await readAt(start, span);
      if (buf === null) return false;
      for (;;) {
        const parsed = lines.window(buf);
        if (parsed.length > 0) {
          const room = budget.maxEntries - newestFirst.length;
          const keep = parsed.slice(-room);
          for (let i = keep.length - 1; i >= 0; i -= 1) newestFirst.push(keep[i]!.entry);
          // The next page ends where the oldest KEPT entry's line starts.
          boundary = start + keep[0]!.start;
          return true;
        }
        if (start === 0) {
          boundary = 0; // the whole prefix parsed to nothing: empty or unreadable file
          return true;
        }
        const next = Math.min(span * 4, budget.hardMaxBytes, boundary);
        if (span >= budget.hardMaxBytes || span >= boundary || bytesRead + (next - span) > budget.maxPageBytes) {
          degraded = "window-too-large";
          return false;
        }
        // Prepend only the newly needed prefix; the bytes already held stay held.
        const grow = next - span;
        const more = await readAt(start - grow, grow);
        if (more === null) return false;
        buf = Buffer.concat([more, buf]);
        span = next;
        start -= grow;
      }
    }

    /** Read a window, folding in the channel difference. `null` = stop paging (the caller's
     *  `degraded` is already set). Short reads and no-range channels are handled here so the
     *  window loop below is just boundary arithmetic. */
    async function readAt(start: number, length: number): Promise<Buffer | null> {
      let buf: Buffer;
      try {
        buf = await readRange(path, start, length);
      } catch (e) {
        if (e instanceof ByteRangeUnsupported || (isTargetFsError(e) && e.kind === "transport")) {
          // No ranged read on this channel (key-auth ssh): one whole-file read, which is
          // exactly what this path did before pages existed.
          const whole = await wholeFile(path, endByte, budget, "whole-file-read");
          newestFirst.length = 0;
          for (let i = whole.entries.length - 1; i >= 0; i -= 1) newestFirst.push(whole.entries[i]!);
          boundary = whole.cursor?.byteOffset ?? 0;
          bytesRead += whole.bytesRead ?? 0; // the whole file WAS transferred: report it
          degraded = "whole-file-read";
          return null;
        }
        throw e;
      }
      bytesRead += buf.length; // count partial bytes too: they did cross the wire
      if (buf.length < length) {
        // The channel came up short (truncated/rewritten under us, or a torn read). The
        // window's NEWEST edge is mid-line, so accepting it would silently skip every entry
        // between that edge and the previous page's cursor. Stop honestly.
        degraded = "window-too-large";
        return null;
      }
      return buf;
    }
  }

  /** `length` bytes at `start`, retrying a PARTIAL read a bounded number of times — a
   *  channel may hand back fewer bytes than asked, and treating that as the window's edge
   *  would leave a hole. Zero bytes means "nothing there", which the caller detects. */
  async function readRange(path: string, start: number, length: number): Promise<Buffer> {
    let out = await source.read(path, start, length);
    for (let attempt = 0; attempt < 2 && out.length > 0 && out.length < length; attempt += 1) {
      const more = await source.read(path, start + out.length, length - out.length);
      if (more.length === 0) break;
      out = Buffer.concat([out, more]);
    }
    return out;
  }

  /** No ranged read: read it all once and cut `[0, endByte)` in memory. Slower, one
   *  page per file read — but it terminates (every page moves the cursor back) and it
   *  is what this channel did before pages existed. */
  async function wholeFile(path: string, endByte: number | null, budget: SessionPageBudget, degraded?: SessionPageDegradation): Promise<SessionPage<T>> {
    const all = await source.readAll(path);
    const end = endByte === null ? all.length : Math.min(endByte, all.length);
    const win = lines.page(all.subarray(0, end), uncapped ? { ...budget, maxEntries: Number.MAX_SAFE_INTEGER } : budget);
    const bytesRead = end;
    if (win.entries.length === 0) return { entries: [], cursor: null, eof: true, bytesRead, ...(degraded !== undefined ? { degraded } : {}) };
    const eof = !win.droppedOlder;
    return {
      entries: win.entries,
      cursor: eof ? null : { byteOffset: win.oldestOffset!, firstId: win.entries[0]!.id },
      eof,
      bytesRead,
      ...(degraded !== undefined ? { degraded } : {}),
    };
  }

  return {
    tail: (path, budget = PAGE_BUDGET) => readPage(path, null, budget),
    // `all` is uncapped by definition: it IS "read everything", so its page must hold every
    // entry — the caller uses it precisely when a bounded page was not enough.
    all: (path, budget = PAGE_BUDGET) => wholeFile(path, null, { ...normalize(budget), maxEntries: Number.MAX_SAFE_INTEGER }, undefined),
    size: fileSize,
    before: (path, cursor, budget = PAGE_BUDGET) =>
      cursor.byteOffset <= 0
        ? Promise.resolve({ entries: [], cursor: null, eof: true, bytesRead: 0 } as SessionPage<T>)
        : readPage(path, cursor.byteOffset, budget),
  };
}

/**
 * The production adapter: TargetFs is already the one place that knows which channel
 * (local / WSL-UNC / SFTP / ssh) a path lives on, so the page reader takes its bytes
 * from there rather than re-deriving the channel rule (docs/adr/0001-target-fs-seam.md).
 */
export function targetFsByteSource(fs: TargetFs): ByteSource {
  return {
    size: (path) => fs.size(path),
    read: async (path, start, length) => {
      try {
        return await fs.readBytes(path, start, length);
      } catch (e) {
        // The ssh channel answers "免密远程不支持分段读取" as a transport error; the page
        // reader turns that into the whole-file fallback instead of a failure.
        if (isTargetFsError(e) && e.kind === "transport") throw new ByteRangeUnsupported(e.message);
        throw e;
      }
    },
    readAll: async (path) => Buffer.from(await fs.readText(path), "utf8"),
  };
}

export { PAGE_BUDGET };
export type { SessionPage, SessionPageBudget, SessionPageCursor, SessionPageDegradation };
