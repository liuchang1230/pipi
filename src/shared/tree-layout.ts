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
 *  3. **"同一层一定要对齐"** Indentation is the entry's CONVERSATION level
 *     (`conversationLevel`), not its depth in the parentId chain: prompt = 0,
 *     AI reply = 1, tool plumbing = 2. Real depth grows with the length of the
 *     session and forced a "collapse single-child runs" heuristic, so whether a
 *     row moved right depended on whether its ancestors happened to branch —
 *     two rows at the same level ended up in different columns. A level that is
 *     a pure function of the entry makes alignment structural.
 *     The BRANCH is marked in a fixed-width column of its own (`TreeRowMarker`),
 *     never inside the indentation: a child can share its parent's column now,
 *     so a glyph placed at "the parent's column" is not a place that reliably
 *     exists (see the note on `flattenTree`).
 */
import type { TreeEntry, TreeNode } from "./tree-build";

/**
 * The branch glyph a row draws in its fixed-width marker column:
 * `branch-mid` ├ / `branch-last` └ = this row is one of several siblings,
 * `continuation` │ = a branch above it is still open, `none` = neither.
 */
export type TreeRowMarker = "none" | "branch-mid" | "branch-last" | "continuation";

export interface TreeFlatRow {
  node: TreeNode;
  /** Conversation level → the column the row's content starts in. */
  indent: number;
  /** Branch mark, drawn in its own column left of the indentation. */
  marker: TreeRowMarker;
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
 * The nearest ANCESTOR of `startId` (starting from its parent) that `isVisible` accepts,
 * or `null` when the chain runs out.
 *
 * Bounded: a malformed parentId RING (A→B→A) must not spin forever. The branch
 * dialog's "move the selection to a still-visible ancestor" effect used to walk the
 * chain with no bound, so a ring among rows the filter HIDES froze the renderer —
 * no crash screen, no error, just a window that stops answering (docs/diagnosis/
 * 2026-10-07.md). Every other parent-chain walk in the codebase is already bounded
 * this way (`ancestorIds`, `foldedAwayIds`, the transcript builder).
 */
export function nearestVisibleAncestor(
  parentOf: ReadonlyMap<string, string | null>,
  startId: string,
  isVisible: (id: string) => boolean,
): string | null {
  const seen = new Set<string>();
  let current = parentOf.get(startId) ?? null;
  while (current !== null) {
    // Probe each id at most once: an unbounded walk cycles forever on a ring.
    if (seen.has(current)) return null;
    seen.add(current);
    if (isVisible(current)) return current;
    current = parentOf.get(current) ?? null;
  }
  return null;
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

/**
 * Which COLUMN does this entry belong in?
 *
 * 0 = a prompt (your message — the spine), 1 = the AI's reply to a prompt, 2 =
 * everything that hangs off a reply (tool calls, tool results, bash output,
 * labels, model/thinking changes, compactions, titles).
 *
 * Why not the depth of the parentId chain: pi chains EVERY entry onto the
 * previous one, so real depth grows with the LENGTH of the session (a
 * 3000-entry session is 3000 levels deep) while saying nothing about the
 * conversation — a reply in the middle of a long tool chain rendered at the
 * indent of the hidden plumbing above it. The old rule therefore had to
 * collapse single-child runs (or every session would march off to the right),
 * which made a row's indent depend on branch luck: two entries at the same
 * level did not line up (「同一层一定要对齐」).
 */
export function conversationLevel(entry: TreeEntry): number {
  if (entry.type === "message") {
    const role = entry.message?.role;
    if (role === "user") return 0;
    if (role === "assistant") return 1;
    return 2; // toolResult / bashExecution / an unknown role
  }
  // A replayed prompt — pi rewinds to before it (see navigateLeafId), so it reads
  // like a prompt rather than like plumbing.
  if (entry.type === "custom_message") return 0;
  return 2; // compaction / branch_summary / model_change / label / session_info / custom
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
  const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)));
  /**
   * [node, isBranchChild, isLastSibling, insideOpenBranch]
   *
   * Why a marker instead of the old elbow+gutter rails: that scheme put the
   * elbow at `indent - 1`, which is the PARENT's column only while a child is
   * exactly one column right of its parent. That held when `indent` meant
   * branch nesting (one step per fork, hence the single-child collapsing); with
   * conversation levels a child often sits in the SAME column as its parent, so
   * the elbow landed on a column the parent had already registered a gutter for
   * and was silently dropped (measured on a session with two forks: not one
   * elbow was drawn). One always-present marker column cannot collide, because
   * it does not depend on the parent's column at all.
   *
   * Two limits, both cosmetic and both accepted:
   *  - the marks describe the FULL tree (they are what `flattenTree` is for); the
   *    dialog filters/folds afterwards, so a hidden sibling can leave a ├ standing
   *    alone and a │ can point at a parent that is not on screen.
   *  - one marker column shows the INNERMOST open branch. A sibling group nested
   *    inside another open branch therefore draws `├├└└` without the outer │ — a
   *    second gutter would have to be added to show both at once.
   */
  const stack: Array<[TreeNode, boolean, boolean, boolean]> = [];
  for (let i = orderedRoots.length - 1; i >= 0; i -= 1) {
    stack.push([orderedRoots[i]!, false, i === orderedRoots.length - 1, false]);
  }
  while (stack.length) {
    const [node, isBranchChild, isLastSibling, insideOpenBranch] = stack.pop()!;
    flat.push({
      node,
      indent: conversationLevel(node.entry),
      marker: isBranchChild ? (isLastSibling ? "branch-last" : "branch-mid") : insideOpenBranch ? "continuation" : "none",
      onActivePath: containsActive.get(node.entry.id) === true,
      isCurrent: leafId !== null && node.entry.id === leafId,
    });
    const children = node.children;
    const multipleChildren = children.length > 1;
    // A row that is not the last of several siblings keeps a │ alive for its own
    // descendants: they are still inside that branch.
    const childInsideBranch = insideOpenBranch || (isBranchChild && !isLastSibling);
    const orderedChildren = [...children].sort((a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)));
    for (let i = orderedChildren.length - 1; i >= 0; i -= 1) {
      // The COLUMN comes from the child's own entry, never from the parent's
      // indent — that is what makes same-level rows line up (conversationLevel).
      stack.push([orderedChildren[i]!, multipleChildren, i === orderedChildren.length - 1, childInsideBranch]);
    }
  }
  return { flat };
}
