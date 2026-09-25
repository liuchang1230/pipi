/**
 * tree-layout.ts — the pure geometry of the session tree.
 *
 * Extracted from TreeDialog.tsx (which cannot be unit-tested without a DOM) so
 * the two things users actually complain about are verifiable:
 *
 *  1. **"Where is the current conversation?"** `flattenTree` already computed
 *     `containsActive` (which subtree holds the leaf) but only used it to SORT
 *     the active branch first. It now also reports `onActivePath` / `isCurrent`
 *     per row, so the renderer can actually highlight the path and scroll to it.
 *  2. **"Jumping between branches is flaky."** The dialog used to declare a
 *     navigation complete when the leaf ID *changed*, which never happens when
 *     the target IS the current leaf — a very common click (the bottom-most
 *     node, the highlighted one, a branch point that is already the leaf). The
 *     result was a 60s wait and a bogus "导航超时" while the session had already
 *     been there all along. `isNavigationSettled` states the honest rule: the
 *     navigation is done when the target is on the path of the CURRENT leaf
 *     (itself included), which also covers a summarize creating a NEW child.
 */
import type { TreeEntry, TreeNode } from "./tree-build";

export interface TreeFlatRow {
  node: TreeNode;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  isVirtualRootChild: boolean;
  /** Vertical │ gutters at ancestor levels (position = display indent level). */
  gutters: Array<{ position: number; show: boolean }>;
  /** This node lies on the path from a root to the current leaf (or IS it). */
  onActivePath: boolean;
  /** This node IS the current leaf — "the conversation is here". */
  isCurrent: boolean;
}

/** Ancestor ids of `nodeId`, nearest first (excludes `nodeId` itself). */
export function ancestorIds(entries: readonly TreeEntry[], nodeId: string): string[] {
  const parentOf = new Map<string, string | null>();
  for (const e of entries) parentOf.set(e.id, e.parentId ?? null);
  const out: string[] = [];
  let current = parentOf.get(nodeId) ?? null;
  // Bounded by the entry count: a malformed parent chain must not loop forever.
  for (let guard = 0; current !== null && guard <= entries.length; guard++) {
    out.push(current);
    current = parentOf.get(current) ?? null;
  }
  return out;
}

/**
 * Is `targetId` the current position, or an ancestor of it?
 *
 * This is "the session is now sitting at/under the node I clicked". Checking
 * the PATH rather than "the leaf changed" is what makes navigating to the
 * already-current node settle immediately instead of timing out, and it keeps
 * a summarize (which appends a NEW entry as the leaf) counted as settled.
 */
export function isOnLeafPath(entries: readonly TreeEntry[], targetId: string, leafId: string | null): boolean {
  if (!leafId) return false;
  if (targetId === leafId) return true;
  return ancestorIds(entries, leafId).includes(targetId);
}

/**
 * Where does pi put the leaf when you navigate to `targetId`?
 *
 * This mirrors pi's `navigateTree` (agent-session.js) exactly, because getting it
 * wrong is what made "跳转分支" look frozen:
 *
 * ```js
 * if (targetEntry.type === "message" && targetEntry.message.role === "user") {
 *   newLeafId = targetEntry.parentId;   // rewind to BEFORE the prompt…
 *   editorText = contentText(...);      // …and hand its text back to the editor
 * } else if (targetEntry.type === "custom_message") {
 *   newLeafId = targetEntry.parentId;
 * } else {
 *   newLeafId = targetId;
 * }
 * ```
 *
 * Picking a USER message — the most natural click in a branch tree ("回到这里重新
 * 提问") — therefore leaves the leaf at its PARENT, which is not on the target's
 * path. The old completion rule waited for the target to sit on the leaf's path,
 * so it never fired: the dialog spun until its 60s timeout while pi had long
 * finished. `undefined` = target not in the snapshot (cannot tell).
 */
export function navigateLeafId(
  entries: readonly TreeEntry[],
  targetId: string,
): string | null | undefined {
  const entry = entries.find((e) => e.id === targetId);
  if (!entry) return undefined;
  const rewindsBefore =
    entry.type === "custom_message" ||
    (entry.type === "message" && entry.message?.role === "user");
  return rewindsBefore ? entry.parentId ?? null : targetId;
}

