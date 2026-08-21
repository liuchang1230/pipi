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

export interface TreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
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
    // Cycle check: walking UP the parent chain from the parent must never
    // reach this node — attaching then would create a ring (A→B→A) whose
    // nested serialization explodes in contextBridge. A ring member is
    // promoted to a root instead.
    let cyclic = false;
    const seen = new Set<string>();
    let cur: string | null = e.parentId;
    while (cur) {
      if (cur === e.id) {
        cyclic = true;
        break;
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = nodeMap.get(cur)?.entry.parentId ?? null;
    }
    const parent = nodeMap.get(e.parentId as string);
    if (parent && parent !== node && !cyclic) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { tree: roots };
}
