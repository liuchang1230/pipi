/**
 * session-pages — the branch dialog's page reader (docs/adr/0011-session-entry-paging.md).
 *
 * Pins the properties the dialog's open latency depends on: a page is a BOUNDED read
 * (never the whole file), pages tile the file exactly (no gaps, no duplicates), a single
 * enormous JSONL line is either included by growing the window or stops paging honestly,
 * and a channel without ranged reads degrades to one whole-file read instead of failing.
 */
import { describe, expect, it } from "vitest";
import { ByteRangeUnsupported, createSessionPages, type ByteSource } from "../session-pages";
import { PAGE_BUDGET, type SessionPageBudget } from "../../shared/session-page";

const line = (o: unknown) => JSON.stringify(o);
const msg = (i: number, body = `p${i}`) => ({ type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, message: { role: "user", content: body } });

/** A ByteSource over a buffer that records every read (so "bounded" is measurable). */
function fakeSource(content: string, opts: { rangeable?: boolean; size?: boolean } = {}): ByteSource & { reads: Array<[number, number]> } {
  const buf = Buffer.from(content, "utf8");
  const reads: Array<[number, number]> = [];
  return {
    reads,
    size: async () => (opts.size === false ? null : buf.length),
    read: async (_path, start, length) => {
      if (opts.rangeable === false) throw new ByteRangeUnsupported("免密远程不支持分段读取");
      reads.push([start, length]);
      return buf.subarray(start, start + length);
    },
    readAll: async () => buf,
  };
}

function fakeProbedSource(content: string, onRead: (start: number, length: number) => void): ByteSource {
  const buf = Buffer.from(content, "utf8");
  return {
    size: async () => buf.length,
    read: async (_path, start, length) => {
      onRead(start, length);
      return buf.subarray(start, start + length);
    },
    readAll: async () => buf,
  };
}

const small: SessionPageBudget = { maxEntries: 3, maxBytes: 4096, maxPageBytes: 16_384, hardMaxBytes: 1_000_000 };

