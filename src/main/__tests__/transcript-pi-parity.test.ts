// DIFFERENTIAL drift alarm: our transcript resolver must produce EXACTLY what
// pi produces for the same session file.
//
// `src/shared/transcript.ts` deliberately MIRRORS pi's resolution
// (`buildContextEntries` + `sessionEntryToContextMessages`) instead of importing
// pi — importing it would pull pi's whole graph into the main process (the
// memory cost this work exists to avoid), and `session-list.ts` already
// established "parse the JSONL ourselves so SDK changes cannot break us".
// Mirroring means drift is possible, so pi itself is used as a test-time ORACLE:
// if a pi upgrade changes compaction or message semantics, this fails loudly
// instead of silently showing wrong history.
//
// The fixture is synthetic and deterministic (no user files), and covers every
// branch of the mirror: header, model_change, message, compaction (with a
// firstKeptEntryId mid-path), custom_message, branch_summary, and null content.
import { describe, expect, it } from "vitest";
import * as pi from "@earendil-works/pi-coding-agent";
import { sessionContextMessages, type TranscriptEntry } from "../../shared/transcript";
import { parseTreeEntries } from "../tree-from-file";
import { transcriptFromContent } from "../transcript-from-file";

// pi re-exports these from dist/index.js at RUNTIME, but its bundled .d.ts does
// not declare them — so the oracle is typed locally rather than deep-importing
// an internal path (which the package's exports map forbids anyway).
const { buildSessionContext, parseSessionEntries } = pi as unknown as {
  buildSessionContext: (entries: unknown[], leafId?: string | null) => { messages: unknown[] };
  parseSessionEntries: (content: string) => unknown[];
};

/** The synthetic session: root→leaf, with a compaction in the middle. */
const LINES: Array<Record<string, unknown>> = [
  { type: "session", id: "s0", parentId: null, version: 3 }, // header: our parser drops it
  { type: "model_change", id: "m1", parentId: "s0" },
  { type: "message", id: "u1", parentId: "m1", message: { role: "user", content: [{ type: "text", text: "dropped by compaction" }] } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "kept" }] } },
  { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: null } }, // → content []
  { type: "compaction", id: "cp1", parentId: "t1", summary: "S1", firstKeptEntryId: "a1", tokensBefore: 100, timestamp: "2026-01-01T00:00:01.000Z" },
  { type: "message", id: "u2", parentId: "cp1", message: { role: "user", content: [{ type: "text", text: "next" }] } },
  { type: "custom_message", id: "cu1", parentId: "u2", customType: "note", content: [{ type: "text", text: "n" }], display: true, details: {}, timestamp: "2026-01-01T00:00:02.000Z" },
  { type: "branch_summary", id: "bs1", parentId: "cu1", summary: "BS", fromId: "x", timestamp: "2026-01-01T00:00:03.000Z" },
  { type: "message", id: "a2", parentId: "bs1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
];

const CONTENT = LINES.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("sessionContextMessages mirrors pi", () => {
  const oracle = buildSessionContext(parseSessionEntries(CONTENT)).messages;

  it("produces pi's exact message list for the synthetic session", () => {
    const { entries, leafId } = parseTreeEntries(CONTENT);
    expect(sessionContextMessages(entries as TranscriptEntry[], leafId)).toEqual(oracle);
  });

  it("the PRODUCTION path (transcriptFromContent) also matches pi", async () => {
    // Pins the whole file→messages pipeline, not just the resolver: the
    // cooperative parse and the empty→null guard are part of the shipped path.
    expect(await transcriptFromContent(CONTENT)).toEqual(oracle);
  });

  it("drops everything before the last compaction's firstKeptEntryId", () => {
    const { entries, leafId } = parseTreeEntries(CONTENT);
    const roles = (sessionContextMessages(entries as TranscriptEntry[], leafId) as Array<{ role: string }>).map((m) => m.role);
    // compactionSummary replaces u1; a1/t1 are kept; then the tail.
    expect(roles).toEqual(["compactionSummary", "assistant", "toolResult", "user", "custom", "branchSummary", "assistant"]);
  });

  it("normalizes null content to [] (old/forked/hand-edited files)", () => {
    const { entries, leafId } = parseTreeEntries(CONTENT);
    const msgs = sessionContextMessages(entries as TranscriptEntry[], leafId) as Array<{ role: string; content: unknown }>;
    expect(msgs.find((m) => m.role === "toolResult")!.content).toEqual([]);
  });

  it("keeps the whole branch when there is no compaction", () => {
    const noCompaction = LINES.filter((l) => l.type !== "compaction")
      .map((l) => (l.id === "cp1" ? l : l))
      // re-root the entries that pointed at the removed compaction
      .map((l) => (l.id === "u2" ? { ...l, parentId: "t1" } : l));
    const content = noCompaction.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const { entries, leafId } = parseTreeEntries(content);
    expect(sessionContextMessages(entries as TranscriptEntry[], leafId)).toEqual(
      buildSessionContext(parseSessionEntries(content)).messages,
    );
  });

  it("matches pi's leaf fallback for an unknown leaf id", () => {
    // pi: an unknown id falls back to the LAST entry by position.
    const { entries } = parseTreeEntries(CONTENT);
    expect(sessionContextMessages(entries as TranscriptEntry[], "does-not-exist")).toEqual(oracle);
    // null leaf means "no leaf" for both.
    expect(sessionContextMessages(entries as TranscriptEntry[], null)).toEqual([]);
  });
});
