/**
 * tree-from-file.ts — parse the session tree data straight from a session
 * JSONL file, without asking pi.
 *
 * Why: the RPC `get_tree` path can be slow or unresponsive while the remote
 * pi is still booting (large session / slow server) or has died while the
 * tab record lingers. The session file is append-only and always readable
 * (local disk / SFTP for password remotes / \\wsl$ UNC for WSL), so the tree
 * dialog can paint instantly from it and let RPC refresh live state after.
 *
 * This module only PARSES the file into a flat entry list (entries carry
 * parentId) — the nested tree is built by the SHARED buildTreeFromEntries
 * (src/shared/tree-build.ts). Flat transport matters: Electron's
 * contextBridge rejects objects nested deeper than 1000 levels, and a long
 * linear session is exactly that when serialized as a nested tree.
 *
 * Mirrors pi's own loader semantics:
 *  - non-session lines are entries; blank/malformed lines are skipped
 *  - the leaf is the LAST appended entry (pi recovers the same way on load)
 *
 * Known divergence from the live pi: after an in-memory branch navigation
 * (leaf moved, nothing appended yet) the file still reports the last
 * appended entry as leaf — the next RPC get_entries response corrects it.
 */

export interface RawTreeEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [k: string]: unknown;
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
