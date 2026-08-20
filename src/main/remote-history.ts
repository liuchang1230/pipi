import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RemoteHistoryEntry {
  id: string;
  host: string;
  user: string;
  port: number;
  password?: string;
  path?: string;
  agentDir?: string;
  updatedAt: number;
}

function historyPath(): string {
  return join(app.getPath("userData"), "remote-history.json");
}

function readHistory(): RemoteHistoryEntry[] {
  const file = historyPath();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeHistory(list: RemoteHistoryEntry[]): void {
  const file = historyPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2), "utf8");
}

export function listRemoteHistory(): RemoteHistoryEntry[] {
  return readHistory().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Remove a saved connection matching the server key (host+user+port+
 *  agentDir). Returns false when nothing matched. Used by the sidebar's
 *  "删除服务器" cascade — deleting just the projects would leave the history
 *  entry (and thus the server node) alive. */
export function deleteRemoteHistory(target: { host: string; user: string; port: number; agentDir?: string }): boolean {
  const list = readHistory();
  const next = list.filter(
    (i) => !(i.host === target.host && i.user === target.user && i.port === target.port && (i.agentDir ?? "") === (target.agentDir ?? "")),
  );
  if (next.length === list.length) return false;
  writeHistory(next);
  return true;
}

export function saveRemoteHistory(entry: { host: string; user: string; port?: number; password?: string; path?: string; agentDir?: string }): RemoteHistoryEntry {
  const list = readHistory();
  const port = entry.port ?? 22;
  const now = Date.now();
  // Same server with a DIFFERENT agentDir is a different data space (several
  // colleagues sharing one account) → keep them as separate history entries.
  const existing = list.find(
    (i) => i.host === entry.host && i.user === entry.user && i.port === port && (i.agentDir ?? "") === (entry.agentDir ?? "")
  );
  if (existing) {
    existing.password = entry.password;
    existing.path = entry.path;
    existing.agentDir = entry.agentDir;
    existing.updatedAt = now;
    writeHistory(list);
    return existing;
  }
  const item: RemoteHistoryEntry = {
    id: `remote-history-${now}-${Math.random().toString(36).slice(2, 8)}`,
    host: entry.host,
    user: entry.user,
    port,
    password: entry.password,
    path: entry.path,
    agentDir: entry.agentDir,
    updatedAt: now,
  };
  list.push(item);
  writeHistory(list);
  return item;
}
