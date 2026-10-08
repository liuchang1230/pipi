// The two tree complaints, pinned as pure logic:
//  * "I cannot find where the current conversation is" → onActivePath/isCurrent
//  * "Jumping between branches is flaky" → the settle rule (target on the leaf's path)
import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";
import {
  ancestorIds,
  conversationLevel,
  flattenTree,
  isAlreadyAtTarget,
  isNavigationSettled,
  isOnLeafPath,
  navigateLeafId,
  nearestVisibleAncestor,
} from "../tree-layout";

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

/**
 * 「同一层一定要对齐」 (2026-09-28) — the user's report was not about a missing
 * indent but about an INCONSISTENT one: the old rule collapsed single-child runs
 * (else every session would march off to the right), so whether a row moved right
 * depended on whether some ancestor happened to branch, and two entries at the
 * same level landed in different columns. Indentation is now the entry's own
 * conversation level, i.e. a pure function of the entry.
 */
describe("conversationLevel (the column a row belongs in)", () => {
  it("is the speaker, not the depth of the parentId chain", () => {
    expect(conversationLevel({ type: "message", id: "u", parentId: null, message: { role: "user" } })).toBe(0);
    expect(conversationLevel({ type: "message", id: "a", parentId: "u", message: { role: "assistant" } })).toBe(1);
    expect(conversationLevel({ type: "message", id: "t", parentId: "a", message: { role: "toolResult" } })).toBe(2);
    // A replayed prompt reads like a prompt (pi rewinds to before it).
    expect(conversationLevel({ type: "custom_message", id: "c", parentId: "t" })).toBe(0);
    // Bookkeeping is plumbing, never a level of its own.
    for (const type of ["compaction", "branch_summary", "model_change", "label", "session_info"]) {
      expect(conversationLevel({ type, id: `x-${type}`, parentId: "a" })).toBe(2);
    }
  });

  it("puts prompt / reply / plumbing in columns 0 / 1 / 2 on a linear session", () => {
    // pi chains every entry onto the previous one, so real depth here is 0..5.
    const linear: TreeEntry[] = [
      { type: "message", id: "u1", parentId: null, message: { role: "user" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant" } },
      { type: "message", id: "t1", parentId: "a1", message: { role: "toolResult" } },
      { type: "message", id: "a2", parentId: "t1", message: { role: "assistant" } },
      { type: "model_change", id: "m1", parentId: "a2" },
      { type: "message", id: "u2", parentId: "m1", message: { role: "user" } },
    ];
    const { tree } = buildTreeFromEntries(linear);
    const rows = flattenTree(tree, "u2").flat;
    expect(rows.map((r) => [r.node.entry.id, r.indent])).toEqual([
      ["u1", 0],
      ["a1", 1],
      ["t1", 2],
      ["a2", 1],
      ["m1", 2],
      ["u2", 0], // the next prompt starts a new spine entry, not a deeper one
    ]);
  });

  it("never puts two rows of the same level in different columns (long session)", () => {
    // 600 entries: without the level rule this would indent 600 columns deep.
    const entries: TreeEntry[] = [];
    let parentId: string | null = null;
    for (let turn = 0; turn < 100; turn += 1) {
      for (const role of ["user", "assistant", "toolResult"] as const) {
        const id = `${role}-${turn}`;
        entries.push({ type: "message", id, parentId, message: { role } });
        parentId = id;
      }
    }
    const { tree } = buildTreeFromEntries(entries);
    const rows = flattenTree(tree, parentId).flat;
    expect(rows).toHaveLength(300);
    const columnsByLevel = new Map<number, Set<number>>();
    for (const row of rows) {
      const level = conversationLevel(row.node.entry);
      const seen = columnsByLevel.get(level) ?? new Set<number>();
      seen.add(row.indent);
      columnsByLevel.set(level, seen);
    }
    // Exactly one column per level, and no drift: the deepest column is 2.
    expect([...columnsByLevel.keys()].sort()).toEqual([0, 1, 2]);
    for (const [level, columns] of columnsByLevel) {
      expect([...columns], `level ${level}`).toEqual([level]);
    }
  });

  it("keeps both sides of a branch in the same column", () => {
    // Two replies to one prompt: they are the same level, so they must line up.
    const branched: TreeEntry[] = [
      { type: "message", id: "u", parentId: null, message: { role: "user" } },
      { type: "message", id: "a", parentId: "u", message: { role: "assistant" } },
      { type: "message", id: "b", parentId: "u", message: { role: "assistant" } },
      { type: "message", id: "a-tool", parentId: "a", message: { role: "toolResult" } },
      { type: "message", id: "b-tool", parentId: "b", message: { role: "toolResult" } },
    ];
    const { tree } = buildTreeFromEntries(branched);
    const rows = flattenTree(tree, "a-tool").flat;
    expect(rows.find((r) => r.node.entry.id === "a")?.indent).toBe(1);
    expect(rows.find((r) => r.node.entry.id === "b")?.indent).toBe(1);
    expect(rows.find((r) => r.node.entry.id === "a-tool")?.indent).toBe(2);
    expect(rows.find((r) => r.node.entry.id === "b-tool")?.indent).toBe(2);
    // The branch itself is drawn in the marker column: a is not the last sibling.
    expect(rows.find((r) => r.node.entry.id === "a")?.marker).toBe("branch-mid");
    expect(rows.find((r) => r.node.entry.id === "b")?.marker).toBe("branch-last");
    // …and the first branch stays open for its own descendants.
    expect(rows.find((r) => r.node.entry.id === "a-tool")?.marker).toBe("continuation");
    expect(rows.find((r) => r.node.entry.id === "b-tool")?.marker).toBe("none");
  });

  it("marks a fork at a PROMPT without moving the prompt out of column 0", () => {
    // The level-0 case the old elbow scheme silently dropped: the parent sits in
    // column 2, the two prompts it forked into stay in column 0 (that IS the
    // alignment the user asked for) and carry the ├/└ themselves.
    const forked: TreeEntry[] = [
      { type: "message", id: "u1", parentId: null, message: { role: "user" } },
      { type: "message", id: "t1", parentId: "u1", message: { role: "toolResult" } },
      { type: "message", id: "u2", parentId: "t1", message: { role: "user" } },
      { type: "message", id: "u3", parentId: "t1", message: { role: "user" } },
      { type: "message", id: "a3", parentId: "u3", message: { role: "assistant" } },
    ];
    const { tree } = buildTreeFromEntries(forked);
    const rows = flattenTree(tree, "a3").flat;
    expect(rows.find((r) => r.node.entry.id === "u2")?.indent).toBe(0);
    expect(rows.find((r) => r.node.entry.id === "u3")?.indent).toBe(0);
    // The active branch is listed first, so u3 (which holds the leaf) is the
    // non-last sibling here.
    expect(rows.find((r) => r.node.entry.id === "u3")?.marker).toBe("branch-mid");
    expect(rows.find((r) => r.node.entry.id === "u2")?.marker).toBe("branch-last");
    // u3 is an open branch, so its reply keeps the │ alive.
    expect(rows.find((r) => r.node.entry.id === "a3")?.marker).toBe("continuation");
  });

  it("gives every row at one level the same indent, mark or no mark", () => {
    // Guards the regression the old gutter did: a branch child at column 0 used
    // to leave a phantom │ on its descendants while drawing no elbow of its own.
    const forked: TreeEntry[] = [
      { type: "message", id: "r", parentId: null, message: { role: "toolResult" } },
      { type: "message", id: "u1", parentId: "r", message: { role: "user" } },
      { type: "message", id: "u2", parentId: "r", message: { role: "user" } },
      { type: "message", id: "a2", parentId: "u2", message: { role: "assistant" } },
    ];
    const { tree } = buildTreeFromEntries(forked);
    const rows = flattenTree(tree, "a2").flat;
    expect(rows.map((r) => [r.node.entry.id, r.indent])).toEqual([
      ["r", 2],
      ["u2", 0], // active branch first
      ["a2", 1],
      ["u1", 0],
    ]);
    // u2 is an open branch (u1 follows it), so its reply continues the │ — and
    // nothing inherits a line from u1, which has no children.
    expect(rows.find((r) => r.node.entry.id === "a2")?.marker).toBe("continuation");
  });

  it("lets several roots sit in their own level (no virtual offset column)", () => {
    const roots: TreeEntry[] = [
      { type: "message", id: "u", parentId: null, message: { role: "user" } },
      { type: "message", id: "orphan", parentId: "missing", message: { role: "assistant" } },
    ];
    const { tree } = buildTreeFromEntries(roots);
    const rows = flattenTree(tree, null).flat;
    expect(rows.find((r) => r.node.entry.id === "u")?.indent).toBe(0);
    expect(rows.find((r) => r.node.entry.id === "orphan")?.indent).toBe(1);
    // A root is nobody's sibling child, so it is never marked as a branch.
    expect(rows.every((r) => r.marker === "none")).toBe(true);
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
    expect(isAlreadyAtTarget(ENTRIES, "leaf", "leaf")).toBe(true);
    expect(isAlreadyAtTarget(ENTRIES, "leaf", "other")).toBe(false);
    expect(isAlreadyAtTarget(ENTRIES, "leaf", null)).toBe(false);
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

/**
 * Regression: 「分支导航速度太慢，基本上就是卡住」.
 *
 * pi's `navigateTree` does NOT put the leaf on the node you picked when that node
 * is a USER message — it rewinds to that message's PARENT and hands the text back
 * to the editor (TUI /tree semantics, agent-session.js). The completion rule
 * waited for the target to appear on the leaf's path, which can never happen after
 * a rewind: the dialog polled a 2778-entry session every second (3.0-3.4s per
 * round trip on the user's remote) until its 60s timeout, i.e. it looked frozen.
 */
describe("navigateLeafId (where pi actually lands)", () => {
  const CHAT: TreeEntry[] = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: [] } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [] } },
    { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [] } },
    { type: "tool", id: "t1", parentId: "a2" },
    { type: "custom_message", id: "c1", parentId: "a2", content: [] },
  ];

  it("rewinds a user message to its parent (the common '回到这里重新提问')", () => {
    expect(navigateLeafId(CHAT, "u2")).toBe("a1");
    // A root user message rewinds to before the session's first message: null IS
    // the new position, not "nothing happened".
    expect(navigateLeafId(CHAT, "u1")).toBeNull();
    expect(navigateLeafId(CHAT, "c1")).toBe("a2");
  });

  it("points AT every other entry", () => {
    expect(navigateLeafId(CHAT, "a1")).toBe("a1");
    expect(navigateLeafId(CHAT, "a2")).toBe("a2");
    expect(navigateLeafId(CHAT, "t1")).toBe("t1");
    expect(navigateLeafId(CHAT, "nope")).toBeUndefined();
  });

  it("settles when pi rewound to the parent of a user-message target", () => {
    expect(isNavigationSettled(CHAT, { targetId: "u2", startLeafId: "a2", leafId: "a1" })).toBe(true);
  });

  it("settles when pi rewound before the first message (leaf null)", () => {
    expect(isNavigationSettled(CHAT, { targetId: "u1", startLeafId: "a2", leafId: null })).toBe(true);
  });

  it("still waits while nothing has moved", () => {
    expect(isNavigationSettled(CHAT, { targetId: "u2", startLeafId: "a2", leafId: "a2" })).toBe(false);
    // Moving to null with a non-null expectation is not a landing either.
    expect(isNavigationSettled(CHAT, { targetId: "a1", startLeafId: "a2", leafId: null })).toBe(false);
  });

  it("settles when a summarize appended a new entry at the rewind point", () => {
    const summarized: TreeEntry[] = [...CHAT, { type: "message", id: "s1", parentId: "a1", message: { role: "assistant", content: [] } }];
    expect(isNavigationSettled(summarized, { targetId: "u2", startLeafId: "a2", leafId: "s1" })).toBe(true);
  });

  it("recognises a user-message no-op before sending a command that would hang", () => {
    // The session is already sitting where u2 would put it.
    expect(isAlreadyAtTarget(CHAT, "u2", "a1")).toBe(true);
    // …and pi itself no-ops when the user message IS the leaf.
    expect(isAlreadyAtTarget(CHAT, "u2", "u2")).toBe(true);
    expect(isAlreadyAtTarget(CHAT, "a1", "a2")).toBe(false);
  });
});

describe("nearestVisibleAncestor (where the selection moves when its row is hidden)", () => {
  const chain = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["d", "c"],
  ]);

  it("returns the nearest ancestor the predicate accepts", () => {
    expect(nearestVisibleAncestor(chain, "d", (id) => id === "b")).toBe("b");
  });

  it("accepts the immediate parent without walking further", () => {
    expect(nearestVisibleAncestor(chain, "d", () => true)).toBe("c");
  });

  it("returns null when the chain ends without a visible ancestor", () => {
    expect(nearestVisibleAncestor(chain, "d", () => false)).toBeNull();
    expect(nearestVisibleAncestor(chain, "a", () => true)).toBeNull(); // root has no parent
  });

  it("does not spin when the hidden chain is a parentId RING", () => {
    // The shape that froze the branch dialog: the leaf is an appended settings entry
    // (hidden by the default filter) and its ancestors are a ring nobody can see, so
    // an unbounded walk cycles forever (docs/diagnosis/2026-10-07.md).
    const ring = new Map<string, string | null>([
      ["leaf", "x"],
      ["x", "y"],
      ["y", "x"],
    ]);
    let calls = 0;
    const verdict = nearestVisibleAncestor(ring, "leaf", () => {
      calls += 1;
      return false;
    });
    expect(verdict).toBeNull();
    // Bounded by the ring, not by a timeout: an unbounded walk never returns.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("finds a visible ancestor past a ring it is not part of", () => {
    const mixed = new Map<string, string | null>([
      ["leaf", "x"],
      ["x", "root"],
      ["root", null],
    ]);
    expect(nearestVisibleAncestor(mixed, "leaf", (id) => id === "root")).toBe("root");
  });
});
