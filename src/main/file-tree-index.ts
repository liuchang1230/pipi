/**
 * FileTreeIndex — the module that owns "list the children of a directory".
 *
 * Mirrors the SessionIndex seam: the renderer's file:list invoke, the tree
 * refreshes after auto-follow writes, and the mutation invalidation all cross
 * the same cached/refresh/invalidate surface. Cache entries are PER-DIRECTORY
 * shallow listings (the tree is lazy — expanded directories are fetched on
 * demand), keyed by the directory's absolute path. The remote/WSL backends
 * keep their own 5s TTL adapters (they read via SFTP / \\wsl$); this index
 * serves the LOCAL path.
 *
 *   cached(dirPath)     — sync peek (TTL-guarded), used by the click path
 *   refresh(dirPath)    — async listing + cache; concurrent calls for the
 *                         same dir share one in-flight walk
 *   invalidate(dirPath) — drop the entry AND bump the dir's generation so an
 *                         already-running walk cannot re-cache the
 *                         pre-mutation snapshot
 */
import { listDirChildren, type FileNode } from "./file-tree";

const CACHE_TTL_MS = 5000;
/** Cap on cached directories: each entry is a shallow listing, but a deeply
 *  browsed tree can accumulate many. Oldest entry is dropped past the cap
 *  (Map preserves insertion order). */
const MAX_CACHED_DIRS = 128;

export type TreeWalker = (dirPath: string) => Promise<FileNode[]>;

export function defaultTreeWalker(dirPath: string): Promise<FileNode[]> {
  return listDirChildren(dirPath, ".");
}

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

  constructor(private readonly walk: TreeWalker = defaultTreeWalker) {}

  /** Sync peek. Returns undefined when absent or stale (never a stale read). */
  cached(dirPath: string): FileNode[] | undefined {
    const hit = this.cache.get(dirPath);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(dirPath);
      return undefined;
    }
    return hit.nodes;
  }

  /** Async listing + cache. Concurrent calls for the same dir share one
   *  in-flight walk so a burst of refresh triggers can never double-walk.
   *  `walk` overrides the walker for this call (e.g. a subdir listing whose
   *  paths must stay relative to the project root). */
  refresh(dirPath: string, walk?: TreeWalker): Promise<FileNode[]> {
    const existing = this.inflight.get(dirPath);
    if (existing) return existing;
    const gen = this.generations.get(dirPath) ?? 0;
    const p = this.doRefresh(dirPath, gen, walk);
    this.inflight.set(dirPath, p);
    return p.finally(() => {
      if (this.inflight.get(dirPath) === p) this.inflight.delete(dirPath);
    });
  }

  private async doRefresh(dirPath: string, gen: number, walk?: TreeWalker): Promise<FileNode[]> {
    const nodes = await (walk ?? this.walk)(dirPath);
    // An invalidation landed while we were walking: the snapshot predates the
    // mutation — return it to THIS caller (their request is that old) but do
    // not re-cache it. The post-invalidation refresh starts a fresh walk.
    if ((this.generations.get(dirPath) ?? 0) !== gen) return nodes;
    this.cache.set(dirPath, { expiresAt: Date.now() + CACHE_TTL_MS, nodes });
    if (this.cache.size > MAX_CACHED_DIRS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return nodes;
  }

  /** Drop the entry for a directory and invalidate any in-flight walk for it.
   *  Called after any local mutation so the next listing re-lists instead of
   *  serving the pre-mutation snapshot. */
  invalidate(dirPath: string): void {
    this.generations.set(dirPath, (this.generations.get(dirPath) ?? 0) + 1);
    this.cache.delete(dirPath);
    // Drop the in-flight promise too: a post-invalidation refresh must start
    // a FRESH walk, not join the stale one (which would hand it the
    // pre-mutation snapshot).
    this.inflight.delete(dirPath);
  }
}
