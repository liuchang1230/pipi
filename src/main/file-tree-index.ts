/**
 * FileTreeIndex — the module that owns "list the files under a root dir".
 *
 * Mirrors the SessionIndex seam: the renderer's file:list invoke, the tree
 * refreshes after auto-follow writes, and the mutation invalidation all cross
 * the same cached/refresh/invalidate surface. The remote/WSL backends keep
 * their own 5s TTL adapters (they read via SFTP / \\wsl$); this index serves
 * the LOCAL path that was previously an uncached full walk on every call.
 *
 *   cached(rootDir)     — sync peek (TTL-guarded), used by the click path
 *   refresh(rootDir)    — async walk + cache; concurrent calls for the same
 *                         root share one in-flight walk
 *   invalidate(rootDir) — drop the entry AND bump the root's generation so an
 *                         already-running walk cannot re-cache the
 *                         pre-mutation snapshot (a just-mutated tree never
 *                         serves a stale listing for the next TTL)
 */
import { listFiles, type FileNode } from "./file-tree";

const CACHE_TTL_MS = 5000;
/** Cap on cached roots: each entry is a full recursive tree, so bound memory.
 *  Oldest entry is dropped past the cap (Map preserves insertion order). */
const MAX_CACHED_ROOTS = 32;

export type TreeWalker = (rootDir: string) => Promise<FileNode[]>;

interface CacheEntry {
  expiresAt: number;
  nodes: FileNode[];
}

export class FileTreeIndex {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<FileNode[]>>();
  /** Per-root invalidation counter. A walk captures the generation before
   *  walking and only caches if it still matches when it finishes — so an
   *  invalidate() that lands mid-walk cannot be undone by the stale walk. */
  private generations = new Map<string, number>();

  constructor(private readonly walk: TreeWalker = listFiles) {}

  /** Sync peek. Returns undefined when absent or stale (never a stale read). */
  cached(rootDir: string): FileNode[] | undefined {
    const hit = this.cache.get(rootDir);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(rootDir);
      return undefined;
    }
    return hit.nodes;
  }

  /** Async walk + cache. Concurrent calls for the same root share one
   *  in-flight walk so a burst of refresh triggers can never double-walk. */
  refresh(rootDir: string): Promise<FileNode[]> {
    const existing = this.inflight.get(rootDir);
    if (existing) return existing;
    const gen = this.generations.get(rootDir) ?? 0;
    const p = this.doRefresh(rootDir, gen);
    this.inflight.set(rootDir, p);
    return p.finally(() => {
      if (this.inflight.get(rootDir) === p) this.inflight.delete(rootDir);
    });
  }

  private async doRefresh(rootDir: string, gen: number): Promise<FileNode[]> {
    const nodes = await this.walk(rootDir);
    // An invalidation landed while we were walking: the snapshot predates the
    // mutation — return it to THIS caller (their request is that old) but do
    // not re-cache it. The post-invalidation refresh starts a fresh walk.
    if ((this.generations.get(rootDir) ?? 0) !== gen) return nodes;
    this.cache.set(rootDir, { expiresAt: Date.now() + CACHE_TTL_MS, nodes });
    if (this.cache.size > MAX_CACHED_ROOTS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return nodes;
  }

  /** Drop the entry for a root and invalidate any in-flight walk for it.
   *  Called after any local mutation so the next listing re-walks instead of
   *  serving the pre-mutation snapshot. */
  invalidate(rootDir: string): void {
    this.generations.set(rootDir, (this.generations.get(rootDir) ?? 0) + 1);
    this.cache.delete(rootDir);
    // Drop the in-flight promise too: a post-invalidation refresh must start
    // a FRESH walk, not join the stale one (which would hand it the
    // pre-mutation snapshot).
    this.inflight.delete(rootDir);
  }
}
