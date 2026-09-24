/**
 * tree-build.ts — build a session tree from a FLAT entry list (parentId
 * chains), shared by the main process (file parsing) and the renderer
 * (RPC get_entries responses).
 *
 * Why flat-in / nested-out: Electron's contextBridge rejects objects nested
 * deeper than 1000 levels when crossing into the renderer (recursion depth
 * exceeded). A linear session with hundreds of messages is exactly that — a
 * nested tree blows the limit and the renderer silently never gets the data.
 * Entries carry parentId, so the flat array is the safe transport; the tree
 * is reconstructed here with an iterative, cycle-safe build.
 */

/**
 * One session-tree entry (pi's JSONL record, flattened for transport).
 *
 * The named fields exist so consumers get real types rather than having to cast
 * out of the index signature (which stays for forward compatibility with newer
 * pi versions). Rendering a tree means reading `message.role`/`content` on every
 * row; leaving those `unknown` pushed casts into the UI layer, where a shape
 * change would then fail at runtime instead of at compile time.
 */
export interface TreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; toolCallId?: string };
  modelId?: string;
  thinkingLevel?: string;
  summary?: string;
  name?: string;
  customType?: string;
  content?: unknown;
  tokensBefore?: number;
  toolName?: string;
  toolCallId?: string;
  command?: string;
  label?: string;
  [k: string]: unknown;
}

export interface TreeNode {
  entry: TreeEntry;
  children: TreeNode[];
  label?: string;
  labelTimestamp?: string;
}

/**
 * Build the tree structure from flat entries. Mirrors pi's
 * SessionManager.getTree semantics: parentId chains form the tree, orphans /
 * broken chains become roots, label entries resolve node labels (truthy
 * strings only). Cycle-safe: a node whose parent is already attached
 * elsewhere (a ring like A→B→A) is promoted to a root instead of creating a
 * circular children reference (which is what made the previous nested-tree
 * transport explode in contextBridge).
 */
export function buildTreeFromEntries(entries: TreeEntry[]): { tree: TreeNode[] } {
  // Resolve label entries first (only truthy label strings set a label).
  const labels = new Map<string, { label?: string; timestamp?: string }>();
  for (const e of entries) {
    if (e.type === "label" && typeof e.targetId === "string") {
      const label = typeof e.label === "string" && e.label.length > 0 ? e.label : undefined;
      labels.set(e.targetId, { label, timestamp: label ? e.timestamp : undefined });
    }
  }
  const nodeMap = new Map<string, TreeNode>();
  for (const e of entries) {
    nodeMap.set(e.id, { entry: e, children: [] });
  }
  // Cycle detection must not walk the parent chain once PER ENTRY: on a linear
  // session that is O(n·depth), which measured 150ms for a 3000-entry session —
  // paid on every snapshot (open, 3s poll, file fallback) and squarely on the
  // main thread, i.e. exactly the "打开分支有点卡顿" the user reported. Instead
  // the chains are coloured once with memoization, so the total work is O(n).
  const parentOf = new Map<string, string | null>();
  for (const e of entries) parentOf.set(e.id, e.parentId ?? null);
  const UNKNOWN = 0;
  const VISITING = 1;
  const CLEAN = 2; // provably not on a cycle (may lead into one)
  const ON_CYCLE = 3;
  const cycleState = new Map<string, number>();
  /** Is `start` itself part of a parentId ring (A→B→A)? */
  const isOnCycle = (start: string): boolean => {
    // Memoized answer for `start` ITSELF (a ring member queried a second time:
    // "leads into a ring" and "is on a ring" are different answers).
    const known = cycleState.get(start) ?? UNKNOWN;
    if (known === ON_CYCLE) return true;
    if (known === CLEAN) return false;
    const path: string[] = [];
    let cur: string | null = start;
    let result = false;
    for (;;) {
      if (cur === null) break;
      const state = cycleState.get(cur) ?? UNKNOWN;
      if (state === ON_CYCLE || state === CLEAN) break;
      if (state === VISITING) {
        // Closed a ring: everything from `cur` onwards is on it, the prefix
        // merely leads into it.
        const at = path.indexOf(cur);
        for (let i = 0; i < at; i++) cycleState.set(path[i]!, CLEAN);
        for (let i = at; i < path.length; i++) cycleState.set(path[i]!, ON_CYCLE);
        result = cycleState.get(start) === ON_CYCLE;
        break;
      }
      cycleState.set(cur, VISITING);
      path.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    // Anything still marked VISITING ran into a null parent: it is clean.
    for (const id of path) if ((cycleState.get(id) ?? UNKNOWN) === VISITING) cycleState.set(id, CLEAN);
    return result;
  };

  const roots: TreeNode[] = [];
  for (const e of entries) {
    const node = nodeMap.get(e.id);
    if (!node) continue;
    const l = labels.get(e.id);
    if (l) {
      if (l.label !== undefined) node.label = l.label;
      if (l.timestamp !== undefined) node.labelTimestamp = l.timestamp;
    }
    if (e.parentId === null || e.parentId === e.id) {
      roots.push(node);
      continue;
    }
    // Attaching a ring member would create a cycle whose nested serialization
    // explodes in contextBridge, so it is promoted to a root instead.
    const parent = nodeMap.get(e.parentId as string);
    if (parent && parent !== node && !isOnCycle(e.id)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { tree: roots };
}