/**
 * Is the session already sitting where the target would put it?
 * (i.e. would pi's `navigateTree` no-op?)
 *
 * Two cases: pi short-circuits when the target IS the current leaf, and a
 * user-message target lands on its parent — so being AT the parent already means
 * "there is nothing to navigate". Both must return true, otherwise the dialog
 * sends a command pi refuses to act on and then waits for a leaf change that can
 * never happen.
 */
export function isAlreadyAtTarget(
  entries: readonly TreeEntry[],
  targetId: string,
  leafId: string | null,
): boolean {
  if (leafId !== null && targetId === leafId) return true;
  return navigateLeafId(entries, targetId) === leafId;
}

export interface NavigationState {
  targetId: string;
  /** The leaf when the user pressed Enter — the reference point. */
  startLeafId: string | null;
  /** The leaf as of the latest snapshot. */
  leafId: string | null;
}

/**
 * Has the navigation actually landed?
 *
 * The old rule was "the leaf ID changed", which is wrong in both directions:
 * navigating to the node you are already on never *changes* anything (the
 * dialog then sat on its 60s timer and reported 导航超时 although nothing was
 * wrong), and ANY other change moving the leaf counted as success even if the
 * session had not reached the target.
 *
 * The honest rule needs three facts — the target, where we started, and where
 * we are now:
 *  - nothing moved yet (`leafId === startLeafId`) → not settled (pi may still
 *    be working, and a summarize appends its entry afterwards);
 *  - the leaf moved AND the target sits on the new leaf's path → landed. This
 *    covers "pi made the target the leaf" and "pi appended a summary entry
 *    under the target".
 */
export function isNavigationSettled(entries: readonly TreeEntry[], state: NavigationState): boolean {
  // Nothing moved yet: pi is still working (a summarize appends its entry later).
  if (state.leafId === state.startLeafId) return false;
  const expected = navigateLeafId(entries, state.targetId);
  if (expected === undefined) return false; // target not in this snapshot
  // Rewinding before the first message makes `null` the real new position.
  if (expected === null) return state.leafId === null;
  if (state.leafId === null) return false;
  // `expected` itself counts (no summary) AND any descendant of it counts (a
  // summarize appends a brand-new entry at the rewind point and makes IT the leaf).
  return isOnLeafPath(entries, expected, state.leafId);
}

/** Pure geometry: rows to render, active branch first, with path flags set. */
export function flattenTree(roots: TreeNode[], leafId: string | null): { flat: TreeFlatRow[] } {
  const containsActive = new Map<string, boolean>();
  {
    const all: TreeNode[] = [];
    const stack = [...roots];
    while (stack.length) {
      const n = stack.pop()!;
      all.push(n);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
    // Post-order: does a subtree contain the active leaf?
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i]!;
      let has = leafId !== null && n.entry.id === leafId;
      for (const c of n.children) if (containsActive.get(c.entry.id)) has = true;
      containsActive.set(n.entry.id, has);
    }
  }
  const flat: TreeFlatRow[] = [];
  const multipleRoots = roots.length > 1;
  const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)));
  const stack: Array<[TreeNode, number, boolean, boolean, boolean, Array<{ position: number; show: boolean }>, boolean]> = [];
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    stack.push([orderedRoots[i]!, multipleRoots ? 1 : 0, multipleRoots, multipleRoots, i === orderedRoots.length - 1, [], multipleRoots]);
  }
  while (stack.length) {
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;
    const onActivePath = containsActive.get(node.entry.id) === true;
    flat.push({
      node,
      indent,
      showConnector,
      isLast,
      isVirtualRootChild,
      gutters,
      onActivePath,
      isCurrent: leafId !== null && node.entry.id === leafId,
    });
    const children = node.children;
    const multipleChildren = children.length > 1;
    const orderedChildren = [...children].sort((a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)));
    let childIndent: number;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 1) childIndent = indent + 1;
    else childIndent = indent;
    // The connector this node drew leaves a vertical gutter for its
    // descendants (continues while the node is not the last child) — this is
    // what keeps deep branches visually attached to their parent elbow.
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, displayIndent - 1);
    const childGutters = connectorDisplayed ? [...gutters, { position: connectorPosition, show: !isLast }] : gutters;
    for (let i = orderedChildren.length - 1; i >= 0; i--) {
      stack.push([orderedChildren[i]!, childIndent, multipleChildren, multipleChildren, i === orderedChildren.length - 1, childGutters, false]);
    }
  }
  return { flat };
}
