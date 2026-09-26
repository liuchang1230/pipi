/**
 * tree-mindmap.ts — the "思维导图" projection of a session tree.
 *
 * The full tree is the truth (every tool call, every bookkeeping entry), but it
 * is a terrible MAP: a single agent turn is dozens of rows, almost all of them
 * tool plumbing, and because the full tree assigns indentation by REAL depth, a
 * row that survives the existing filter still renders at the indent of the hidden
 * ancestors above it — a message in the middle of a long tool chain ended up
 * pushed far to the right for no visible reason. The user's report: 「分支还是不好
 * 用…看不懂」.
 *
 * This projection keeps only what a conversation IS — your messages and the
 * assistant's replies — and re-parents the survivors onto their nearest kept
 * ancestor, so the indentation describes the conversation's shape (prompt →
 * reply → next prompt) instead of the plumbing underneath it. Everything else
 * (tool calls, tool results, labels, model changes, compactions) is spliced out.
 *
 * Pure + iterative: a linear session can be ~3000 entries deep, and recursion
 * would blow the stack (the reason tree-build.ts is iterative too).
 */
import type { TreeEntry, TreeNode } from "./tree-build";
import type { TreeFlatRow } from "./tree-layout";

/** Does this entry belong on the map? (only your messages and AI replies) */
export function isMindMapEntry(entry: TreeEntry): boolean {
  if (entry.type !== "message") return false;
  const role = entry.message?.role;
  if (role === "user") return true;
  if (role !== "assistant") return false;
  // An assistant row that only carries tool calls says nothing; one that failed
  // or was aborted is real news, so it stays even without text.
  if (hasText(entry.message?.content)) return true;
  const stop = entry.message?.stopReason;
  return (stop != null && stop !== "stop" && stop !== "toolUse") || entry.message?.errorMessage != null;
}

function hasText(content: unknown): boolean {
  if (typeof content === "string") return content.replace(/\s+/g, "").length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    const block = b as { type?: string; text?: string };
    return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
  });
}

export interface MindMapProjection {
  /** The projected forest (only kept nodes, re-parented). */
  tree: TreeNode[];
  /** The real leaf mapped to the nearest kept ancestor (`null` if none). */
  leafId: string | null;
  /** How many entries the map shows / hides — used for the honest footer. */
  kept: number;
  hidden: number;
}

/**
 * Project a session tree down to the conversation.
 *
 * `leafId` is mapped to the nearest kept ANCESTOR — the assistant reply (or your
 * prompt) that the session is currently sitting under. Mapping it to a descendant
 * would be wrong, and dropping it would lose 「当前分支在哪」.
 */
export function compactForMindMap(tree: TreeNode[], leafId: string | null): MindMapProjection {
  const roots: TreeNode[] = [];
  const keptNodes = new Map<string, TreeNode>();
  const entries = new Map<string, TreeEntry>();
  let kept = 0;
  let hidden = 0;
  // Explicit stack: the tree can be thousands of levels deep on a linear session.
  const stack: Array<{ node: TreeNode; nearest: string | null }> = [];
  for (let i = tree.length - 1; i >= 0; i -= 1) stack.push({ node: tree[i]!, nearest: null });
  while (stack.length > 0) {
    const { node, nearest } = stack.pop()!;
    const entry = node.entry;
    entries.set(entry.id, entry);
    let nextNearest = nearest;
    if (isMindMapEntry(entry)) {
      const copy: TreeNode = {
        entry,
        children: [],
        label: node.label,
        labelTimestamp: node.labelTimestamp,
      };
      const parent = nearest === null ? undefined : keptNodes.get(nearest);
      if (parent) parent.children.push(copy);
      else roots.push(copy);
      keptNodes.set(entry.id, copy);
      kept += 1;
      nextNearest = entry.id;
    } else {
      hidden += 1;
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: node.children[i]!, nearest: nextNearest });
    }
  }
  // Walk the leaf's parent chain until a kept entry is found.
  let mappedLeaf: string | null = null;
  let cursor = leafId;
  for (let guard = 0; cursor !== null && guard <= entries.size; guard += 1) {
    if (keptNodes.has(cursor)) {
      mappedLeaf = cursor;
      break;
    }
    cursor = entries.get(cursor)?.parentId ?? null;
  }
  return { tree: roots, leafId: mappedLeaf, kept, hidden };
}


/**
 * Lay the map out: YOUR messages form the spine (one column), the AI's replies
 * hang one column in.
 *
 * Why this exists instead of reusing `flattenTree`: that flattener deliberately
 * COLLAPSES linear runs (`else childIndent = indent`), which is right for the
 * /tree log view — and means a linear conversation renders as one flat column.
 * Measured on a 24-node chain: every row came back with indent 0, so the map had
 * no hierarchy to look at and every card was flush left (「同一级别没有完全对齐」).
 *
 * The map's shape follows the conversation instead: a prompt is a spine entry, its
 * replies are indented under it, and the NEXT prompt starts a new spine entry. Two
 * columns total, which is also what makes alignment structural — every row is at
 * exactly `indent × RAIL_W`, no chain-collapsing heuristic involved.
 */
export function flattenMindMap(roots: TreeNode[], leafId: string | null): TreeFlatRow[] {
  const containsActive = new Map<string, boolean>();
  const all: TreeNode[] = [];
  const walk: TreeNode[] = [...roots];
  while (walk.length) {
    const n = walk.pop()!;
    all.push(n);
    for (const c of n.children) walk.push(c);
  }
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const n = all[i]!;
    let has = leafId !== null && n.entry.id === leafId;
    for (const c of n.children) if (containsActive.get(c.entry.id)) has = true;
    containsActive.set(n.entry.id, has);
  }

  const flat: TreeFlatRow[] = [];
  const stack: Array<{ node: TreeNode; isLast: boolean; spineContinues: boolean }> = [];
  const ordered = [...roots].sort(
    (a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)),
  );
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    stack.push({ node: ordered[i]!, isLast: i === ordered.length - 1, spineContinues: false });
  }
  while (stack.length) {
    const { node, isLast, spineContinues } = stack.pop()!;
    const isUser = node.entry.message?.role === "user";
    flat.push({
      node,
      // A prompt is the spine; a reply hangs one column in. Deeper structure is not
      // shown on purpose: it would push cards off-screen for a long conversation.
      indent: isUser ? 0 : 1,
      showConnector: !isUser,
      isLast,
      isVirtualRootChild: false,
      gutters: [{ position: 0, show: spineContinues }], // patched below
      onActivePath: containsActive.get(node.entry.id) === true,
      isCurrent: leafId !== null && node.entry.id === leafId,
    });
    const children = node.children;
    const orderedChildren = [...children].sort(
      (a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)),
    );
    for (let i = orderedChildren.length - 1; i >= 0; i -= 1) {
      stack.push({
        node: orderedChildren[i]!,
        isLast: i === orderedChildren.length - 1,
        // The spine rail continues while this prompt has more siblings below it.
        spineContinues: !isLast,
      });
    }
  }
  // The spine rail runs from the first prompt down to the last one. That is a
  // property of the ORDER, not of the tree: in a conversation the next prompt is a
  // descendant of the previous reply, so sibling bookkeeping can never see it.
  let lastPrompt = -1;
  for (let i = 0; i < flat.length; i += 1) if (flat[i]!.indent === 0) lastPrompt = i;
  for (let i = 0; i < flat.length; i += 1) {
    const row = flat[i]!;
    row.gutters = [{ position: 0, show: i < lastPrompt }];
  }
  return flat;
}
