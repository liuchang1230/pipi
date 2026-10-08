/**
 * tree-index — the lookup the branch dialog builds on every render.
 *
 * The regression this pins (docs/diagnosis/2026-10-07.md): the walk used to be
 * recursive over `children`, and because pi chains every entry onto the previous
 * one, a long session is a deep chain. Measured in the renderer, the recursion
 * died at ~3500 levels — the branch dialog then replaced the whole window with
 * 「界面渲染出错，已阻止白屏 / RangeError: Maximum call stack size exceeded」.
 * These tests run in node (no DOM), so the depth they can prove is bounded by
 * node's own stack: 20000 is far past the ~3500 that killed the dialog.
 */
import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry, type TreeNode } from "../tree-build";
import { indexToolCalls } from "../tree-index";

function msg(id: string, parentId: string | null, content: unknown, role = "assistant"): TreeEntry {
  return { type: "message", id, parentId, message: { role, content } } as TreeEntry;
}

/** A tool-call-only assistant entry, exactly like pi writes it. */
function toolCall(id: string, parentId: string | null, tcId: string, name = "read", args: unknown = { path: "a.ts" }): TreeEntry {
  return msg(id, parentId, [{ type: "toolCall", id: tcId, name, arguments: args }]);
}

describe("indexToolCalls", () => {
  it("indexes every tool call of a branched session", () => {
    const { tree } = buildTreeFromEntries([
      msg("a", null, [{ type: "text", text: "问题" }], "user"),
      toolCall("b", "a", "tc1"),
      msg("c", "a", [{ type: "text", text: "另一支" }]),
      toolCall("d", "c", "tc2", "bash", { command: "ls" }),
    ]);
    const calls = indexToolCalls(tree);
    expect([...calls.keys()].sort()).toEqual(["tc1", "tc2"]);
    expect(calls.get("tc2")).toEqual({ name: "bash", args: { command: "ls" } });
  });

  it("names an unnamed tool call 'tool' and keeps the model's args verbatim", () => {
    const { tree } = buildTreeFromEntries([msg("a", null, [{ type: "toolCall", id: "tc1", arguments: { edits: [{ newText: "x" }] } }])]);
    const calls = indexToolCalls(tree);
    expect(calls.get("tc1")!.name).toBe("tool");
    expect(calls.get("tc1")!.args).toEqual({ edits: [{ newText: "x" }] });
  });

  it("ignores assistant entries that carry no tool call", () => {
    const { tree } = buildTreeFromEntries([msg("a", null, [{ type: "text", text: "只是文字" }]), msg("b", "a", "字符串内容")]);
    expect(indexToolCalls(tree).size).toBe(0);
  });

  it("indexes a deep linear session without blowing the stack (the 白屏 regression)", () => {
    // 20000 chained entries = the shape of a long session. The recursive walk this
    // replaced threw RangeError at ~3500 in the renderer, well below this.
    const entries: TreeEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 20000; i++) {
      const id = `e${i}`;
      entries.push(toolCall(id, parent, `tc${i}`));
      parent = id;
    }
    const { tree } = buildTreeFromEntries(entries);
    const calls = indexToolCalls(tree);
    expect(calls.size).toBe(20000);
    expect(calls.get("tc19999")).toEqual({ name: "read", args: { path: "a.ts" } });
  });

  it("terminates on a tree that repeats a node instead of recursing forever", () => {
    // buildTreeFromEntries can return a cyclic tree when duplicate entry ids
    // disagree about parentId; the index must survive that rather than hang.
    const a: TreeNode = { entry: toolCall("a", null, "tc-a"), children: [] };
    const b: TreeNode = { entry: toolCall("b", "a", "tc-b"), children: [] };
    a.children.push(b);
    b.children.push(a); // the cycle
    expect([...indexToolCalls([a]).keys()].sort()).toEqual(["tc-a", "tc-b"]);
  });
});
