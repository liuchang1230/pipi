// The mind-map projection: only your messages and the assistant's replies, with
// the survivors re-parented so indentation describes the conversation rather
// than the tool plumbing. Backs the user report 「树状图…不用显示工具调用，只需要
// 显示 user 和 assistant 的回复」.
import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";
import { flattenTree } from "../tree-layout";
import { compactForMindMap, isMindMapEntry } from "../tree-mindmap";
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
    const { flat } = flattenTree(projection.tree, projection.leafId);
    const visible = applyVisibility(flat, "all", "", projection.leafId);
    const roles = visible.map((r) => r.node.entry.message?.role);
    expect(roles.every((r) => r === "user" || r === "assistant")).toBe(true);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    // Indentation is the conversation's depth, not the plumbing's: 4 levels, not 10.
    expect(Math.max(...visible.map((r) => r.indent))).toBeLessThanOrEqual(3);
    // The real leaf is a model_change entry (hidden), so "current" is its nearest
    // kept ancestor — the prompt the session is sitting after.
    expect(visible.filter((r) => r.isCurrent).map((r) => r.node.entry.id)).toEqual(["u2"]);
  });
});
