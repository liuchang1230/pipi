// tree-build — cycle-safe tree building from flat parentId entry lists.
// Shared by the main process (file parsing) and the renderer (RPC
// get_entries responses). No SDK / Electron runtime needed.
import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";

function entries(...objs: Array<Record<string, unknown>>): TreeEntry[] {
  return objs.map((o) => ({ type: "message", parentId: null, ...o }) as unknown as TreeEntry);
}

describe("buildTreeFromEntries", () => {
  it("builds root → children chains from parentId", () => {
    const es = entries(
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
    );
    const { tree } = buildTreeFromEntries(es);
    expect(tree.length).toBe(1);
    expect(tree[0]!.entry.id).toBe("a");
    expect(tree[0]!.children.map((n) => n.entry.id)).toEqual(["b"]);
    expect(tree[0]!.children[0]!.children[0]!.entry.id).toBe("c");
  });

  it("treats orphans, self-parents and missing parents as roots", () => {
    const es = entries(
      { id: "x", parentId: null },
      { id: "y", parentId: "ghost" }, // broken parent chain
      { id: "z", parentId: "z" },     // self-parent
    );
    const { tree } = buildTreeFromEntries(es);
    expect(tree.map((n) => n.entry.id).sort()).toEqual(["x", "y", "z"]);
  });

  it("never creates circular children references for A→B→A rings", () => {
    const es = entries(
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    );
    const { tree } = buildTreeFromEntries(es);
    // Both ring members are promoted to roots — no circular children refs.
    expect(tree.length).toBe(2);
    // Walking children must terminate and visit every node exactly once.
    const seen = new Set<string>();
    const stack = [...tree];
    let nodes = 0;
    while (stack.length) {
      const n = stack.pop()!;
      nodes++;
      expect(seen.has(n.entry.id)).toBe(false);
      seen.add(n.entry.id);
      stack.push(...n.children);
    }
    expect(nodes).toBe(2);
  });

  it("resolves labels, clears on falsy/empty, keeps on truthy", () => {
    const es = entries(
      { id: "a", parentId: null },
      { id: "l1", type: "label", targetId: "a", timestamp: "t1", label: "分支" },
      { id: "b", parentId: "a" },
      { id: "l2", type: "label", targetId: "b", timestamp: "t2", label: "keep" },
    );
    const { tree } = buildTreeFromEntries(es);
    const a = tree.find((n) => n.entry.id === "a")!;
    const b = tree[0]!.children.find((n) => n.entry.id === "b")!;
    expect(a.label).toBe("分支");
    expect(a.labelTimestamp).toBe("t1");
    expect(b.label).toBe("keep");
    expect(b.labelTimestamp).toBe("t2");
  });

  it("clears a label on empty-string label entries (mirrors pi's falsy check)", () => {
    const es = entries(
      { id: "a", parentId: null },
      { id: "l1", type: "label", targetId: "a", timestamp: "t1", label: "branch-1" },
      { id: "b", parentId: "a" },
      { id: "l2", type: "label", targetId: "a", timestamp: "t2", label: "" },
    );
    const { tree } = buildTreeFromEntries(es);
    expect(tree[0]!.label).toBeUndefined();
    expect(tree[0]!.labelTimestamp).toBeUndefined();
  });

  it("round-trips a realistic branched session", () => {
    const es = entries(
      { id: "a", parentId: null, timestamp: "t1" },
      { id: "b", parentId: "a", timestamp: "t2" },
      { id: "c", parentId: "b", timestamp: "t3" },
      { id: "d", parentId: "a", timestamp: "t4" }, // fork from a
    );
    const { tree } = buildTreeFromEntries(es);
    expect(tree.length).toBe(1);
    expect(tree[0]!.children.map((n) => n.entry.id).sort()).toEqual(["b", "d"]);
  });

  it("handles a very long linear chain without recursion blowup", () => {
    const es: TreeEntry[] = [];
    for (let i = 0; i < 3000; i++) {
      es.push({ type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}` });
    }
    const { tree } = buildTreeFromEntries(es);
    expect(tree.length).toBe(1);
    // Walk the chain iteratively to verify depth, no stack overflow.
    let depth = 0;
    let cur: TreeEntry | undefined = tree[0]!.entry;
    while (cur && depth < 4000) {
      depth++;
      cur = es.find((e) => e.parentId === cur!.id);
    }
    expect(depth).toBe(3000);
  });
});
