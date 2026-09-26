// The mind-map projection: only your messages and the assistant's replies, with
// the survivors re-parented so indentation describes the conversation rather
// than the tool plumbing. Backs the user report 「树状图…不用显示工具调用，只需要
// 显示 user 和 assistant 的回复」.
import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";
import { flattenTree } from "../tree-layout";
import { compactForMindMap, flattenMindMap, isMindMapEntry } from "../tree-mindmap";
import { applyVisibility } from "../tree-view";

function mapOf(entries: TreeEntry[], leafId: string | null) {
  const { tree } = buildTreeFromEntries(entries);
  return compactForMindMap(tree, leafId);
}

/** u1 → a1 → (tool call t1, tool result r1) → a2 → u2 → a3 */
const CHAT: TreeEntry[] = [
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "edit", arguments: {} }] },
  },
  { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "tc1", content: [] } },
  { type: "message", id: "a2", parentId: "r1", message: { role: "assistant", content: [{ type: "text", text: "改好了" }] } },
  { type: "message", id: "u2", parentId: "a2", message: { role: "user", content: [{ type: "text", text: "第二问" }] } },
  { type: "message", id: "a3", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "答案" }] } },
  { type: "label", id: "l1", parentId: "a3", targetId: "u2", label: "重要" },
  { type: "model_change", id: "m1", parentId: "l1", modelId: "x" },
];

describe("isMindMapEntry", () => {
  it("keeps user messages and text-bearing replies", () => {
    expect(isMindMapEntry(CHAT[0]!)).toBe(true);
    expect(isMindMapEntry(CHAT[3]!)).toBe(true);
  });

  it("drops tool-only assistant rows, tool results and bookkeeping", () => {
    expect(isMindMapEntry(CHAT[1]!)).toBe(false); // tool call only
    expect(isMindMapEntry(CHAT[2]!)).toBe(false); // tool result
    expect(isMindMapEntry(CHAT[6]!)).toBe(false); // label
    expect(isMindMapEntry(CHAT[7]!)).toBe(false); // model change
  });

  it("keeps a reply that failed or was aborted even without text", () => {
    expect(
      isMindMapEntry({ type: "message", id: "e", parentId: null, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } }),
    ).toBe(true);
    expect(isMindMapEntry({ type: "message", id: "e", parentId: null, message: { role: "assistant", content: [], stopReason: "aborted" } })).toBe(true);
  });
});

describe("compactForMindMap", () => {
  it("re-parents survivors onto the nearest kept ancestor", () => {
    const { tree, kept, hidden } = mapOf(CHAT, "a3");
    expect(kept).toBe(4); // u1, a2, u2, a3
    expect(hidden).toBe(4);
    // u1 → a2 → u2 → a3, with the tool chain spliced out: no deep indents left.
    const u1 = tree[0]!;
    expect(u1.entry.id).toBe("u1");
    expect(u1.children.map((c) => c.entry.id)).toEqual(["a2"]);
    expect(u1.children[0]!.children.map((c) => c.entry.id)).toEqual(["u2"]);
    expect(u1.children[0]!.children[0]!.children.map((c) => c.entry.id)).toEqual(["a3"]);
  });

  it("keeps branches side by side under the same parent", () => {
    const branched: TreeEntry[] = [
      ...CHAT,
      { type: "message", id: "u2b", parentId: "a2", message: { role: "user", content: [{ type: "text", text: "另一条路" }] } },
    ];
    const { tree } = mapOf(branched, "a3");
    const a2 = tree[0]!.children[0]!;
    expect(a2.children.map((c) => c.entry.id)).toEqual(["u2", "u2b"]);
  });

  it("maps the leaf to the nearest kept ancestor (the reply you are under)", () => {
    // The session's real leaf is a tool result / model-change entry.
    expect(mapOf(CHAT, "r1").leafId).toBe("u1");
    expect(mapOf(CHAT, "m1").leafId).toBe("a3");
    expect(mapOf(CHAT, "u2").leafId).toBe("u2");
  });

  it("has no current position when nothing on the chain is kept", () => {
    const only = [{ type: "model_change", id: "m1", parentId: null, modelId: "x" } as TreeEntry];
    const mapped = mapOf(only, "m1");
    expect(mapped.leafId).toBeNull();
    expect(mapped.tree).toEqual([]);
  });

  it("survives a deep linear session (no recursion, no stack overflow)", () => {
    const deep: TreeEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 5000; i += 1) {
      const id = `e${i}`;
      deep.push(
        i % 2 === 0
          ? { type: "message", id, parentId: parent, message: { role: "user", content: [{ type: "text", text: `q${i}` }] } }
          : { type: "message", id, parentId: parent, message: { role: "toolResult", content: [] } },
      );
      parent = id;
    }
    const { tree, kept, leafId } = mapOf(deep, "e4999");
    expect(kept).toBe(2500);
    expect(leafId).toBe("e4998");
    // A single linear chain: every node has at most one child.
    let node = tree[0]!;
    let depth = 0;
    while (node.children.length > 0) {
      node = node.children[0]!;
      depth += 1;
    }
    expect(depth).toBe(2499);
  });
});

/**
 * The three pure layers the dialog actually chains — build → compact → flatten →
 * visibility — over a session that contains everything a real one does. This is
 * the strongest available check without a DOM (vitest runs in node here, so the
 * component itself can only be verified in the app, see scripts/robustness-smoke.mjs).
 */
