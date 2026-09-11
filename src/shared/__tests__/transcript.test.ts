// sessionContextMessages: rebuild what pi's `get_messages` returns from a
// session file's flat parentId entry list.
//
// Regression context: on a slow remote link `get_messages` ships the whole
// transcript over the serial `pi --mode rpc` command loop, so transferring
// history queues the agent's own commands and the app looks hung (measured
// 17–45s round trips). The session file is reachable over a non-contending
// channel — but it is a DAG, so the current context must be resolved.
//
// Semantics are MIRRORED from pi (compaction-aware); the exact-equality check
// against pi lives in transcript-pi-parity.test.ts. These tests pin our own
// behaviour on shapes that synthetic fixture does not cover.
import { describe, expect, it } from "vitest";
import { sessionContextMessages, type TranscriptEntry } from "../transcript";

/** `{type,id,parentId,message}` — the real file's shape. */
const msg = (id: string, parentId: string | null, role: string, text = id): TranscriptEntry => ({
  type: "message",
  id,
  parentId,
  message: { role, content: [{ type: "text", text }] },
});

/** The text of each message, for order-sensitive assertions. */
const texts = (msgs: unknown[]): string[] =>
  msgs.map((m) => ((m as { content: Array<{ text: string }> }).content[0]?.text ?? ""));

describe("sessionContextMessages", () => {
  it("returns the branch root→leaf (the order events happened)", () => {
    const entries = [msg("c", "b", "assistant"), msg("a", null, "user"), msg("b", "a", "assistant")];
    // Input order is arbitrary (append order can interleave after a nav); the
    // transcript follows the parentId chain, not file position.
    expect(texts(sessionContextMessages(entries, "c"))).toEqual(["a", "b", "c"]);
  });

  it("follows the LEAF's branch and excludes the abandoned sibling", () => {
    // a → b, then the user navigated back to a and went a → d.
    const entries = [
      msg("a", null, "user", "q1"),
      msg("b", "a", "assistant", "abandoned"),
      msg("d", "a", "assistant", "current"),
    ];
    expect(texts(sessionContextMessages(entries, "d"))).toEqual(["q1", "current"]);
    // The other leaf still resolves its own branch.
    expect(texts(sessionContextMessages(entries, "b"))).toEqual(["q1", "abandoned"]);
  });

  it("traverses non-message entries without emitting them", () => {
    const entries: TranscriptEntry[] = [
      { type: "model_change", id: "m1", parentId: null },
      { type: "label", id: "l1", parentId: "m1", targetId: "a" },
      msg("a", "l1", "user", "hi"),
      msg("b", "a", "assistant", "yo"),
    ];
    expect(texts(sessionContextMessages(entries, "b"))).toEqual(["hi", "yo"]);
  });

  it("returns the message object AS-IS (pi injects no id)", () => {
    // pi's sessionEntryToContextMessages hands back `entry.message` untouched,
    // so `get_messages` messages carry no id and the renderer falls back to
    // positional keys. Injecting one here would diverge from pi.
    const entries = [msg("entry-7", null, "user", "hi")];
    const out = sessionContextMessages(entries, "entry-7") as Array<Record<string, unknown>>;
    expect(out[0]!.role).toBe("user");
    expect("id" in out[0]!).toBe(false);
  });

  it("passes toolResult through so tool calls can be paired", () => {
    const entries: TranscriptEntry[] = [
      msg("a", null, "assistant"),
      { type: "message", id: "t", parentId: "a", message: { role: "toolResult", toolCallId: "call-1", content: [] } },
    ];
    const out = sessionContextMessages(entries, "t") as Array<Record<string, unknown>>;
    expect(out[1]!.role).toBe("toolResult");
    expect(out[1]!.toolCallId).toBe("call-1"); // attachToolResults keys on this
  });

  it("stops at a broken parent chain instead of dropping what it has", () => {
    // The `session` header is dropped by parseTreeEntries, so the first
    // message's parentId points at an id that is not in `entries`.
    const entries = [msg("a", "session-header-id", "user", "hi"), msg("b", "a", "assistant", "yo")];
    expect(texts(sessionContextMessages(entries, "b"))).toEqual(["hi", "yo"]);
  });

  it("falls back to the LAST entry for an unknown leaf id (mirrors pi)", () => {
    const entries = [msg("a", null, "user", "hi"), msg("b", "a", "assistant", "yo")];
    expect(texts(sessionContextMessages(entries, "nope"))).toEqual(["hi", "yo"]);
  });

  it("returns [] for a null leaf (no leaf) or no entries", () => {
    expect(sessionContextMessages([msg("a", null, "user")], null)).toEqual([]);
    expect(sessionContextMessages([], "a")).toEqual([]);
    expect(sessionContextMessages([], null)).toEqual([]);
  });

  it("terminates on a cyclic chain (hardening over pi, which would spin)", () => {
    const ring: TranscriptEntry[] = [msg("a", "b", "user"), msg("b", "a", "assistant")];
    const out = sessionContextMessages(ring, "a");
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("skips a message-typed entry with no body (hardening over pi)", () => {
    const entries: TranscriptEntry[] = [msg("a", null, "user", "hi"), { type: "message", id: "b", parentId: "a" }];
    expect(texts(sessionContextMessages(entries, "b"))).toEqual(["hi"]);
  });
});
