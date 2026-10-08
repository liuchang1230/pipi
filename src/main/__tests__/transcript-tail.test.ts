/**
 * transcript-tail — the chat's windowed reader (docs/adr/0012-transcript-tail-window.md).
 *
 * The property that matters: resolving the newest PAGE(s) of a session file must give the
 * SAME messages the whole-file reader would give for that tail — the chat shows the last
 * 120 messages, and reading 60 MB to slice them off is what made opening a long session take
 * a minute. These tests pin the two things that could silently break it:
 *   1. the window's resolve is a SUFFIX of the full resolve (no invented/reordered
 *      messages, no dropped newest ones), and
 *   2. `complete` is honest — it decides whether the caller may still check the resolved
 *      length against pi's message count, and whether the file start was actually reached.
 */
import { describe, expect, it } from "vitest";
import { ByteRangeUnsupported, createSessionPages, type ByteSource } from "../session-pages";
import { rawCodec } from "../../shared/session-page";
import { mergeRawEntries, resolveTranscriptAttempt, transcriptFromContent, transcriptTailFromSource, TRANSCRIPT_TAIL_MIN_MESSAGES, type TranscriptWindow } from "../transcript-from-file";
import type { TranscriptEntry } from "../../shared/transcript";

const line = (o: unknown) => JSON.stringify(o);
const userMsg = (i: number, body = `m${i}`) => ({ type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(), message: { role: "user", content: body } });
/** A tool-heavy pair: what a real session looks like (tool results are 65-73% of the bytes). */
const toolPair = (i: number) => [
  { type: "message", id: `a${i}`, parentId: `e${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "bash", arguments: { command: `echo ${i}` } }] } },
  { type: "message", id: `t${i}`, parentId: `a${i}`, message: { role: "toolResult", toolCallId: `tc${i}`, toolName: "bash", content: [{ type: "text", text: `out-${i}-${"x".repeat(2_000)}` }] } },
];

function chain(count: number): string {
  const lines: string[] = [line({ type: "session", id: "s0", version: 3, cwd: "/tmp" })];
  let parent = "s0";
  for (let i = 0; i < count; i += 1) {
    const e = userMsg(i);
    e.parentId = parent;
    parent = e.id;
    lines.push(line(e));
  }
  return lines.join("\n") + "\n";
}

/** A source that records every read, so "bounded" is measurable. */
function countingSource(content: string, opts: { rangeable?: boolean } = {}): ByteSource & { reads: number; bytes: number } {
  const buf = Buffer.from(content, "utf8");
  const src = {
    reads: 0,
    bytes: 0,
    size: async () => buf.length,
    read: async (_path: string, start: number, length: number) => {
      src.reads += 1;
      src.bytes += Math.min(length, Math.max(0, buf.length - start));
      return buf.subarray(start, start + length);
    },
    readAll: async () => buf,
  };
  void opts;
  return src;
}

const reader = (source: ByteSource, uncapped = true) =>
  createSessionPages(source, { codec: rawCodec, wholeFileUncapped: uncapped });

describe("transcriptTailFromSource", () => {
  it("resolves the same messages as the whole file, for the tail the chat shows", async () => {
    const content = chain(400);
    const all = (await transcriptFromContent(content))!;
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", { minMessages: TRANSCRIPT_TAIL_MIN_MESSAGES }))!;
    // The full file is 400 messages; the window must hold at least the last 120, and its
    // resolve must be exactly that suffix — not a reordered or invented list.
    expect(window.messages.length).toBeGreaterThanOrEqual(TRANSCRIPT_TAIL_MIN_MESSAGES);
    expect(window.messages).toEqual(all.slice(-window.messages.length));
    expect(window.lastId).toBe("e399");
  });

  it("stops as soon as enough messages are resolved, instead of reading the file", async () => {
    // 60k entries (~8 MB): the window budget is 1.5 MB per read, so "bounded" means the read
    // tracks the BUDGET, not the file.
    const content = chain(60_000);
    const source = countingSource(content);
    const window = (await transcriptTailFromSource(reader(source), "s.jsonl", { minMessages: 40 }))!;
    expect(window.messages).toEqual((await transcriptFromContent(content))!.slice(-window.messages.length));
    expect(source.reads).toBe(1);
    expect(source.bytes).toBeLessThanOrEqual(1_500_000);
    expect(source.bytes).toBeLessThan(Buffer.byteLength(content) / 4);
  });

  it("marks a window that did not reach the file start as incomplete", async () => {
    const content = chain(2000);
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", { minMessages: 40 }))!;
    expect(window.complete).toBe(false);
  });

  it("marks a session that fits one page as complete (the strict count check still applies)", async () => {
    const content = chain(20);
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", { minMessages: TRANSCRIPT_TAIL_MIN_MESSAGES }))!;
    expect(window.complete).toBe(true);
    expect(window.messages).toEqual((await transcriptFromContent(content))!);
  });

  it("treats a compaction whose kept entries are inside the window as the whole context", async () => {
    // 600 messages (~200 KB), a compaction at e300 keeping e290: the window covers the last
    // 400 entries and stops FAR from the file start, so `complete` can only come from the
    // compaction boundary — and then the window's resolve must equal the whole-file resolve
    // (everything older than e290 is not context any more).
    const lines: string[] = [line({ type: "session", id: "s0", version: 3, cwd: "/tmp" })];
    let parent = "s0";
    for (let i = 0; i < 600; i += 1) {
      const e = userMsg(i);
      e.parentId = parent;
      parent = e.id;
      if (i === 300) {
        lines.push(line({ type: "compaction", id: "c1", parentId: "e299", summary: "so far", firstKeptEntryId: "e290", tokensBefore: 1234 }));
        parent = "c1";
      }
      lines.push(line(e));
    }
    const content = lines.join("\n") + "\n";
    const all = (await transcriptFromContent(content))!;
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", {
      minMessages: TRANSCRIPT_TAIL_MIN_MESSAGES,
      budget: { maxEntries: 400, maxBytes: 64_000, maxPageBytes: 256_000, hardMaxBytes: 1_000_000 },
    }))!;
    expect(window.complete).toBe(true);
    expect(window.messages).toEqual(all);
    expect(window.entries[0]!.id).not.toBe("e0"); // the file start was NOT reached
  });

  it("does not call a DEGRADED window complete (a page with no cursor is not the file start)", async () => {
    // Regression: a page that degraded on an unframeable region reports `cursor: null` so the
    // UI cannot page into a loop. Reading that as "reached the file start" made the reader
    // claim completeness for a truncated window — and then the handler's count check rejected
    // the transcript (`file behind pi state`), so the fast path silently never applied.
    const smalls = Array.from({ length: 5 }, (_, i) => line(userMsg(i))).join("\n");
    const giant = "y".repeat(400_000); // far past the tiny hardMaxBytes below
    const content = `${line({ type: "session", id: "s0", version: 3 })}\n${line(userMsg(0, giant))}\n${smalls}\n`;
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", {
      minMessages: 100,
      maxPages: 1,
      escalateMaxBytes: 1, // no escalation: assert the honest-suffix behaviour
      budget: { maxEntries: 10, maxBytes: 4_096, maxPageBytes: 8_192, hardMaxBytes: 8_192 },
    }))!;
    expect(window.degraded).toBe("window-too-large");
    expect(window.complete).toBe(false);
    expect(window.messages.length).toBeGreaterThan(0); // what was framed is still returned
  });

  it("a compaction whose kept entry is OUTSIDE the window gives the post-compaction tail", async () => {
    // Reviewer-found shape: the window holds the compaction but not its `firstKeptEntryId`.
    // pi's `buildContextEntries` then hoists the summary and drops every pre-compaction entry
    // (kept or not), so the resolve is `[summary, post-compaction...]` — NOT a raw suffix of
    // the whole context. Pin that exactly, so the documented invariant cannot drift.
    const lines: string[] = [line({ type: "session", id: "s0", version: 3 })];
    let parent = "s0";
    for (let i = 0; i < 200; i += 1) {
      const e = userMsg(i);
      e.parentId = parent;
      parent = e.id;
      lines.push(line(e));
    }
    lines.push(line({ type: "compaction", id: "c1", parentId: "e199", summary: "so far", firstKeptEntryId: "e150", tokensBefore: 1 }));
    parent = "c1";
    for (let i = 200; i < 206; i += 1) {
      const e = userMsg(i);
      e.parentId = parent;
      parent = e.id;
      lines.push(line(e));
    }
    const content = lines.join("\n") + "\n";
    const full = (await transcriptFromContent(content))!;
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", {
      minMessages: 120, // unreachable: only 6 messages follow the compaction
      maxPages: 2,
      escalateMaxBytes: 1, // no escalation → assert the honest-window behaviour
      budget: { maxEntries: 5, maxBytes: 4_096, maxPageBytes: 32_000, hardMaxBytes: 64_000 },
    }))!;
    expect(window.complete).toBe(false); // the kept entry is outside → not the context
    const roles = (ms: unknown[]) => ms.map((m) => (m as { role?: string }).role);
    expect(roles(window.messages)[0]).toBe("compactionSummary");
    // Everything after the hoisted summary is a suffix of the whole context…
    expect(window.messages.slice(1)).toEqual(full.slice(-(window.messages.length - 1)));
    // …which is what the chat renders: a summary row, then the newest messages.
    expect((window.messages[1] as { content?: unknown }).content).toBe("m200");
  });

  it("does not let a SIDE-BRANCH compaction claim completeness", async () => {
    // The window holds a compaction whose kept id is inside it — but that compaction is not on
    // the leaf's path (it hangs off an earlier entry), so the resolver drops nothing and the
    // resolve is still a SUFFIX of the context (the file start is outside the window). An
    // id-presence check would call that "complete" and then fail the count check.
    const lines: string[] = [line({ type: "session", id: "s0", version: 3 })];
    let parent = "s0";
    for (let i = 0; i < 300; i += 1) {
      const e = userMsg(i);
      e.parentId = parent;
      parent = e.id;
      lines.push(line(e));
    }
    lines.push(line({ type: "compaction", id: "cside", parentId: "e299", summary: "side", firstKeptEntryId: "e200" }));
    parent = "e299";
    for (let i = 300; i < 500; i += 1) {
      const e = userMsg(i);
      e.parentId = parent;
      parent = e.id;
      lines.push(line(e));
    }
    const content = lines.join("\n") + "\n";
    const full = (await transcriptFromContent(content))!;
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", {
      minMessages: 1,
      escalateMaxBytes: 1,
      budget: { maxEntries: 400, maxBytes: 200_000, maxPageBytes: 200_000, hardMaxBytes: 200_000 },
    }))!;
    expect(window.entries.some((e) => e.id === "cside")).toBe(true); // the window DID see it
    expect(window.complete).toBe(false); // …but it is not on the leaf path
    expect(window.messages).toEqual(full.slice(-window.messages.length));
  });

  it("escalates to one complete read when a small session's tail cannot be framed", async () => {
    // A single enormous line can block the window entirely. For a small session, showing a
    // handful of messages would be a regression, so the reader reads it all once — the cost
    // every open used to pay — and is then complete (so the count check applies again).
    const content = chain(2000);
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", {
      minMessages: 1500, // unreachable inside the page cap
      maxPages: 2,
      budget: { maxEntries: 50, maxBytes: 8_000, maxPageBytes: 32_000, hardMaxBytes: 64_000 },
    }))!;
    expect(window.complete).toBe(true);
    expect(window.messages).toEqual((await transcriptFromContent(content))!);
  });

  it("stops with an honest suffix when the session is too big to escalate", async () => {
    const content = chain(2000);
    const window = (await transcriptTailFromSource(reader(countingSource(content)), "s.jsonl", {
      minMessages: 1500,
      maxPages: 2,
      escalateMaxBytes: 1_000, // "never read this one completely"
      budget: { maxEntries: 50, maxBytes: 8_000, maxPageBytes: 32_000, hardMaxBytes: 64_000 },
    }))!;
    expect(window.complete).toBe(false);
    expect(window.messages.length).toBeLessThan(1500);
    expect(window.messages).toEqual((await transcriptFromContent(content))!.slice(-window.messages.length));
  });

  it("reads the whole context in ONE call where the channel cannot range-read", async () => {
    // Key-auth ssh: the engine's whole-file fallback. The reader must not walk page by page
    // (each page would re-read the file) and must not silently cap the context.
    const content = chain(1200);
    const buf = Buffer.from(content, "utf8");
    let rangeAttempts = 0;
    let wholeReads = 0;
    const source: ByteSource = {
      size: async () => buf.length,
      read: async () => {
        rangeAttempts += 1; // how the engine learns ranges are unsupported
        throw new ByteRangeUnsupported("免密远程不支持分段读取");
      },
      readAll: async () => {
        wholeReads += 1;
        return buf;
      },
    };
    const window = (await transcriptTailFromSource(reader(source), "s.jsonl", { minMessages: TRANSCRIPT_TAIL_MIN_MESSAGES }))!;
    expect(window.complete).toBe(true);
    expect(window.messages).toEqual((await transcriptFromContent(content))!);
    expect(rangeAttempts).toBe(1);
    expect(wholeReads).toBe(1); // ONE whole-file read: no page-by-page walk of a no-range channel
  });

  it("returns null for a file with nothing usable, so the caller can fall back", async () => {
    const window = await transcriptTailFromSource(reader(countingSource("")), "s.jsonl");
    expect(window).toBeNull();
  });
});

describe("resolveTranscriptAttempt", () => {
  const entry = (id: string, parentId: string | null): TranscriptEntry & { id: string } => ({ type: "message", id, parentId, message: { role: "user", content: id } });
  /** A window over e0→e2 with all three resolved, ready for the attempt helper's inputs. */
  const windowOf = (ids: string[], opts: { complete?: boolean } = {}): TranscriptWindow => {
    const entries = ids.map((id, i) => entry(id, i === 0 ? null : ids[i - 1]!));
    return { entries, messages: entries.map((e) => e.message), complete: opts.complete ?? false, lastId: ids[ids.length - 1] ?? null };
  };

  it("keeps the historical count check when the window IS the whole context", () => {
    const window = windowOf(["e0", "e1", "e2"], { complete: true });
    const bad = resolveTranscriptAttempt({ window, tip: null, expected: 9 });
    expect(bad).toEqual({ ok: false, reason: "file behind pi state (3 != 9)" });
    const good = resolveTranscriptAttempt({ window, tip: null, expected: 3 });
    expect(good).toMatchObject({ ok: true, total: 3 });
  });

  it("accepts a suffix window and reports pi's count as the total", () => {
    const attempt = resolveTranscriptAttempt({ window: windowOf(["e0", "e1", "e2"]), tip: null, expected: 900 });
    expect(attempt).toMatchObject({ ok: true, total: 900 });
    expect((attempt as { messages: unknown[] }).messages).toHaveLength(3);
  });

  it("lets the tip probe repair and re-point the window", () => {
    // pi's leaf is e9, newer than anything the file window held, and the probe delivered it.
    const tipEntry = entry("e9", "e2");
    const attempt = resolveTranscriptAttempt({
      window: windowOf(["e0", "e1", "e2"]),
      tip: { entries: [tipEntry], leafId: "e9" },
      expected: 900,
    });
    expect(attempt).toMatchObject({ ok: true, total: 900 });
    expect((attempt as { messages: unknown[] }).messages).toHaveLength(4);
  });

  it("refuses a probe leaf it does not hold (a navigation deeper than the window)", () => {
    // `sessionContextMessages` falls back to the NEWEST entry by position when the leaf is
    // unknown — i.e. the branch the user navigated away from. Serving that as `ok:true` was
    // a regression of the old length check, so the attempt refuses it and the caller falls
    // back to `get_messages`.
    const attempt = resolveTranscriptAttempt({
      window: windowOf(["e0", "e1", "e2"]),
      tip: { entries: [], leafId: "elsewhere" },
      expected: 5,
    });
    expect(attempt).toEqual({ ok: false, reason: "leaf outside window" });
  });

  it("uses the newest merged entry when the probe answered without a leaf id", () => {
    const window = windowOf(["e0", "e1", "e2"]);
    const attempt = resolveTranscriptAttempt({ window, tip: { entries: [entry("e9", "e2")], leafId: null }, expected: 900 });
    expect(attempt).toMatchObject({ ok: true, total: 900 });
    // e9 (from the probe) is the leaf now, so all four messages resolve — resolving from
    // `win.lastId` would have dropped it.
    expect((attempt as { messages: unknown[] }).messages).toHaveLength(4);
  });

  it("serves a window that the probe could not verify (pi gone: the file is all we have)", () => {
    // Deliberate contract (docs/adr/0012): with an incomplete window and NO probe answer we
    // still serve the on-disk tail. The fallback (`get_messages`) needs the very same RPC
    // session the probe just failed on, so refusing here would leave the chat empty instead
    // of showing the file's newest messages; the live stream reconciles the tip once pi is
    // back. Observable in the log line (`tip=-`).
    const attempt = resolveTranscriptAttempt({ window: windowOf(["e0", "e1", "e2"]), tip: null, expected: 900 });
    expect(attempt).toMatchObject({ ok: true, total: 900 });
  });

  it("slices the requested tail and refuses an empty window (the caller then reads the file)", () => {
    expect(resolveTranscriptAttempt({ window: windowOf(["e0", "e1", "e2"]), tip: null, expected: 3, tail: 2 })).toMatchObject({ ok: true, messages: ["e1", "e2"].map((id) => ({ role: "user", content: id })) });
    expect(resolveTranscriptAttempt({ window: null, tip: null, expected: 0 })).toEqual({ ok: false, reason: "empty transcript" });
  });
});

describe("mergeRawEntries", () => {
  const e = (id: string): TranscriptEntry & { id: string } => ({ type: "message", id, parentId: null, message: { role: "user", content: id } });

  it("appends what the window did not have, in order", () => {
    expect(mergeRawEntries([e("a"), e("b")], [e("c"), e("d")]).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops the boundary entry pi re-sends", () => {
    expect(mergeRawEntries([e("a"), e("b")], [e("b"), e("c")]).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("copies when there is nothing to add (callers compare identities)", () => {
    const base = [e("a")];
    const merged = mergeRawEntries(base, []);
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });
});