describe("mind map pipeline (what the dialog renders)", () => {
  const session: TreeEntry[] = [
    { type: "session_info", id: "s0", parentId: null, name: "会话" },
    { type: "message", id: "u1", parentId: "s0", message: { role: "user", content: [{ type: "text", text: "帮我改一下" }] } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "a.ts" } }] } },
    { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "t1", content: [] } },
    { type: "message", id: "a2", parentId: "r1", message: { role: "assistant", content: [{ type: "text", text: "改好了" }] } },
    { type: "label", id: "l1", parentId: "a2", targetId: "a2", label: "改完" },
    { type: "compaction", id: "c1", parentId: "l1", tokensBefore: 1000 },
    { type: "message", id: "u2", parentId: "c1", message: { role: "user", content: [{ type: "text", text: "再改一处" }] } },
    { type: "model_change", id: "m1", parentId: "u2", modelId: "x" },
    { type: "message", id: "a3", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
  ];

  it("renders only user/assistant rows, with the leaf marked", () => {
    const { tree } = buildTreeFromEntries(session);
    const projection = compactForMindMap(tree, "m1");
    const flat = flattenMindMap(projection.tree, projection.leafId);
    const visible = applyVisibility(flat, "all", "", projection.leafId);
    const roles = visible.map((r) => r.node.entry.message?.role);
    expect(roles.every((r) => r === "user" || r === "assistant")).toBe(true);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    // The map has exactly TWO columns: prompts on the spine, replies one in.
    // (A `<= 3` assertion here passed vacuously while every row was indent 0 —
    // see the regression test below.)
    expect([...new Set(visible.map((r) => r.indent))].sort()).toEqual([0, 1]);
    // The real leaf is a model_change entry (hidden), so "current" is its nearest
    // kept ancestor — the prompt the session is sitting after.
    expect(visible.filter((r) => r.isCurrent).map((r) => r.node.entry.id)).toEqual(["u2"]);
  });
});

/**
 * Regression: 「树状图对齐…感觉同一级别没有完全对齐」.
 *
 * Root cause: the mind map reused `flattenTree`, whose indent rule COLLAPSES linear
 * runs (`else childIndent = indent`) — measured on a 24-node chain, every row came
 * back indent 0. There was no hierarchy to align, and every card sat flush left.
 * `flattenMindMap` gives the map its own layout: prompts on the spine, replies one
 * column in, never deeper.
 */
describe("flattenMindMap (the map's own layout)", () => {
  /** u0 → a0 → u1 → a1, plus a branch: u1 also has a2. */
  const CHAT: TreeEntry[] = [
    { type: "message", id: "u0", parentId: null, message: { role: "user", content: [{ type: "text", text: "q0" }] } },
    { type: "message", id: "a0", parentId: "u0", message: { role: "assistant", content: [{ type: "text", text: "r0" }] } },
    { type: "message", id: "u1", parentId: "a0", message: { role: "user", content: [{ type: "text", text: "q1" }] } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "r1" }] } },
    { type: "message", id: "a2", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "r1b" }] } },
  ];

  function rows(leafId: string) {
    const { tree } = buildTreeFromEntries(CHAT);
    const mind = compactForMindMap(tree, leafId);
    return flattenMindMap(mind.tree, mind.leafId);
  }

  it("puts prompts on the spine and replies one column in", () => {
    const out = rows("a1");
    const indent = Object.fromEntries(out.map((r) => [r.node.entry.id, r.indent]));
    expect(indent.u0).toBe(0);
    expect(indent.a0).toBe(1);
    expect(indent.u1).toBe(0); // the next prompt starts a new spine entry
    expect(indent.a1).toBe(1);
    expect(indent.a2).toBe(1); // a branch's reply is still one column in
  });

  it("never indents deeper than the reply column (alignment is structural)", () => {
    const out = rows("a2");
    expect([...new Set(out.map((r) => r.indent))].sort()).toEqual([0, 1]);
  });

  it("marks exactly one row as the current position", () => {
    const out = rows("a2");
    expect(out.filter((r) => r.isCurrent).map((r) => r.node.entry.id)).toEqual(["a2"]);
  });

  it("keeps the spine rail alive while a prompt has siblings below it", () => {
    const out = rows("a1");
    const u1 = out.find((r) => r.node.entry.id === "u1")!;
    // u1 is the last prompt on the spine, so nothing continues below it…
    expect(u1.gutters.find((g) => g.position === 0)?.show).toBe(false);
    const u0 = out.find((r) => r.node.entry.id === "u0")!;
    // …while u0 is followed by another prompt: its rail continues downward.
    expect(u0.gutters.find((g) => g.position === 0)?.show).toBe(true);
  });

  it("keeps a long linear conversation at exactly two columns", () => {
    const chain: TreeEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const uid = `u${i}`;
      chain.push({ type: "message", id: uid, parentId: parent, message: { role: "user", content: [{ type: "text", text: `q${i}` }] } });
      const aid = `a${i}`;
      chain.push({ type: "message", id: aid, parentId: uid, message: { role: "assistant", content: [{ type: "text", text: `r${i}` }] } });
      parent = aid;
    }
    const { tree } = buildTreeFromEntries(chain);
    const mind = compactForMindMap(tree, "a39");
    const out = flattenMindMap(mind.tree, mind.leafId);
    expect(out.length).toBe(80);
    expect([...new Set(out.map((r) => r.indent))].sort()).toEqual([0, 1]);
  });
});
