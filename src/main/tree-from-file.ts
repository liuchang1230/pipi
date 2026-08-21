/**
 * tree-from-file.ts — build the session tree straight from a session JSONL
 * file, without asking pi.
 *
 * Why: the RPC `get_tree` path can be slow or unresponsive while the remote
 * pi is still booting (large session / slow server) or has died while the
 * tab record lingers. The session file is append-only and always readable
 * (local disk / SFTP for password remotes / \\wsl$ UNC for WSL), so the tree
 * dialog can paint instantly from it and let `get_tree` correct/refresh live
 * state afterwards (in-memory leaf after a branch navigation, streaming
 * updates, …).
 *
 * Mirrors SessionManager.getTree()/getLeafId() semantics (pi's own loader):
 *  - non-session lines are entries; blank/malformed lines are skipped
 *  - parentId chains form the tree; orphaned/broken chains become roots
 *  - label entries resolve node labels (and clear them when label is falsy)
 *  - the leaf is the LAST appended entry (pi recovers the same way on load)
 *
 * Known divergence from the live pi: after an in-memory branch navigation
 * (leaf moved, nothing appended yet) the file still reports the last
 * appended entry as leaf — the next `get_tree` response corrects it.
 */

export interface RawTreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [k: string]: unknown;
}

export interface FileTreeNode {
  entry: RawTreeEntry;
  children: FileTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface ParsedTreeFile {
  entries: RawTreeEntry[];
  leafId: string | null;
}

/** Sync parse of a session file's raw entries (unit-test friendly). */
export function parseTreeEntries(content: string): ParsedTreeFile {
  const entries: RawTreeEntry[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // blank/malformed line — skip, matching loadEntriesFromFile
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const record = obj as Record<string, unknown>;
    if (record.type === "session") continue; // header only
    if (typeof record.id === "string") {
      entries.push(record as unknown as RawTreeEntry);
    }
  }
  return { entries, leafId: entries.length > 0 ? entries[entries.length - 1]!.id : null };
}

/** Cooperative variant: yields to the event loop every N lines so a multi-MB
 *  session file never blocks the main process long enough to stall IPC. */
export async function parseTreeFileAsync(content: string, yieldEvery = 400): Promise<ParsedTreeFile> {
  const lines = content.split("\n");
  const entries: RawTreeEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    if (i > 0 && i % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const record = obj as Record<string, unknown>;
    if (record.type === "session") continue;
    if (typeof record.id === "string") {
      entries.push(record as unknown as RawTreeEntry);
    }
  }
  return { entries, leafId: entries.length > 0 ? entries[entries.length - 1]!.id : null };
}

/** Build the tree structure (roots/children/labels) from parsed entries. */
export function buildFileTree(entries: RawTreeEntry[]): { tree: FileTreeNode[] } {
  // Resolve label entries first (mirrors SessionManager._buildIndex: only
  // truthy label strings set a label; falsy/empty clears it).
  const labels = new Map<string, { label?: string; timestamp?: string }>();
  for (const e of entries) {
    if (e.type === "label" && typeof e.targetId === "string") {
      const label = typeof e.label === "string" && e.label.length > 0 ? e.label : undefined;
      labels.set(e.targetId, { label, timestamp: label ? e.timestamp : undefined });
    }
  }
  const nodeMap = new Map<string, FileTreeNode>();
  for (const entry of entries) {
    nodeMap.set(entry.id, { entry, children: [] });
  }
  const roots: FileTreeNode[] = [];
  // Children keep FILE order (== append order). pi's getTree() sorts by
  // timestamp; for an append-only file the two orders coincide, and the
  // renderer re-orders by active-branch anyway, so no extra sort here.
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    const l = labels.get(entry.id);
    if (l) {
      if (l.label !== undefined) node.label = l.label;
      if (l.timestamp !== undefined) node.labelTimestamp = l.timestamp;
    }
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node); // orphaned (broken parent chain) — treat as root
    }
  }
  return { tree: roots };
}
