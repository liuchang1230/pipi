// Left-pane file tree state. Its actions live here so they read the active
// tab via getState() instead of re-creating
// callbacks per render; a monotonic request id prevents a slow listing for
// tab A from clobbering a newer one for tab B.
import { create } from "zustand";
import { useTabsStore } from "./tabsStore";
import { apply, type Updater } from "./utils";
import { targetKey, targetOfOrigin, type RemoteProfileTarget, type TargetRef, type WslProfileTarget } from "./remote-target";
import type { FileNode } from "./types";

/** Where the current `tree` listing came from. Event-driven refreshes and
 *  file reads/mutations must resolve against this origin — NOT the active
 *  tab — because the sidebar lets users PREVIEW a project's files (local
 *  `toggleProject`) without switching the active tab. Mixing the two is what
 *  made the header show one project while the tree showed another. */
export interface TreeOrigin {
  /** Tab the listing came from (normal follow mode; remote/WSL always). */
  tabId?: string;
  /** Explicit connection profile for a tab-independent remote/WSL listing
   *  (a sidebar project row with no connection tab open). */
  remote?: RemoteProfileTarget;
  wsl?: WslProfileTarget;
  /** Browse dir for remote/WSL listings (absolute linux path). */
  dirPath?: string;
  /** Local preview root (set by local toggleProject without a tab switch). */
  rootPath?: string;
  isRemote: boolean;
}

interface TreeState {
  tree: FileNode[];
  expanded: Set<string>;
  fileTreeStatus: "idle" | "loading" | "refreshing" | "error";
  fileTreeError: string | null;
  remoteTreeCache: Record<string, FileNode[]>;
  treeOrigin: TreeOrigin | null;
  /** Currently previewed file path (right pane) — highlighted in the tree. */
  previewPath: string | null;
  setPreviewPath: (path: string | null) => void;
  /** Expand every ancestor of a file so its row is visible + highlightable. */
  revealPath: (relPath: string) => Promise<void>;
  setTree: (updater: Updater<FileNode[]>) => void;
  setExpanded: (updater: Updater<Set<string>>) => void;
  setFileTreeStatus: (status: "idle" | "loading" | "refreshing" | "error") => void;
  setFileTreeError: (error: string | null) => void;
  setRemoteTreeCache: (updater: Updater<Record<string, FileNode[]>>) => void;
  setTreeOrigin: (origin: TreeOrigin | null) => void;
  loadTree: (dirPath?: string, tabId?: string, rootPath?: string, options?: { isRemote?: boolean; force?: boolean; noCache?: boolean; silent?: boolean; remote?: RemoteProfileTarget; wsl?: WslProfileTarget }) => Promise<void>;
  /** Fetch + inject the children of an expanded directory (local, SSH, WSL).
   *  `force` bypasses caches (post-mutation / local auto-follow).
   *  `refreshLoaded` re-lists an already-loaded dir WITHOUT bypassing the
   *  main-process TTL cache — the remote/WSL poll path. */
  expandDir: (relDir: string, force?: boolean, refreshLoaded?: boolean) => Promise<void>;
  /** Re-list the tree at its current origin (keeps previews consistent). */
  refresh: () => Promise<void>;
  /** Remote/WSL-only soft refresh: re-list the root + expanded dirs while
   *  RESPECTING main-process TTL caches (SFTP/UNC round trips are not free).
   *  This is what keeps a remote project's tree in sync with pi's writes —
   *  there is no fs.watch on the server. No-op for local/preview origins. */
  pollRemote: () => Promise<void>;
}

const treeReqSeq = { current: 0 };
/** Per-dir expand sequence: only a NEWER expand of the SAME dir supersedes
 *  an in-flight one; independent dirs never invalidate each other, and an
 *  expand never cancels an in-flight loadTree (separate counters). */
const expandSeqs = new Map<string, number>();

/** Min interval between auto-follow tree refreshes (agent write churn clamp). */
export const TREE_REFRESH_COOLDOWN_MS = 1000;
let lastTreeRefreshAt = 0;

/** Test-only: clear the refresh cooldown clock. */
export function __resetTreeRefreshClock(): void {
  lastTreeRefreshAt = 0;
}

/** Find a node by its root-relative path (node paths at every level are
 *  root-relative; descend through prefix ancestors). */
function findNode(nodes: FileNode[], targetPath: string): FileNode | undefined {
  for (const n of nodes) {
    if (n.path === targetPath) return n;
    if (n.type === "directory" && targetPath.startsWith(n.path + "/")) {
      const found = findNode(n.children ?? [], targetPath);
      if (found) return found;
    }
  }
  return undefined;
}

