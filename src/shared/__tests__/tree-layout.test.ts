// The two tree complaints, pinned as pure logic:
//  * "I cannot find where the current conversation is" → onActivePath/isCurrent
//  * "Jumping between branches is flaky" → the settle rule (target on the leaf's path)
import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";
import { ancestorIds, flattenTree, isAlreadyAtTarget, isNavigationSettled, isOnLeafPath } from "../tree-layout";

/** A session with a branch: r → a → b → leaf, plus a sibling branch r → x. */
const ENTRIES: TreeEntry[] = [
  { type: "message", id: "r", parentId: null },
  { type: "message", id: "a", parentId: "r" },
  { type: "message", id: "b", parentId: "a" },
  { type: "message", id: "leaf", parentId: "b" },
  { type: "message", id: "x", parentId: "r" },
  { type: "message", id: "y", parentId: "x" },
];

function flat(leafId: string | null) {
  const { tree } = buildTreeFromEntries(ENTRIES);
  return flattenTree(tree, leafId).flat;
}

describe("flattenTree", () => {
  it("marks exactly the path from the root to the leaf as active", () => {
    const rows = flat("leaf");
    const active = rows.filter((r) => r.onActivePath).map((r) => r.node.entry.id).sort();
    expect(active).toEqual(["a", "b", "leaf", "r"]);
    // The other branch is NOT on the path — that is what makes the highlight honest.
    expect(rows.find((r) => r.node.entry.id === "x")?.onActivePath).toBe(false);
    expect(rows.find((r) => r.node.entry.id === "y")?.onActivePath).toBe(false);
  });

  it("marks exactly one row as the current conversation", () => {
    const rows = flat("leaf");
    expect(rows.filter((r) => r.isCurrent).map((r) => r.node.entry.id)).toEqual(["leaf"]);
  });

  it("puts the active branch first so the current position is found without scrolling far", () => {
    const rows = flat("leaf");
    // Roots: r (contains the leaf) must precede x.
    expect(rows[0]?.node.entry.id).toBe("r");
  });

  it("marks nothing as active without a leaf (a fresh/empty session)", () => {
    const rows = flat(null);
    expect(rows.some((r) => r.onActivePath)).toBe(false);
    expect(rows.some((r) => r.isCurrent)).toBe(false);
  });

  it("survives a cyclic parent chain without looping", () => {
    const cyclic: TreeEntry[] = [
      { type: "message", id: "p", parentId: "q" },
      { type: "message", id: "q", parentId: "p" },
    ];
    const { tree } = buildTreeFromEntries(cyclic);
    expect(() => flattenTree(tree, "p")).not.toThrow();
    // The contract is termination within a bounded walk, not a specific length.
    expect(ancestorIds(cyclic, "p").length).toBeLessThanOrEqual(cyclic.length + 1);
  });
});

describe("isOnLeafPath (the navigation settle rule)", () => {
  it("is true for the leaf itself — navigating to where we already are settles at once", () => {
    // The old rule ("the leaf must CHANGE") never fired here, so the dialog sat
    // on a 60s timer and reported 导航超时 although the session was already there.
    expect(isOnLeafPath(ENTRIES, "leaf", "leaf")).toBe(true);
  });

  it("is true for any ancestor of the leaf (a branch point above us)", () => {
    expect(isOnLeafPath(ENTRIES, "b", "leaf")).toBe(true);
    expect(isOnLeafPath(ENTRIES, "a", "leaf")).toBe(true);
    expect(isOnLeafPath(ENTRIES, "r", "leaf")).toBe(true);
  });

  it("is true for a NEW child appended by a summarize navigation", () => {
    const withSummary: TreeEntry[] = [...ENTRIES, { type: "message", id: "sum", parentId: "b" }];
    expect(isOnLeafPath(withSummary, "b", "sum")).toBe(true);
  });

  it("is false for a node on another branch (the navigation is NOT done yet)", () => {
    expect(isOnLeafPath(ENTRIES, "x", "leaf")).toBe(false);
    expect(isOnLeafPath(ENTRIES, "y", "leaf")).toBe(false);
  });

  it("is false without a leaf (nothing is settled in an empty session)", () => {
    expect(isOnLeafPath(ENTRIES, "leaf", null)).toBe(false);
  });
});

describe("ancestorIds", () => {
  it("lists ancestors nearest-first", () => {
    expect(ancestorIds(ENTRIES, "leaf")).toEqual(["b", "a", "r"]);
  });

  it("is empty for a root", () => {
    expect(ancestorIds(ENTRIES, "r")).toEqual([]);
  });

  it("does not repeat an id when a chain is cyclic", () => {
    const cyclic: TreeEntry[] = [
      { type: "message", id: "p", parentId: "q" },
      { type: "message", id: "q", parentId: "p" },
    ];
    const walked = ancestorIds(cyclic, "p");
    expect(walked.length).toBeLessThanOrEqual(cyclic.length + 1);
    expect(walked).toContain("p"); // the ring is visible, and the walk stopped
  });
});

describe("isAlreadyAtTarget / isNavigationSettled (what 'flaky jumping' was)", () => {
  it("recognises a no-op navigation so it can settle immediately", () => {
    // Clicking the node the session is already on used to run the 60s timer and
    // then toast 导航超时 with nothing actually wrong.
    expect(isAlreadyAtTarget("leaf", "leaf")).toBe(true);
    expect(isAlreadyAtTarget("leaf", "other")).toBe(false);
    expect(isAlreadyAtTarget("leaf", null)).toBe(false);
  });

  it("is not settled while the leaf has not moved (pi may still be working)", () => {
    expect(isNavigationSettled(ENTRIES, { targetId: "x", startLeafId: "leaf", leafId: "leaf" })).toBe(false);
  });

  it("settles when the leaf moved onto the target itself", () => {
    expect(isNavigationSettled(ENTRIES, { targetId: "b", startLeafId: "leaf", leafId: "b" })).toBe(true);
  });

  it("settles when a summarize appended a new entry UNDER the target", () => {
    const withSummary: TreeEntry[] = [...ENTRIES, { type: "message", id: "sum", parentId: "a" }];
    expect(isNavigationSettled(withSummary, { targetId: "a", startLeafId: "leaf", leafId: "sum" })).toBe(true);
  });

  it("does not settle when the leaf moved somewhere unrelated (another branch)", () => {
    // Targeting x (branch r→x) while the leaf sits on branch r→a→b: the old
    // "the leaf changed" rule called this a success.
    expect(isNavigationSettled(ENTRIES, { targetId: "x", startLeafId: "y", leafId: "leaf" })).toBe(false);
  });

  it("settles when the leaf moved INTO the target's subtree (pi continued under it)", () => {
    // Targeting x and landing on its child y is a landing, not a failure.
    expect(isNavigationSettled(ENTRIES, { targetId: "x", startLeafId: "leaf", leafId: "y" })).toBe(true);
  });

  it("does not settle without a leaf (empty session)", () => {
    expect(isNavigationSettled(ENTRIES, { targetId: "r", startLeafId: null, leafId: null })).toBe(false);
  });
});
