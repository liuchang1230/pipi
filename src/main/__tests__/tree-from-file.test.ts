// tree-from-file — pure JSONL session parsing (flat entries + leafId).
// The nested-tree building lives in src/shared/tree-build.ts (tested there).
import { describe, expect, it } from "vitest";
import { parseTreeEntries, parseTreeFileAsync } from "../tree-from-file";

const SAMPLE = [
  { type: "session", version: 3, id: "s1", timestamp: "t0", cwd: "/p" },
  { type: "model_change", id: "a", parentId: null, timestamp: "t1", provider: "x", modelId: "m" },
  { type: "message", id: "b", parentId: "a", timestamp: "t2", message: { role: "user", content: "hi" } },
  { type: "message", id: "c", parentId: "b", timestamp: "t3", message: { role: "assistant", content: "yo" } },
].map((o) => JSON.stringify(o)).join("\n");

describe("parseTreeEntries", () => {
  it("parses entries, skips the session header and blank/malformed lines", () => {
    const content = SAMPLE + "\n\nnot-json\n{broken\n";
    const { entries, leafId } = parseTreeEntries(content);
    expect(entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(leafId).toBe("c");
  });

  it("returns empty + null leaf for a header-only file", () => {
    const { entries, leafId } = parseTreeEntries(JSON.stringify({ type: "session", id: "s" }));
    expect(entries).toEqual([]);
    expect(leafId).toBeNull();
  });

  it("parses a header-less file leniently (skips junk, keeps entries)", () => {
    const content = [
      "not-json",
      JSON.stringify({ type: "message", id: "a", parentId: null }),
      "",
      JSON.stringify({ type: "message", id: "b", parentId: "a" }),
    ].join("\n");
    const { entries, leafId } = parseTreeEntries(content);
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(leafId).toBe("b");
  });
});

describe("parseTreeFileAsync", () => {
  it("matches the sync variant", async () => {
    const a = await parseTreeFileAsync(SAMPLE);
    const b = parseTreeEntries(SAMPLE);
    expect(a.entries).toEqual(b.entries);
    expect(a.leafId).toBe(b.leafId);
  });

  it("drops no entries across yield boundaries", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({ type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}` }));
    }
    const { entries, leafId } = await parseTreeFileAsync(lines.join("\n"), 100);
    expect(entries.length).toBe(1000);
    expect(entries[0]!.id).toBe("e0");
    expect(entries[999]!.id).toBe("e999");
    expect(leafId).toBe("e999");
  });
});
