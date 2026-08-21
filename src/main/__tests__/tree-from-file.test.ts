// tree-from-file — pure JSONL session-tree parsing, mirroring pi's own
// SessionManager.getTree semantics. No SDK / Electron runtime needed.
import { describe, expect, it } from "vitest";
import { parseTreeEntries, parseTreeFileAsync, buildFileTree, type RawTreeEntry } from "../tree-from-file";

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

describe("buildFileTree labels", () => {
  it("clears a label on empty-string label entries (mirrors pi's falsy check)", () => {
    const lines = [
      { type: "message", id: "a", parentId: null },
      { type: "label", id: "l1", parentId: "a", timestamp: "t1", targetId: "a", label: "branch-1" },
      { type: "message", id: "b", parentId: "a" },
      { type: "label", id: "l2", parentId: "b", timestamp: "t2", targetId: "a", label: "" },
    ].map((o) => JSON.stringify(o));
    const { tree } = buildFileTree(parseTreeEntries(lines.join("\n")).entries);
    expect(tree[0]!.label).toBeUndefined();
    expect(tree[0]!.labelTimestamp).toBeUndefined();
  });
});

describe("buildFileTree", () => {
  it("builds root → children chains from parentId", () => {
    const { entries } = parseTreeEntries(SAMPLE);
    const { tree } = buildFileTree(entries);
    expect(tree.length).toBe(1);
    expect(tree[0]!.entry.id).toBe("a");
    expect(tree[0]!.children.map((n) => n.entry.id)).toEqual(["b"]);
    expect(tree[0]!.children[0]!.children[0]!.entry.id).toBe("c");
  });

  it("treats orphans and self-parents as roots", () => {
    const lines = [
      { type: "message", id: "x", parentId: null },
      { type: "message", id: "y", parentId: "ghost" }, // broken parent chain
      { type: "message", id: "z", parentId: "z" },     // self-parent
    ].map((o) => JSON.stringify(o));
    const { tree } = buildFileTree(parseTreeEntries(lines.join("\n")).entries);
    expect(tree.map((n) => n.entry.id).sort()).toEqual(["x", "y", "z"]);
  });

  it("resolves labels and clears them on falsy label entries", () => {
    const lines = [
      { type: "message", id: "a", parentId: null },
      { type: "label", id: "l1", parentId: "a", timestamp: "t10", targetId: "a", label: "我的分支" },
      { type: "message", id: "b", parentId: "a" },
      { type: "label", id: "l2", parentId: "b", timestamp: "t20", targetId: "a", label: undefined },
    ].map((o) => JSON.stringify(o));
    const { tree } = buildFileTree(parseTreeEntries(lines.join("\n")).entries);
    const a = tree.find((n) => n.entry.id === "a")!;
    expect(a.label).toBeUndefined(); // cleared by the second label entry
    expect(a.labelTimestamp).toBeUndefined();
  });

  it("keeps a label when no clear entry follows", () => {
    const lines = [
      { type: "message", id: "a", parentId: null },
      { type: "label", id: "l1", parentId: "a", timestamp: "t10", targetId: "a", label: "keep" },
    ].map((o) => JSON.stringify(o));
    const { tree } = buildFileTree(parseTreeEntries(lines.join("\n")).entries);
    expect(tree[0]!.label).toBe("keep");
    expect(tree[0]!.labelTimestamp).toBe("t10");
  });

  it("round-trips a realistic branched session", () => {
    const raw: Array<Record<string, unknown>> = [
      { type: "message", id: "a", parentId: null, timestamp: "t1", message: { role: "user" } },
      { type: "message", id: "b", parentId: "a", timestamp: "t2", message: { role: "assistant" } },
      { type: "message", id: "c", parentId: "b", timestamp: "t3", message: { role: "user" } },
      { type: "message", id: "d", parentId: "a", timestamp: "t4", message: { role: "assistant" } }, // fork from a
    ];
    const { entries, leafId } = parseTreeEntries(raw.map((o) => JSON.stringify(o)).join("\n"));
    expect(leafId).toBe("d");
    const { tree } = buildFileTree(entries as RawTreeEntry[]);
    expect(tree.length).toBe(1);
    const [root] = tree;
    expect(root!.children.map((n) => n.entry.id).sort()).toEqual(["b", "d"]);
  });
});
