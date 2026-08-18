// Left-pane file tree state. loadTree/navigateRemoteDir live here as store
// actions so they read the active tab via getState() instead of re-creating
// callbacks per render; a monotonic request id prevents a slow listing for
// tab A from clobbering a newer one for tab B.
import { create } from "zustand";
import { useTabsStore } from "./tabsStore";
import { apply, type Updater } from "./utils";
import type { FileNode } from "./types";

/** Where the current `tree` listing came from. Event-driven refreshes and
 *  file reads/mutations must resolve against this origin — NOT the active
 *  tab — because the sidebar lets users PREVIEW a project's files (local
 *  `toggleProject`) without switching the active tab. Mixing the two is what
 *  made the header show one project while the tree showed another. */
export interface TreeOrigin {
  /** Tab the listing came from (normal follow mode; remote/WSL always). */
  tabId?: string;
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
  setTree: (updater: Updater<FileNode[]>) => void;
  setExpanded: (updater: Updater<Set<string>>) => void;
  setFileTreeStatus: (status: "idle" | "loading" | "refreshing" | "error") => void;
  setFileTreeError: (error: string | null) => void;
  setRemoteTreeCache: (updater: Updater<Record<string, FileNode[]>>) => void;
  setTreeOrigin: (origin: TreeOrigin | null) => void;
  loadTree: (dirPath?: string, tabId?: string, rootPath?: string, options?: { isRemote?: boolean; force?: boolean; noCache?: boolean }) => Promise<void>;
  /** Lazy local tree: fetch + inject the children of an expanded directory. */
  expandDir: (relDir: string, force?: boolean) => Promise<void>;
  /** Re-list the tree at its current origin (keeps previews consistent). */
  refresh: () => Promise<void>;
  navigateRemoteDir: (dirPath: string) => Promise<void>;
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
 *  match by full-path equality, descending through prefix ancestors). */