describe("session pages", () => {
  it("serves a small session in one page, EOF included", async () => {
    const content = Array.from({ length: 5 }, (_, i) => line(msg(i))).join("\n") + "\n";
    const pages = createSessionPages(fakeSource(content));
    const page = await pages.tail("s.jsonl", { ...small, maxEntries: 10 });
    expect(page.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect(page.eof).toBe(true);
    expect(page.cursor).toBeNull();
  });

  it("never reads more than the byte budget from a large session", async () => {
    const content = Array.from({ length: 5000 }, (_, i) => line(msg(i, "x".repeat(200)))).join("\n") + "\n";
    const source = fakeSource(content);
    const page = await createSessionPages(source).tail("s.jsonl", PAGE_BUDGET);
    expect(page.entries.length).toBe(400);
    expect(page.entries[399]!.id).toBe("e4999");
    expect(source.reads.length).toBe(1);
    const [start, length] = source.reads[0]!;
    expect(length).toBeLessThanOrEqual(PAGE_BUDGET.maxBytes);
    expect(start + length).toBe(Buffer.byteLength(content));
  });

  it("grows a window without re-reading the bytes it already holds", async () => {
    // A window that lands inside a megabyte-long line has no complete entry, so it grows.
    // Growing by re-reading the whole window made a real 10 MB session transfer 37 MB.
    const giant = JSON.stringify({ type: "message", id: "huge", parentId: "e0", message: { role: "toolResult", content: [{ type: "text", text: "z".repeat(120_000) }] } });
    const content = `${line({ type: "session", id: "s0" })}\n${line(msg(0))}\n${giant}\n${line(msg(2))}\n`;
    const spans: Array<[number, number]> = [];
    const buf = Buffer.from(content, "utf8");
    const source: ByteSource = {
      size: async () => buf.length,
      read: async (_p, start, length) => {
        const got = buf.subarray(start, start + length);
        spans.push([start, got.length]);
        return got;
      },
      readAll: async () => buf,
    };
    const page = await createSessionPages(source).tail("s.jsonl", { maxEntries: 10, maxBytes: 4_096, maxPageBytes: 400_000, hardMaxBytes: 400_000 });
    expect(page.entries.map((e) => e.id)).toEqual(["e0", "huge", "e2"]);
    // The transfer stays proportional to the file: before incremental growth this window
    // re-read its whole span on every retry and transferred ~3.6x the file size.
    const covered = spans.reduce((n, [, len]) => n + len, 0);
    expect(covered).toBeLessThan(buf.length * 1.5);
    expect(page.bytesRead).toBe(covered);
  });

  it("keeps a page inside its byte budget even while growing", async () => {
    const giant = JSON.stringify({ type: "message", id: "huge", parentId: "e0", message: { role: "toolResult", content: [{ type: "text", text: "z".repeat(80_000) }] } });
    const content = `${line({ type: "session", id: "s0" })}\n${line(msg(0))}\n${giant}\n${line(msg(2))}\n`;
    const page = await createSessionPages(fakeSource(content)).tail("s.jsonl", { maxEntries: 10, maxBytes: 4_096, maxPageBytes: 20_000, hardMaxBytes: 400_000 });
    // The budget is a transfer ceiling: at most the budget plus the one read that discovered
    // it was exhausted — never "budget plus a whole hardMaxBytes window".
    expect(page.bytesRead!).toBeLessThanOrEqual(20_000 + 4_096);
    expect(page.degraded).toBe("window-too-large");
    expect(page.entries.length).toBeGreaterThan(0); // what was framed is kept
  });

  it("reads the whole file in one `all` call, uncapped and complete", async () => {
    const content = Array.from({ length: 900 }, (_, i) => line(msg(i))).join("\n") + "\n";
    const source = fakeSource(content);
    const pages = createSessionPages(source);
    const all = await pages.all("s.jsonl", small); // maxEntries 3 — `all` ignores it by definition
    expect(all.entries).toHaveLength(900);
    expect(all.cursor).toBeNull();
    expect(all.eof).toBe(true);
    expect(all.bytesRead).toBe(Buffer.byteLength(content));
    expect(source.reads).toEqual([]); // whole-file path, no ranged reads
    await expect(pages.size("s.jsonl")).resolves.toBe(Buffer.byteLength(content));
  });

  it("reports the whole-file transfer when a ranged read turns out to be unsupported", async () => {
    // Known size (so the engine tries a range), but the channel throws: the fallback read
    // the WHOLE file, and the page's byte count must say so — it is the "bounded read"
    // claim's only evidence in logs and tests.
    const content = Array.from({ length: 20 }, (_, i) => line(msg(i))).join("\n") + "\n";
    const buf = Buffer.from(content, "utf8");
    const source: ByteSource = {
      size: async () => buf.length,
      read: async () => {
        throw new ByteRangeUnsupported("免密远程不支持分段读取");
      },
      readAll: async () => buf,
    };
    const page = await createSessionPages(source).tail("s.jsonl", small);
    expect(page.degraded).toBe("whole-file-read");
    expect(page.bytesRead).toBe(buf.length);
  });

  it("counts the bytes of a short read too (they crossed the wire)", async () => {
    const buf = Buffer.from(Array.from({ length: 8 }, (_, i) => line(msg(i))).join("\n") + "\n", "utf8");
    const source: ByteSource = {
      size: async () => buf.length,
      read: async (_p, start, length) => buf.subarray(start, start + Math.min(length, 10)), // always short
      readAll: async () => buf,
    };
    const page = await createSessionPages(source).tail("s.jsonl", { maxEntries: 3, maxBytes: 64, maxPageBytes: 512, hardMaxBytes: 512 });
    expect(page.degraded).toBe("window-too-large");
    expect(page.bytesRead!).toBeGreaterThan(0);
  });

  it("reports a size of null when the channel cannot stat", async () => {
    const page = await createSessionPages(fakeSource(line(msg(0)) + "\n", { size: false })).tail("s.jsonl", small);
    const pages = createSessionPages(fakeSource("", { size: false }));
    await expect(pages.size("s.jsonl")).resolves.toBeNull();
    expect(page.degraded).toBe("whole-file-read");
  });

  it("walks backwards page by page with no gap and no duplicate", async () => {
    const all = Array.from({ length: 1001 }, (_, i) => line(msg(i, "y".repeat(50)))).join("\n") + "\n";
    const pages = createSessionPages(fakeSource(all));
    const collected: string[] = [];
    let page = await pages.tail("s.jsonl", small);
    let guard = 0;
    for (;;) {
      collected.unshift(...page.entries.map((e) => e.id));
      if (page.cursor === null) break;
      page = await pages.before("s.jsonl", page.cursor, small);
      if (++guard > 2000) throw new Error("paging did not terminate");
    }
    expect(page.eof).toBe(true);
    expect(collected).toEqual(Array.from({ length: 1001 }, (_, i) => `e${i}`));
  });

  it("grows the window when it lands inside one enormous line, and still gets the line", async () => {
    const huge = line(msg(1, "z".repeat(50_000)));
    const content = [line(msg(0)), huge, line(msg(2))].join("\n") + "\n";
    const reads: Array<[number, number]> = [];
    const source = fakeProbedSource(content, (start, length) => reads.push([start, length]));
    const page = await createSessionPages(source).tail("s.jsonl", { maxEntries: 3, maxBytes: 4096, maxPageBytes: 1_000_000, hardMaxBytes: 1_000_000 });
    expect(page.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2"]);
    expect(page.eof).toBe(true);
    // More than one attempt: the first window had no complete line before the giant one.
    expect(reads.length).toBeGreaterThan(1);
  });

  it("stops instead of looping when no line boundary exists within the hard cap", async () => {
    const content = "x".repeat(200_000); // one line larger than hardMaxBytes
    const source = fakeSource(content);
    const page = await createSessionPages(source).tail("s.jsonl", { maxEntries: 3, maxBytes: 4096, maxPageBytes: 8192, hardMaxBytes: 8192 });
    expect(page.entries).toEqual([]);
    expect(page.eof).toBe(false);
    expect(page.cursor).toBeNull();
    expect(page.degraded).toBe("window-too-large");
  });

  it("keeps the entries it framed when an OLDER line is too big to frame", async () => {
    // The recent conversation must not blank out because some older line is enormous:
    // dropping a valid page would show an empty tree with a "too large" note.
    const smalls = Array.from({ length: 10 }, (_, i) => line(msg(i))).join("\n");
    const huge = JSON.stringify({ type: "message", id: "huge", parentId: null, message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(200_000) }] } });
    const source = fakeSource(`${huge}\n${smalls}\n`);
    const page = await createSessionPages(source).tail("s.jsonl", { maxEntries: 20, maxBytes: 4096, maxPageBytes: 8192, hardMaxBytes: 8192 });
    expect(page.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
    expect(page.degraded).toBe("window-too-large");
    // No cursor: paging stops here instead of offering a boundary it cannot compute.
    expect(page.cursor).toBeNull();
    expect(page.eof).toBe(false);
  });

  it("stops instead of splicing across a short read (file rewritten under us)", async () => {
    // Byte 2 of the walk comes up short, so the window's newest edge is mid-line: accepting
    // it would skip every entry between that edge and the previous page's cursor.
    const buf = Buffer.from(Array.from({ length: 12 }, (_, i) => line(msg(i))).join("\n") + "\n", "utf8");
    let calls = 0;
    const source: ByteSource = {
      size: async () => buf.length,
      read: async (_path, start, length) => {
        calls += 1;
        const cap = calls === 1 ? length : Math.min(length, 50); // torn from the 2nd read on
        return buf.subarray(start, start + cap);
      },
      readAll: async () => buf,
    };
    const page = await createSessionPages(source).tail("s.jsonl", { maxEntries: 20, maxBytes: 200, maxPageBytes: 1000, hardMaxBytes: 1000 });
    expect(page.entries.map((e) => e.id)).toEqual(["e10", "e11"]); // what was framed is still returned
    expect(page.entries[page.entries.length - 1]!.id).toBe("e11"); // …including the newest
    expect(page.cursor).toBeNull();
    expect(page.degraded).toBe("window-too-large");
  });

  it("retries a partial read instead of treating it as the window edge", async () => {
    const buf = Buffer.from(Array.from({ length: 6 }, (_, i) => line(msg(i))).join("\n") + "\n", "utf8");
    let calls = 0;
    const source: ByteSource = {
      size: async () => buf.length,
      read: async (_path, start, length) => {
        calls += 1;
        return calls === 1 ? buf.subarray(start, start + 1) : buf.subarray(start, start + length);
      },
      readAll: async () => buf,
    };
    const page = await createSessionPages(source).tail("s.jsonl", small);
    expect(page.entries.map((e) => e.id)).toEqual(["e3", "e4", "e5"]);
    expect(calls).toBeGreaterThan(1);
  });

  it("falls back to the default budget when a dimension is not a number", async () => {
    const content = Array.from({ length: 4 }, (_, i) => line(msg(i))).join("\n") + "\n";
    const broken = { maxEntries: Number.NaN, maxBytes: undefined, maxPageBytes: undefined, hardMaxBytes: undefined } as unknown as SessionPageBudget;
    const page = await createSessionPages(fakeSource(content)).tail("s.jsonl", broken);
    expect(page.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3"]);
  });

  it("degrades to one whole-file read where the channel cannot range", async () => {
    const content = Array.from({ length: 20 }, (_, i) => line(msg(i))).join("\n") + "\n";
    const pages = createSessionPages(fakeSource(content, { rangeable: false }));
    const page = await pages.tail("s.jsonl", small);
    expect(page.entries.map((e) => e.id)).toEqual(["e17", "e18", "e19"]);
    expect(page.degraded).toBe("whole-file-read");
    // …and the older page still works (every page moves the cursor back).
    const older = await pages.before("s.jsonl", page.cursor!, small);
    expect(older.entries.map((e) => e.id)).toEqual(["e14", "e15", "e16"]);
    expect(older.degraded).toBe("whole-file-read");
  });

  it("degrades when the channel cannot report a size", async () => {
    const content = Array.from({ length: 4 }, (_, i) => line(msg(i))).join("\n") + "\n";
    const page = await createSessionPages(fakeSource(content, { size: false })).tail("s.jsonl", small);
    expect(page.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(page.degraded).toBe("whole-file-read");
  });

  it("stops at byte offset 0 without touching the file again", async () => {
    const source = fakeSource("whatever\n");
    const page = await createSessionPages(source).before("s.jsonl", { byteOffset: 0, firstId: "e0" }, small);
    expect(page).toEqual({ entries: [], cursor: null, eof: true, bytesRead: 0 });
    expect(source.reads).toEqual([]);
  });

  it("treats an empty file as an empty, finished page", async () => {
    const page = await createSessionPages(fakeSource("")).tail("s.jsonl", small);
    expect(page).toEqual({ entries: [], cursor: null, eof: true, bytesRead: 0 });
  });

  it("returns projected entries, not raw ones (the payload is what gets small)", async () => {
    const fat = [{ type: "message", id: "e0", parentId: null, message: { role: "toolResult", toolCallId: "tc", toolName: "bash", content: [{ type: "text", text: "o".repeat(200_000) }] } }];
    const content = fat.map(line).join("\n") + "\n";
    const page = await createSessionPages(fakeSource(content)).tail("s.jsonl", { maxEntries: 10, maxBytes: 1_000_000, maxPageBytes: 2_000_000, hardMaxBytes: 2_000_000 });
    expect(page.entries).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(page.entries))).toBeLessThan(1000);
  });
});