/** Immutably replace the children of the node at `targetPath` (full
 *  root-relative path; node paths at every level are root-relative, so we
 *  match by full-path equality, descending through prefix ancestors).
 *
 *  Returns the ORIGINAL array when nothing changed: `expandDir` re-lists every
 *  expanded dir on each background poll, and rebuilding the ancestor chain
 *  unconditionally gave the whole visible tree a new identity every 6s (every
 *  row's memo props changed → the column re-rendered → the user-visible
 *  flicker). */
function injectChildren(nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (n.path === targetPath) {
      if (n.children === children) return n; // same list → keep the node
      changed = true;
      return { ...n, children }; // the target dir itself
    }
    if (n.type === "directory" && targetPath.startsWith(n.path + "/")) {
      const prevKids = n.children;
      const kids = injectChildren(prevKids ?? [], targetPath, children);
      // Nothing injected into this branch (target lives elsewhere): keep it.
      if (prevKids ? kids === prevKids : kids.length === 0) return n;
      changed = true;
      return { ...n, children: kids };
    }
    return n;
  });
  return changed ? out : nodes;
}

/** Structural sharing for a RE-LISTING of the same directory.
 *
 * A background poll (remote/WSL) re-lists the root and every expanded dir with
 * no knowledge of what it sent last time, so a fresh set of `FileNode` objects
 * arrives every 6s even when nothing changed. Replacing `tree` with those made
 * every `TreeBranch`/`TreeRow` memo prop change identity → the whole file list
 * re-rendered ("当前项目文件"一闪一闪). Reusing the previous object per
 * unchanged row keeps the array identity, so React bails out entirely.
 *
 * Children are owned by lazy `expandDir`, NOT by a re-listing of the parent: a
 * shallow listing (`children === undefined`) therefore never clears a subtree
 * that is already loaded. */
function mergeNodes(prev: FileNode[] | undefined, next: FileNode[]): { nodes: FileNode[]; changed: boolean } {
  // A different length means files were added/removed — take the new listing.
  if (!prev || prev.length !== next.length) return { nodes: next, changed: true };
  let changed = false;
  const nodes = next.map((n, i) => {
    const p = prev[i];
    if (!p || p.path !== n.path || p.type !== n.type || p.name !== n.name) {
      changed = true;
      return n;
    }
    if (n.type !== "directory") return p; // identical file row
    if (n.children === undefined) return p; // shallow re-list → keep loaded children
    if (p.children === undefined) {
      changed = true;
      return n;
    }
    const merged = mergeNodes(p.children, n.children);
    if (!merged.changed) return p; // identical subtree → keep the node
    changed = true;
    return { ...n, children: merged.nodes };
  });
  return changed ? { nodes, changed: true } : { nodes: prev, changed: false };
}

/** Reuse every unchanged row from `prev`; returns `prev` itself when the
 *  re-listing is identical (so `set({ tree })` triggers no re-render). */
export function mergeRelistedNodes(prev: FileNode[] | undefined, next: FileNode[]): FileNode[] {
  return mergeNodes(prev, next).nodes;
}

