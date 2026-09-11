// transcriptFromContent: the safety-critical contract between the file path and
// the RPC fallback.
//
// An unusable file must return null — never an empty or partial transcript —
// because the caller only falls back to RPC on null. Returning [] instead would
// blank the chat view (the failure mode this whole path must never introduce),
// and returning an unresolved shorter list would show silently wrong history.
import { describe, expect, it } from "vitest";
import { transcriptFromContent } from "../transcript-from-file";

const line = (o: Record<string, unknown>) => JSON.stringify(o);

const SESSION = [
  line({ type: "session", id: "s0", parentId: null, version: 3 }),
  line({ type: "message", id: "u1", parentId: "s0", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
  line({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
].join("\n") + "\n";

describe("transcriptFromContent", () => {
  it("resolves a real-shaped session into messages", async () => {
    const messages = await transcriptFromContent(SESSION);
    expect(messages?.length).toBe(2);
    expect((messages![0] as { role: string }).role).toBe("user");
    expect((messages![1] as { role: string }).role).toBe("assistant");
  });

  it("returns null for empty content", async () => {
    expect(await transcriptFromContent("")).toBeNull();
  });

  it("returns null for whitespace / junk only", async () => {
    expect(await transcriptFromContent("\n\n   \n")).toBeNull();
    expect(await transcriptFromContent("not json\n{broken\n")).toBeNull();
  });

  it("returns null when the file has entries but no messages on the branch", async () => {
    // A brand-new session whose only entries are metadata: the sidebar hides
    // nothing, but the chat view must fall back rather than render an empty
    // transcript as if the session were loaded.
    const metaOnly = [
      line({ type: "session", id: "s0", parentId: null, version: 3 }),
      line({ type: "model_change", id: "m1", parentId: "s0" }),
    ].join("\n") + "\n";
    expect(await transcriptFromContent(metaOnly)).toBeNull();
  });

  it("tolerates a torn trailing line (pi mid-write)", async () => {
    // Only complete lines count; a half-written last line must not break the
    // rest of the transcript.
    const torn = SESSION + line({ type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: [{ type: "text", text: "cut" }] } }).slice(0, 20);
    const messages = await transcriptFromContent(torn);
    expect(messages?.length).toBe(2);
  });

  it("drops entries that are not on the leaf's branch", async () => {
    const branched = [
      line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "q1" }] } }),
      line({ type: "message", id: "abandoned", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "old" }] } }),
      line({ type: "message", id: "current", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "new" }] } }),
    ].join("\n") + "\n";
    const messages = (await transcriptFromContent(branched)) as Array<{ content: Array<{ text: string }> }>;
    // The leaf is `current`, so `abandoned` is excluded but its ancestor is not.
    expect(messages.map((m) => m.content[0]!.text)).toEqual(["q1", "new"]);
  });
});
