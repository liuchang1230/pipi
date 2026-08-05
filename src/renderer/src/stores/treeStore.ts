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
  /** Re-list the tree at its current origin (keeps previews consistent). */
  refresh: () => Promise<void>;
  navigateRemoteDir: (dirPath: string) => Promise<void>;
}

const treeReqSeq = { current: 0 };

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
    const origin = get().treeOrigin;
    if (!origin) return;
    let { tabId, dirPath, rootPath, isRemote } = origin;
    // Tab-bound origin whose tab was closed → fall back to the active tab.
    if (tabId && !useTabsStore.getState().tabs.some((t) => t.id === tabId)) {
      tabId = useTabsStore.getState().activeTab ?? undefined;
      dirPath = undefined;
    }
    await get().loadTree(dirPath, tabId, rootPath, { isRemote, force: true, noCache: true });
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
      if (nodes.length > 0) set((s) => ({ expanded: new Set(s.expanded).add(nodes[0].path) }));
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
