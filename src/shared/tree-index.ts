/**
 * tree-index.ts — derived lookups over the session tree, for the branch dialog
 * (TreeDialog.tsx needs a DOM, so anything worth testing lives here).
 *
 * Why this is a module and not a `useMemo` body in the dialog: pi chains EVERY
 * entry onto the previous one, so the depth of a session tree equals the length
 * of the session (a 3000-entry session is a 3000-deep chain — see the note on
 * `conversationLevel` in tree-layout.ts, and the 4532-entry sessions in this
 * repo's own debug logs). A traversal of that structure must not be recursive:
 * measured in the renderer, a recursive walk blew the stack at ~3500 levels and
 * the whole window showed 「界面渲染出错，已阻止白屏 / RangeError: Maximum call
 * stack size exceeded」 — every mounted chat pane, on any long session.
 * See docs/diagnosis/2026-10-07.md.
 */
import type { TreeNode } from "./tree-build";

/** A tool call as the row renderer needs it: display name + the model's args. */
export interface IndexedToolCall {
  name: string;
  args: unknown;
}

/**
 * Every tool call in the tree, by tool-call id (toolResult rows look their call up
 * to show "read path=a.ts" instead of just "toolResult").
 *
 * Iterative + visited-guarded: depth must not be able to blow the render stack, and a
 * tree that repeats a node (buildTreeFromEntries can hand one back when duplicate
 * entry ids disagree about parentId) must terminate instead of recursing forever.
 * Later duplicates win, matching "the last tool call with this id is the live one".
 */
export function indexToolCalls(tree: readonly TreeNode[]): Map<string, IndexedToolCall> {
  const map = new Map<string, IndexedToolCall>();
  // Explicit stack, children pushed right-to-left so the visit order matches the
  // pre-order the recursion had (later duplicates must still win).
  const stack: TreeNode[] = [...tree].reverse();
  const seen = new Set<TreeNode>();
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n.entry.type === "message" && n.entry.message?.role === "assistant") {
      const content = n.entry.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          const block = b as { type?: string; id?: string; name?: string; arguments?: unknown };
          if (block.type === "toolCall" && block.id) map.set(block.id, { name: block.name ?? "tool", args: block.arguments });
        }
      }
    }
    for (let i = n.children.length - 1; i >= 0; i -= 1) stack.push(n.children[i]!);
  }
  return map;
}