export function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export const useTreeStore = create<TreeState>()((set, get) => ({
  tree: [],
  expanded: new Set<string>(),
  fileTreeStatus: "idle",
  fileTreeError: null,
  remoteTreeCache: {},
  treeOrigin: null,
  previewPath: null,
  setPreviewPath: (previewPath) => set({ previewPath }),
  revealPath: async (relPath) => {
    // Expand every ancestor directory so the file's row becomes visible
    // (deep files live inside collapsed branches by default).
    const parts = relPath.split("/");
    parts.pop(); // drop the file name
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (cur) await get().expandDir(cur, true).catch(() => {});
    }
  },
  setTree: (updater) => set((s) => ({ tree: apply(s.tree, updater) })),
  setExpanded: (updater) => set((s) => ({ expanded: apply(s.expanded, updater) })),
  setFileTreeStatus: (fileTreeStatus) => set({ fileTreeStatus }),
  setFileTreeError: (fileTreeError) => set({ fileTreeError }),
  setRemoteTreeCache: (updater) => set((s) => ({ remoteTreeCache: apply(s.remoteTreeCache, updater) })),
  setTreeOrigin: (treeOrigin) => set({ treeOrigin }),

  refresh: async () => {
    // Cooldown: an editing agent writes continuously; refresh churns must be
    // clamped so the tree (and the pty's event loop) isn't hammered.
    const now = Date.now();
    if (now - lastTreeRefreshAt < TREE_REFRESH_COOLDOWN_MS) return;
    lastTreeRefreshAt = now;
    const origin = get().treeOrigin;
    if (!origin) return;
    let { tabId, dirPath, rootPath, isRemote, remote, wsl } = origin;
    // A profile-backed origin survives tab churn; only a tab-bound origin
    // falls back to the active tab when its tab is gone.
    if (!remote && !wsl && tabId && !useTabsStore.getState().tabs.some((t) => t.id === tabId)) {
      tabId = useTabsStore.getState().activeTab ?? undefined;
      dirPath = undefined;
    }
    await get().loadTree(dirPath, tabId, rootPath, { isRemote, force: true, noCache: true, remote, wsl });
    // Lazy: also re-list the EXPANDED directories (shallow, cached unless
    // forced) so pi-created files inside them show up — collapsed branches
    // cost nothing.
    for (const dir of get().expanded) {
      await get().expandDir(dir, true);
    }
  },

  pollRemote: async () => {
    const origin = get().treeOrigin;
    // Local tabs are driven by the session-watcher (exact, event-driven);
    // local previews (rootPath) and unbound origins never poll.
    if (!origin?.isRemote || origin.rootPath) return;
    // Same cooldown as the local auto-follow refresh: it also collapses
    // overlapping polls into one round trip.
    const now = Date.now();
    if (now - lastTreeRefreshAt < TREE_REFRESH_COOLDOWN_MS) return;
    lastTreeRefreshAt = now;
    const { tabId, dirPath } = origin;
    // Profile-backed origins have no tab; the listing call is identical.
    if (!tabId && !origin.remote && !origin.wsl) return;
    // force/noCache stay false so the main process's 5s remote-file TTL does
    // the deduping — each poll costs at most one SFTP/WSL listing per dir.
    // silent: a background tick must not flash "远程文件刷新中…" or surface a
    // transient SFTP error banner.
    await get().loadTree(dirPath, tabId, undefined, { isRemote: true, silent: true, remote: origin.remote, wsl: origin.wsl });
    for (const dir of get().expanded) {
      await get().expandDir(dir, false, true);
    }
  },

  expandDir: async (relDir, force = false, refreshLoaded = false) => {
    const origin = get().treeOrigin;
    if (!origin) return;
    const { rootPath } = origin;
    const target = targetOfOrigin(origin);
    if (!rootPath && !target) return;
    const node = findNode(get().tree, relDir);
    if (!node) return; // node vanished — nothing to load
    if (!force && !refreshLoaded && node.children !== undefined) return; // already loaded
    const seq = (expandSeqs.get(relDir) ?? 0) + 1;
    expandSeqs.set(relDir, seq);
    try {
      // The main process selects local, SSH, or WSL from this origin's tab.
      // `relDir` is root-relative locally and absolute on SSH/WSL.
      const nodes = (await window.api.file.listDirChildren(rootPath, target, relDir, force ? true : undefined)) as FileNode[];
      if (expandSeqs.get(relDir) !== seq) return; // superseded by a newer expand of THIS dir
      const cur = get();
      // Discard if the origin changed, the dir was collapsed, or the node
      // vanished while the listing was in flight.
      if (cur.treeOrigin !== origin || !cur.expanded.has(relDir)) return;
      if (!findNode(cur.tree, relDir)) return;
      set((st) => ({
        tree: injectChildren(
          st.tree,
          relDir,
          mergeRelistedNodes(findNode(st.tree, relDir)?.children, sortFileNodes(nodes)),
        ),
      }));
    } catch {
      // Failed to list (permission / vanished dir): collapse so the loading
      // placeholder clears; the next click retries cleanly. A background poll
      // must NOT collapse the user's expanded branches on a transient SFTP
      // hiccup, so refreshLoaded failures are silent.
      if (!refreshLoaded && expandSeqs.get(relDir) === seq) {
        set((st) => ({ expanded: new Set([...st.expanded].filter((d) => d !== relDir)) }));
      }
    } finally {
      if (expandSeqs.get(relDir) === seq) expandSeqs.delete(relDir);
    }
  },

  loadTree: async (dirPath, tabId, rootPath, options) => {
    const tabs = useTabsStore.getState();
    const reqSeq = ++treeReqSeq.current;
    const remoteMode = options?.isRemote ?? tabs.isRemote;
    const force = options?.force ?? false;
    // Background polls (remote/WSL 6s refresh) must not flash a "refreshing"
    // placeholder nor flip the pane into an error state on a transient
    // failure — they update the tree silently when a fresh listing arrives.
    const silent = options?.silent ?? false;
    // A local preview (rootPath) is tab-independent: never inherit the
    // active tab id (it could be a remote/WSL tab).
    const profile = options?.remote;
    const wslProfile = options?.wsl;
    const hasProfile = !!profile || !!wslProfile;
    // A profile-backed origin needs no tab; a tab-backed one inherits the
    // active tab. A local preview (rootPath) is tab-independent.
    const resolvedTabId = rootPath || hasProfile ? undefined : tabId ?? tabs.activeTab ?? undefined;
    const resolvedDir = dirPath ?? (hasProfile ? undefined : tabs.remoteDir) ?? rootPath;
    const target: TargetRef | undefined = profile ? { remote: profile } : wslProfile ? { wsl: wslProfile } : resolvedTabId;
    // Record where this listing came from BEFORE the async part so any
    // refresh/read/mutation resolves against the same root.
    set({
      treeOrigin: {
        tabId: resolvedTabId,
        remote: profile,
        wsl: wslProfile,
        dirPath: dirPath ?? undefined,
        rootPath: rootPath ?? undefined,
        isRemote: remoteMode,
      },
    });
    const cacheKey = remoteMode && target && resolvedDir ? `${targetKey(target)}:${resolvedDir}` : null;
    const cached = !force && cacheKey ? get().remoteTreeCache[cacheKey] : undefined;
    if (cacheKey && cached?.length) {
      set({
        tree: mergeRelistedNodes(get().tree, sortFileNodes(cached)),
        ...(silent ? {} : { fileTreeStatus: "refreshing" as const }),
        fileTreeError: null,
      });
      // Cache hit: show immediately, refresh in background via main-process
      // cache (WSL/SSH file:list now has a 5s TTL) — no need to block.
      const nodes = await window.api.file.list(target, dirPath, rootPath, options?.noCache).catch(() => null);
      if (reqSeq !== treeReqSeq.current) return; // superseded by a newer load
      if (nodes) {
        const sortedNodes = sortFileNodes(nodes as FileNode[]);
        set((s) => ({
          tree: mergeRelistedNodes(get().tree, sortedNodes),
          remoteTreeCache: { ...s.remoteTreeCache, [cacheKey]: sortedNodes },
          ...(silent ? {} : { fileTreeStatus: "idle" as const }),
          fileTreeError: null,
        }));
      } else if (!silent) {
        set({ fileTreeStatus: "idle", fileTreeError: null });
      }
      return;
    }
    if (!silent) {
      if (remoteMode) {
        set({ fileTreeStatus: "loading", fileTreeError: null });
      } else {
        set({ fileTreeStatus: "idle", fileTreeError: null });
      }
    }
    try {
      const nodes = (await window.api.file.list(target, dirPath, rootPath, options?.noCache)) as FileNode[];
      if (reqSeq !== treeReqSeq.current) return; // superseded by a newer load
      const sortedNodes = sortFileNodes(nodes);
      set((s) => ({
        tree: mergeRelistedNodes(s.tree, sortedNodes),
        ...(cacheKey ? { remoteTreeCache: { ...s.remoteTreeCache, [cacheKey]: sortedNodes } } : {}),
      }));
      if (nodes.length > 0) {
        const first = nodes[0];
        // Only allocate a new Set when the path is actually new. A fresh Set
        // identity on every listing changed every row's memo props, so the 6s
        // background poll re-rendered the whole column even when nothing had
        // changed at all.
        if (!get().expanded.has(first.path)) {
          set((s) => ({ expanded: new Set(s.expanded).add(first.path) }));
        }
        // Lazy: the auto-expanded first directory loads its children on demand.
        if (first.type === "directory") void get().expandDir(first.path);
      }
      if (!silent) set({ fileTreeStatus: "idle", fileTreeError: null });
    } catch (error) {
      if (reqSeq !== treeReqSeq.current) return; // superseded by a newer load
      // A silent poll keeps the last good tree and status: a transient SFTP
      // hiccup must not blank the pane or show an error banner.
      if (silent) return;
      if (!cacheKey || !get().remoteTreeCache[cacheKey]?.length) set({ tree: [] });
      set({
        fileTreeStatus: remoteMode ? "error" : "idle",
        fileTreeError: error instanceof Error ? error.message : "未知错误",
      });
    }
  },

}));