function injectChildren(nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  return nodes.map((n) => {
    if (n.path === targetPath) return { ...n, children }; // the target dir itself
    if (n.type === "directory" && targetPath.startsWith(n.path + "/")) {
      return { ...n, children: injectChildren(n.children ?? [], targetPath, children) };
    }
    return n;
  });
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
    let { tabId, dirPath, rootPath, isRemote } = origin;
    // Tab-bound origin whose tab was closed → fall back to the active tab.
    if (tabId && !useTabsStore.getState().tabs.some((t) => t.id === tabId)) {
      tabId = useTabsStore.getState().activeTab ?? undefined;
      dirPath = undefined;
    }
    await get().loadTree(dirPath, tabId, rootPath, { isRemote, force: true, noCache: true });
    // Lazy: also re-list the EXPANDED directories (shallow, cached unless
    // forced) so pi-created files inside them show up — collapsed branches
    // cost nothing.
    for (const dir of get().expanded) {
      await get().expandDir(dir, true);
    }
  },

  expandDir: async (relDir, force = false) => {
    const origin = get().treeOrigin;
    if (!origin || origin.isRemote) return; // remote navigates via navigateRemoteDir
    const { rootPath, tabId } = origin;
    if (!rootPath && !tabId) return;
    const node = findNode(get().tree, relDir);
    if (!node) return; // node vanished — nothing to load
    if (!force && node.children !== undefined) return; // already loaded
    const seq = (expandSeqs.get(relDir) ?? 0) + 1;
    expandSeqs.set(relDir, seq);
    try {
      const nodes = (await window.api.file.listDirChildren(rootPath, tabId, relDir, force ? true : undefined)) as FileNode[];
      if (expandSeqs.get(relDir) !== seq) return; // superseded by a newer expand of THIS dir
      const cur = get();
      // Discard if the origin changed, the dir was collapsed, or the node
      // vanished while the listing was in flight.
      if (cur.treeOrigin !== origin || !cur.expanded.has(relDir)) return;
      if (!findNode(cur.tree, relDir)) return;
      set((st) => ({ tree: injectChildren(st.tree, relDir, sortFileNodes(nodes)) }));
    } catch {
      // Failed to list (permission / vanished dir): collapse so the loading
      // placeholder clears; the next click retries cleanly.
      if (expandSeqs.get(relDir) === seq) {
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
    // A local preview (rootPath) is tab-independent: never inherit the
    // active tab id (it could be a remote/WSL tab).
    const resolvedTabId = rootPath ? undefined : tabId ?? tabs.activeTab ?? undefined;
    const resolvedDir = dirPath ?? tabs.remoteDir ?? rootPath;
    // Record where this listing came from BEFORE the async part so any
    // refresh/read/mutation resolves against the same root.
    set({
      treeOrigin: {
        tabId: resolvedTabId,
        dirPath: dirPath ?? undefined,
        rootPath: rootPath ?? undefined,
        isRemote: remoteMode,
      },
    });
    const cacheKey = remoteMode && resolvedTabId && resolvedDir ? `${resolvedTabId}:${resolvedDir}` : null;
    const cached = !force && cacheKey ? get().remoteTreeCache[cacheKey] : undefined;
    if (cacheKey && cached?.length) {
      set({
        tree: sortFileNodes(cached),
        fileTreeStatus: "refreshing",
        fileTreeError: null,
      });
      // Cache hit: show immediately, refresh in background via main-process
      // cache (WSL/SSH file:list now has a 5s TTL) — no need to block.
      const nodes = await window.api.file.list(resolvedTabId, dirPath, rootPath, options?.noCache).catch(() => null);
      if (reqSeq !== treeReqSeq.current) return; // superseded by a newer load
      if (nodes) {
        const sortedNodes = sortFileNodes(nodes as FileNode[]);
        set((s) => ({
          tree: sortedNodes,
          remoteTreeCache: { ...s.remoteTreeCache, [cacheKey]: sortedNodes },
          fileTreeStatus: "idle",
          fileTreeError: null,
        }));
      } else {
        set({ fileTreeStatus: "idle", fileTreeError: null });
      }
      return;
    }
    if (remoteMode) {
      set({ fileTreeStatus: "loading", fileTreeError: null });
    } else {
      set({ fileTreeStatus: "idle", fileTreeError: null });
    }
    try {
      const nodes = (await window.api.file.list(resolvedTabId, dirPath, rootPath, options?.noCache)) as FileNode[];
      if (reqSeq !== treeReqSeq.current) return; // superseded by a newer load
      const sortedNodes = sortFileNodes(nodes);
      set((s) => ({
        tree: sortedNodes,
        ...(cacheKey ? { remoteTreeCache: { ...s.remoteTreeCache, [cacheKey]: sortedNodes } } : {}),
      }));
      if (nodes.length > 0) {
        const first = nodes[0];
        set((s) => ({ expanded: new Set(s.expanded).add(first.path) }));
        // Lazy: the auto-expanded first directory loads its children on demand.
        if (first.type === "directory") void get().expandDir(first.path);
      }
      set({ fileTreeStatus: "idle", fileTreeError: null });
    } catch (error) {
      if (reqSeq !== treeReqSeq.current) return; // superseded by a newer load
      if (!cacheKey || !get().remoteTreeCache[cacheKey]?.length) set({ tree: [] });
      set({
        fileTreeStatus: remoteMode ? "error" : "idle",
        fileTreeError: error instanceof Error ? error.message : "未知错误",
      });
    }
  },

  navigateRemoteDir: async (dirPath) => {
    const tabs = useTabsStore.getState();
    if (!tabs.activeTab || !tabs.isRemote) return;
    const ok = await window.api.remote.setBrowsePath(tabs.activeTab, dirPath);
    if (!ok) return;
    useTabsStore.setState({ remoteDir: dirPath, cwd: dirPath });
    await get().loadTree(dirPath, tabs.activeTab);
  },
}));
