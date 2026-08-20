/**
 * SessionIndex — the single module that owns "list the sessions of a cwd".
 *
 * Previously session listing logic was split across five implementations:
 *   - `listSessions` (sync, uncached, unbounded) behind `session:list`
 *   - `pollLocalSessionsOnce` (snapshot incremental) in index.ts
 *   - `wslScanSessionDir` (its own snapshot cache) in index.ts
 *   - the remote cache + hydration pipeline in index.ts
 *   - the auto-follow / title watchers (their own stat scans)
 *
 * Every caller of the LOCAL path (the click path: `session:list` + the 4s
 * poll + the active-tab session cache) now crosses the same seam:
 *
 *   cached(cwd)          — sync peek (TTL-guarded), used by the activation
 *                          payload so the renderer can skip a round-trip
 *   refresh(cwd)         — async incremental parse (only files whose
 *                          mtime/size changed), cooperative line-by-line so a
 *                          multi-MB jsonl never blocks the event loop
 *   startPolling/stop    — the 4s poll, owned here instead of in index.ts
 *   onChange(cwd, cb)    — change subscription (emitted only on real changes)
 *
 * The WSL/SSH backends keep their own adapters (they read via \\wsl$ UNC /
 * SFTP); the seam is the same, the adapters differ.
 */
import { existsSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd, decodeCwd, parseSessionTextAsync, type SessionEntry } from "./session-list";

const POLL_INTERVAL_MS = 4000;
/** session:list / activation payload serve from cache when fresher than this. */
const CACHE_TTL_MS = 8000;

interface DirSnapshotEntry {
  path: string;
  mtime: number;
  size: number;
}

type SessionListener = (sessions: SessionEntry[]) => void;
type AnyChangeListener = (cwd: string, sessions: SessionEntry[]) => void;

export class SessionIndex {
  private snapshots = new Map<string, DirSnapshotEntry[]>();
  private lists = new Map<string, SessionEntry[]>();
  private refreshedAt = new Map<string, number>();
  private listeners = new Map<string, Set<SessionListener>>();
  private anyListeners = new Set<AnyChangeListener>();
  private inflight = new Map<string, Promise<SessionEntry[]>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polledCwd: string | null = null;
  private agentDir = join(homedir(), ".pi", "agent");

  setAgentDir(agentDir: string): void {
    if (this.agentDir === agentDir) return;
    this.agentDir = agentDir;
    this.snapshots.clear();
    this.lists.clear();
    this.refreshedAt.clear();
    this.inflight.clear();
  }

  /** Sync peek. Returns undefined when the cache is stale or absent. */
  cached(cwd: string): SessionEntry[] | undefined {
    const refreshedAt = this.refreshedAt.get(cwd);
    if (refreshedAt === undefined || Date.now() - refreshedAt > CACHE_TTL_MS) {
      return undefined;
    }
    return this.lists.get(cwd);
  }

  /** Async refresh of one cwd. Re-reads only changed files; emits on change.
   *  Concurrent calls for the same cwd share one in-flight parse so an older
   *  snapshot can never overwrite a newer one. */
  async refresh(cwd: string): Promise<SessionEntry[]> {
    const existing = this.inflight.get(cwd);
    if (existing) return existing;
    const p = this.doRefresh(cwd);
    this.inflight.set(cwd, p);
    try {
      return await p;
    } finally {
      if (this.inflight.get(cwd) === p) this.inflight.delete(cwd);
    }
  }

  private async doRefresh(cwd: string): Promise<SessionEntry[]> {
    const dir = sessionDirFor(cwd, this.agentDir);
    let snap: DirSnapshotEntry[];
    try {
      if (!existsSync(dir)) {
        const oldList = this.lists.get(cwd);
        this.snapshots.set(cwd, []);
        this.lists.set(cwd, []);
        this.refreshedAt.set(cwd, Date.now());
        this.emitIfChanged(cwd, oldList, []);
        return [];
      }
      const names = await readdir(dir);
      const entries: DirSnapshotEntry[] = [];
      for (const f of names) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(dir, f);
        try {
          const s = await stat(full);
          entries.push({ path: full, mtime: s.mtimeMs, size: s.size });
        } catch {
          // File vanished between readdir and stat — skip it this scan.
        }
      }
      snap = entries;
    } catch {
      // Dir vanished or locked — keep the previous list, don't clear it.
      return this.lists.get(cwd) ?? [];
    }
    // Capture the PREVIOUS snapshot before overwriting it below.
    const prevSnap = this.snapshots.get(cwd);
    this.snapshots.set(cwd, snap);

    // Reuse cached entries for unchanged files; re-parse only the rest.
    const prevEntries = new Map((this.lists.get(cwd) ?? []).map((e) => [e.path, e]));
    const changedPaths = new Set<string>();
    for (const f of snap) {
      const old = prevSnap?.find((x) => x.path === f.path);
      if (!old || old.mtime !== f.mtime || old.size !== f.size) {
        changedPaths.add(f.path);
      }
    }

    const next: SessionEntry[] = [];
    for (const f of snap) {
      const cachedEntry = prevEntries.get(f.path);
      if (cachedEntry && !changedPaths.has(f.path)) {
        next.push(cachedEntry);
        continue;
      }
      let parsed: SessionEntry | null = null;
      try {
        const content = await readFile(f.path, "utf8");
        parsed = await parseSessionTextAsync(content, f.path, { mtime: f.mtime, size: f.size });
      } catch {
        parsed = null;
      }
      // Parse failure (file transiently locked mid-write): keep the previous
      // entry instead of dropping the session from the sidebar for one poll.
      next.push(parsed ?? cachedEntry ?? {
        path: f.path,
        sessionId: "",
        mtime: f.mtime,
        size: f.size,
        messageCount: 0,
        firstMessage: "",
        name: null,
      });
    }
    next.sort((a, b) => b.mtime - a.mtime);
    const oldList = this.lists.get(cwd);
    this.lists.set(cwd, next);
    this.refreshedAt.set(cwd, Date.now());
    this.emitIfChanged(cwd, oldList, next);
    return next;
  }

  /** Drop a cwd from the index (project removed / renamed). */
  remove(cwd: string): void {
    this.snapshots.delete(cwd);
    this.lists.delete(cwd);
    this.refreshedAt.delete(cwd);
    this.listeners.delete(cwd);
  }

  /** Forget a session FILE's cwd cache so the next session:list re-scans
   *  (deleted/renamed sessions must not resurrect from the cache). */
  invalidateFile(filePath: string): void {
    const dir = filePath.replace(/\\/g, "/").split("/");
    dir.pop(); // drop the file name
    const encoded = dir[dir.length - 1] ?? "";
    const decoded = decodeCwd(encoded);
    if (decoded) this.remove(decoded);
  }

  onChange(cwd: string, listener: SessionListener): () => void {
    let set = this.listeners.get(cwd);
    if (!set) {
      set = new Set();
      this.listeners.set(cwd, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** Subscribe to changes for ANY cwd (used to forward session:local-updated). */
  onAnyChange(listener: AnyChangeListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /** The 4s poll for one active cwd (mirrors the old startLocalSessionsPoll). */
  startPolling(cwd: string): void {
    this.stopPolling();
    this.polledCwd = cwd;
    void this.refresh(cwd);
    this.pollTimer = setInterval(() => {
      void this.refresh(cwd);
    }, POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polledCwd = null;
  }

  private emitIfChanged(cwd: string, prev: SessionEntry[] | undefined, next: SessionEntry[]): void {
    const changed =
      !prev ||
      prev.length !== next.length ||
      prev.some((e, i) => {
        const n = next[i];
        return !n || e.path !== n.path || e.mtime !== n.mtime || e.size !== n.size || e.messageCount !== n.messageCount;
      });
    if (!changed) return;
    const set = this.listeners.get(cwd);
    if (set) {
      for (const cb of set) {
        try {
          cb(next);
        } catch {
          /* listener must not break the poll */
        }
      }
    }
    for (const cb of this.anyListeners) {
      try {
        cb(cwd, next);
      } catch {
        /* listener must not break the poll */
      }
    }
  }
}

/** Kept local for compatibility with older imports; use the selected profile. */
function sessionDirFor(cwd: string, agentDir = join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "sessions", encodeCwd(cwd));
}
