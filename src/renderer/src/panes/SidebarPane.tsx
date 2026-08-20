// Left pane: project/session sidebar + file tree, plus the context menus and
// prompt/confirm dialogs those rows own. Subscribes only to sessions/tree
// slices (plus tab context for active-state); App stays out of the render
// path for every sidebar change.
//
// Cross-pane events (open a session → create a tab, open a file → viewer)
// route through store actions (sessionsStore.openSession, viewerStore.openFile)
// instead of App callbacks. The only props are the theme and the four dialog
// openers that belong to App's dialog suite.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FileContextMenu, PromptDialog, ConfirmDialog } from "../FileDialogs";
import { sortFileNodes, useTreeStore } from "../stores/treeStore";
import {
  useSessionsStore,
  sessionLabel,
  remoteSessionCacheKey,
  buildRemoteKey,
} from "../stores/sessionsStore";
import { groupRemoteServers } from "../stores/remote-servers";
import { useTabsStore } from "../stores/tabsStore";
import { useViewerStore } from "../stores/viewerStore";
import { useUiStore } from "../stores/uiStore";
import { useLayoutStore } from "../stores/layoutStore";
import { Icon, type IconName } from "../components/Icon";
import type {
  FileNode,
  ProjectGroup,
  SessionItem,
  WslConnectionGroup,
  RemoteHydrationState,
  RemoteServerGroup,
} from "../stores/types";

type Updater<T> = T | ((prev: T) => T);

interface SidebarPaneProps {
  theme: "dark" | "light";
  toggleTheme: () => void;
  onNewLocalProject: () => void;
  onAddRemoteServer: () => void;
  onConnectServer: (server: RemoteServerGroup) => Promise<boolean> | void;
  onAddRemoteProjectForServer: (server: RemoteServerGroup) => void;
  onWslConnect: (distro: string) => void;
  onAddWslProject: (distro: string) => void;
}

export function SidebarPane({ theme, toggleTheme, onNewLocalProject, onAddRemoteServer, onConnectServer, onAddRemoteProjectForServer, onWslConnect, onAddWslProject }: SidebarPaneProps) {
  // --- Tab context (drives active states) ---
  const isRemote = useTabsStore((s) => s.isRemote);
  const cwd = useTabsStore((s) => s.cwd);
  const remoteDir = useTabsStore((s) => s.remoteDir);
  const setRemoteDir = useTabsStore((s) => s.setRemoteDir);
  const setIsRemote = useTabsStore((s) => s.setIsRemote);
  const setCwd = useTabsStore((s) => s.setCwd);
  const setRemoteLabel = useTabsStore((s) => s.setRemoteLabel);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const activeTab = useTabsStore((s) => s.activeTab);
  const tabs = useTabsStore((s) => s.tabs);

  // --- File tree slice ---
  const tree = useTreeStore((s) => s.tree);
  const expanded = useTreeStore((s) => s.expanded);
  const setExpanded = useTreeStore((s) => s.setExpanded);
  const fileTreeStatus = useTreeStore((s) => s.fileTreeStatus);
  const fileTreeError = useTreeStore((s) => s.fileTreeError);
  const navigateRemoteDir = useTreeStore((s) => s.navigateRemoteDir);

  // --- Sessions / projects slice ---
  const projects = useSessionsStore((s) => s.projects);
  const projectSessions = useSessionsStore((s) => s.projectSessions);
  const setProjectSessions = useSessionsStore((s) => s.setProjectSessions);
  const projectLoading = useSessionsStore((s) => s.projectLoading);
  const projectSessionStatus = useSessionsStore((s) => s.projectSessionStatus);
  const projectErrors = useSessionsStore((s) => s.projectErrors);
  const projectDiagnostics = useSessionsStore((s) => s.projectDiagnostics);
  const remoteSessions = useSessionsStore((s) => s.remoteSessions);
  const remoteHistory = useSessionsStore((s) => s.remoteHistory);
  const setRemoteSessions = useSessionsStore((s) => s.setRemoteSessions);
  const remoteHydration = useSessionsStore((s) => s.remoteHydration);
  const setRemoteHydration = useSessionsStore((s) => s.setRemoteHydration);
  const expandedProjects = useSessionsStore((s) => s.expandedProjects);
  const selectedSessions = useSessionsStore((s) => s.selectedSessions);
  const setSelectedSessions = useSessionsStore((s) => s.setSelectedSessions);
  const loadSessions = useSessionsStore((s) => s.loadSessions);
  // Stable store actions (never recreated) — passing these directly keeps the
  // memoized Sidebar/sections from re-rendering on every session poll.
  const openSession = useSessionsStore((s) => s.openSession);
  const openRemoteSession = useSessionsStore((s) => s.openRemoteSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const selectAllSessions = useSessionsStore((s) => s.selectAllSessions);
  const toggleSessionSelect = useSessionsStore((s) => s.toggleSessionSelect);

  // --- Viewer slice (openFile for tree clicks; currentFile for rename) ---
  const openFile = useViewerStore((s) => s.openFile);

  // --- Layout (hydration toast position) ---
  const rightWidth = useLayoutStore((s) => s.rightWidth);
  const viewerCollapsed = useLayoutStore((s) => s.viewerCollapsed);
  const leftWidth = useLayoutStore((s) => s.leftWidth);

  // --- Local state owned by this pane ---
  const [sidebarSplit, setSidebarSplit] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("pipi-sidebar-split"));
      return Number.isFinite(saved) ? Math.max(20, Math.min(80, saved)) : 55;
    } catch {
      return 55;
    }
  }); // % for file tree
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [treeCtx, setTreeCtx] = useState<{ x: number; y: number; node: FileNode | null } | null>(null);
  const [filePrompt, setFilePrompt] = useState<{ kind: "file" | "dir" | "rename"; title: string; node: FileNode | null } | null>(null);
  const [fileConfirm, setFileConfirm] = useState<{ node: FileNode } | null>(null);
  const fsBusyRef = useRef(false); // guards overlapping fs mutations
  const [ctxMenuSession, setCtxMenuSession] = useState<SessionItem | null>(null);
  const [ctxMenuPos, setCtxMenuPos] = useState({ x: 0, y: 0 });
  const [renameSession, setRenameSession] = useState<SessionItem | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // --- Remote hydration: main's background hydration → per-project caches ---
  useEffect(() => {
    const off = window.api.session.onRemoteUpdated(({ tabId, remoteCwd, sessions }) => {
      setRemoteSessions((prev) => ({ ...prev, [remoteSessionCacheKey(tabId, remoteCwd, tabs.find((t) => t.id === tabId)?.remoteAgentDir ?? "")]: sessions as SessionItem[] }));
      setProjectSessions((prev) => {
        const next = { ...prev };
        for (const project of projects) {
          if (project.path !== remoteCwd || !project.id) continue;
          if (project.type === "wsl") {
            // WSL projects have no remoteKey; match the emitting tab via distro.
            const matchesTab = tabs.find((t) => t.id === tabId && t.isWsl && t.wslDistro === project.distro);
            if (matchesTab) next[project.id] = sessions as SessionItem[];
          } else if (project.type === "remote") {
            if (!project.host || !project.user) continue;
            const projectRemoteKey = buildRemoteKey(project.host, project.user, project.port, (project as { agentDir?: string }).agentDir);
            const matchesTab = tabs.find((t) => t.id === tabId && t.isRemote && t.remoteKey === projectRemoteKey);
            if (matchesTab) next[project.id] = sessions as SessionItem[];
          }
        }
        return next;
      });
      setRemoteHydration((prev) => (prev.tabId === tabId && prev.remoteCwd === remoteCwd ? { phase: "idle" } : prev));
    });
    return off;
  }, [projects, setProjectSessions, setRemoteHydration, setRemoteSessions, tabs]);

  // --- Live local session sync: main polls the active project's session dir
  //     while pi writes, so sidebar counts/timestamps stay fresh. ---
  useEffect(() => {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const off = window.api.session.onLocalUpdated(({ cwd: updatedCwd, sessions }) => {
      const updated = norm(updatedCwd);
      setProjectSessions((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const p of projects) {
          if (p.type !== "local" || !p.cwd) continue;
          if (norm(p.cwd) !== updated) continue;
          next[p.id] = sessions as SessionItem[];
          changed = true;
        }
        return changed ? next : prev;
      });
    });
    return off;
  }, [projects, setProjectSessions]);

  // --- Sidebar vertical resizer (sidebarSplit is this pane's local state) ---
  const sidebarDragRef = useRef(false);
  const sidebarSplitRef = useRef(sidebarSplit);
  const sidebarSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSidebarResizerDown = useCallback(() => { sidebarDragRef.current = true; }, []);
  useEffect(() => {
    sidebarSplitRef.current = sidebarSplit;
  }, [sidebarSplit]);
  useEffect(() => {
    return () => {
      if (sidebarSaveTimerRef.current) clearTimeout(sidebarSaveTimerRef.current);
    };
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (sidebarDragRef.current && sidebarRef.current) {
        const rect = sidebarRef.current.getBoundingClientRect();
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        const next = Math.max(20, Math.min(80, pct));
        setSidebarSplit(next);
        if (sidebarSaveTimerRef.current) clearTimeout(sidebarSaveTimerRef.current);
        sidebarSaveTimerRef.current = setTimeout(() => {
          try { localStorage.setItem("pipi-sidebar-split", String(Math.round(sidebarSplitRef.current))); } catch { /* best effort */ }
        }, 160);
      }
    };
    const onUp = () => {
      if (!sidebarDragRef.current) return;
      sidebarDragRef.current = false;
      if (sidebarSaveTimerRef.current) clearTimeout(sidebarSaveTimerRef.current);
      try { localStorage.setItem("pipi-sidebar-split", String(Math.round(sidebarSplitRef.current))); } catch { /* best effort */ }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // --- Tree mutations (create / rename / delete / save-refresh) ---
  const openTreeMenu = useCallback((e: React.MouseEvent, node: FileNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setTreeCtx({ x: e.clientX, y: e.clientY, node });
  }, []);
  const closeTreeMenu = useCallback(() => setTreeCtx(null), []);

  /** Parent dir for new files: the right-clicked node, or the tree root.
   *  For a FILE node, creations land in its parent directory. The null-node
   *  (empty-area right-click) case resolves against the TREE's origin like
   *  treeOp does — NOT the active tab — so a local preview under a remote
   *  tab never writes into a linux path inside the preview root. */
  const treeParentDir = useCallback(
    (node: FileNode | null): string => {
      if (!node) {
        const origin = useTreeStore.getState().treeOrigin;
        if (origin?.rootPath) return ""; // local preview: root is the preview root
        return origin?.isRemote ? (origin.dirPath ?? remoteDir ?? "") : "";
      }
      if (node.type === "file") {
        const i = node.path.lastIndexOf("/");
        return i >= 0 ? node.path.slice(0, i) : "";
      }
      return node.path;
    },
    [remoteDir],
  );

  const joinRel = useCallback((parent: string, name: string): string => (parent ? `${parent}/${name}` : name), []);

  /** Reload the tree after a mutation, expanding ancestors so new nodes show.
   *  Re-lists at the tree's ORIGIN (preview root or tab), keeping the header
   *  and the listing consistent even when previewing another project. */
  const refreshTree = useCallback(
    async (expandPath?: string) => {
      await useTreeStore.getState().refresh();
      if (expandPath) {
        const parts = expandPath.split("/").filter(Boolean);
        const ancestors: string[] = [];
        for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
        if (ancestors.length) {
          setExpanded((prev) => new Set([...prev, ...ancestors]));
          // Lazy: fetch the newly-expanded ancestors too, or they'd sit on
          // the "…加载中" placeholder until the next refresh/toggle.
          for (const a of ancestors) void useTreeStore.getState().expandDir(a);
        }
      }
    },
    [setExpanded],
  );

  /** File-op context from the tree origin: preview mode targets rootPath
   *  (no tab — the active tab may be a remote/WSL tab), normal mode targets
   *  the origin (active) tab. */
  const treeOp = useCallback(() => {
    const origin = useTreeStore.getState().treeOrigin;
    if (origin?.rootPath) return { tabId: undefined, rootPath: origin.rootPath };
    return { tabId: origin?.tabId ?? activeTab ?? undefined, rootPath: undefined };
  }, [activeTab]);

  const handleNewFile = useCallback(
    async (name: string) => {
      const prompt = filePrompt;
      if (!prompt) return;
      if (fsBusyRef.current) {
        useUiStore.getState().showToast("已有操作进行中，请稍候", "err");
        return;
      }
      fsBusyRef.current = true;
      try {
        const { tabId, rootPath } = treeOp();
        const rel = joinRel(treeParentDir(prompt.node), name);
        const res = await window.api.file.write(tabId, rel, "", rootPath);
        if (!res.ok) {
          useUiStore.getState().showToast(res.error || "新建文件失败", "err");
          return;
        }
        useUiStore.getState().showToast(`已创建 ${name}`, "ok");
        await refreshTree(rel);
        await useViewerStore.getState().openFile(rel, false);
      } catch (error) {
        useUiStore.getState().showToast(error instanceof Error ? error.message : "新建文件失败", "err");
      } finally {
        fsBusyRef.current = false;
      }
    },
    [filePrompt, treeParentDir, joinRel, treeOp, refreshTree],
  );

  const handleNewDir = useCallback(
    async (name: string) => {
      const prompt = filePrompt;
      if (!prompt) return;
      if (fsBusyRef.current) {
        useUiStore.getState().showToast("已有操作进行中，请稍候", "err");
        return;
      }
      fsBusyRef.current = true;
      try {
        const { tabId, rootPath } = treeOp();
        const rel = joinRel(treeParentDir(prompt.node), name);
        const res = await window.api.file.mkdir(tabId, rel, rootPath);
        if (!res.ok) {
          useUiStore.getState().showToast(res.error || "新建文件夹失败", "err");
          return;
        }
        useUiStore.getState().showToast(`已创建文件夹 ${name}`, "ok");
        setExpanded((prev) => new Set(prev).add(rel));
        await refreshTree(rel);
      } catch (error) {
        useUiStore.getState().showToast(error instanceof Error ? error.message : "新建文件夹失败", "err");
      } finally {
        fsBusyRef.current = false;
      }
    },
    [filePrompt, treeParentDir, joinRel, treeOp, refreshTree, setExpanded],
  );

  const handleRename = useCallback(
    async (newName: string) => {
      const prompt = filePrompt;
      if (!prompt?.node || fsBusyRef.current) return;
      const node = prompt.node;
      if (newName === node.name) return; // nothing to do
      fsBusyRef.current = true;
      try {
        const { tabId, rootPath } = treeOp();
        const res = await window.api.file.rename(tabId, node.path, newName, rootPath);
        if (!res.ok) {
          useUiStore.getState().showToast(res.error || "重命名失败", "err");
          return;
        }
        useUiStore.getState().showToast("已重命名", "ok");
        const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
        const newPath = parent ? `${parent}/${newName}` : isRemote ? `/${newName}` : newName;
        await refreshTree(parent);
        // Re-open the viewer when the open file (or a directory containing it) was renamed.
        const currentFile = useViewerStore.getState().currentFile;
        if (currentFile && (currentFile.path === node.path || currentFile.path.startsWith(node.path + "/"))) {
          const relSuffix = currentFile.path.startsWith(node.path + "/") ? currentFile.path.slice(node.path.length) : "";
          await useViewerStore.getState().openFile(newPath + relSuffix, false);
        }
      } catch (error) {
        useUiStore.getState().showToast(error instanceof Error ? error.message : "重命名失败", "err");
      } finally {
        fsBusyRef.current = false;
      }
    },
    [filePrompt, isRemote, treeOp, refreshTree],
  );

  const handleDelete = useCallback(
    async (node: FileNode) => {
      if (fsBusyRef.current) {
        useUiStore.getState().showToast("已有操作进行中，请稍候", "err");
        return;
      }
      fsBusyRef.current = true;
      try {
        const { tabId, rootPath } = treeOp();
        const res = await window.api.file.delete(tabId, node.path, rootPath);
        if (!res.ok) {
          useUiStore.getState().showToast(res.error || "删除失败", "err");
          return;
        }
        useUiStore.getState().showToast(`已删除 ${node.name}`, "ok");
        await refreshTree();
        // Clear the viewer if the open file (or a directory containing it) was deleted.
        const currentFile = useViewerStore.getState().currentFile;
        if (currentFile && (currentFile.path === node.path || currentFile.path.startsWith(node.path + "/"))) {
          useViewerStore.getState().setCurrentFile(null);
        }
      } catch (error) {
        useUiStore.getState().showToast(error instanceof Error ? error.message : "删除失败", "err");
      } finally {
        fsBusyRef.current = false;
      }
    },
    [treeOp, refreshTree],
  );

  // --- Session context menu ---
  const handleSessionCtx = useCallback((e: React.MouseEvent, s: SessionItem) => {
    e.preventDefault();
    setCtxMenuSession(s);
    setCtxMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleRenameStart = useCallback(() => {
    if (!ctxMenuSession) return;
    setRenameSession(ctxMenuSession);
    setRenameValue(ctxMenuSession.name || "");
    setCtxMenuSession(null);
  }, [ctxMenuSession]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renameSession) return;
    const r = await window.api.session.rename(renameSession.path, renameValue.trim());
    if (!r.ok) { useUiStore.getState().showToast(`重命名失败: ${r.error}`, "err"); return; }
    setRenameSession(null);
    loadSessions(cwd);
  }, [renameSession, renameValue, cwd, loadSessions]);

  const handleCtxDelete = useCallback(async () => {
    if (!ctxMenuSession) return;
    await useSessionsStore.getState().deleteSession(ctxMenuSession);
    setCtxMenuSession(null);
  }, [ctxMenuSession]);

  // --- Project explorer orchestration (hydration phases + cache fast paths) ---
  // Deepened into sessionsStore actions (O2): the pane calls one action per
  // user gesture; the hydration phases and cache fast paths live with the
  // session/project state they mutate.
  const toggleProject = useSessionsStore((s) => s.toggleProject);
  const deleteProject = useSessionsStore((s) => s.deleteProject);
  const newProjectSession = useSessionsStore((s) => s.newProjectSession);

  // --- Tree rendering ---
  const toggleDir = useCallback((path: string) => {
    const tabsState = useTabsStore.getState();
    if (tabsState.isRemote) {
      void navigateRemoteDir(path);
    } else {
      const s = useTreeStore.getState();
      const willExpand = !s.expanded.has(path);
      setExpanded((prev) => {
        const n = new Set(prev);
        if (n.has(path)) n.delete(path);
        else n.add(path);
        return n;
      });
      // Lazy: expanding a directory fetches its children on demand.
      if (willExpand) void useTreeStore.getState().expandDir(path);
    }
  }, [navigateRemoteDir, setExpanded]);

  const renderTree = useCallback((nodes: FileNode[], depth: number): ReactNode => {
    return nodes.map((node) => (
      <TreeBranch
        key={node.path}
        node={node}
        depth={depth}
        expandedPaths={expanded}
        onToggle={toggleDir}
        onOpen={openFile}
        onContextMenu={openTreeMenu}
      />
    ));
  }, [expanded, toggleDir, openFile, openTreeMenu]);

  // Memoize derived sidebar data so a pane re-render (e.g. a session count
  // bump) doesn't rebuild the project groups and bust the memoized sections.
  const localProjectGroups = useMemo<ProjectGroup[]>(
    () =>
      projects
        .filter((p) => p.type === "local" && p.cwd)
        .map((p) => ({
          key: p.id,
          label: p.name,
          cwd: p.cwd!,
          type: "local" as const,
          sessions: projectSessions[p.id] ?? [],
        })),
    [projects, projectSessions],
  );

  // SSH servers as connection nodes (user@host), each with its project
  // folders underneath — mirrors the WSL section. Derived in one place from
  // saved history + projects + open tabs (see remote-servers.ts).
  const remoteServers = useMemo<RemoteServerGroup[]>(
    () =>
      groupRemoteServers({
        projects,
        remoteHistory,
        tabs,
        projectSessions,
        remoteSessions,
        projectErrors,
        projectDiagnostics,
        remoteHydration,
      }),
    [projects, remoteHistory, tabs, projectSessions, remoteSessions, projectErrors, projectDiagnostics, remoteHydration],
  );

  // WSL: distro is a CONNECTION node (like an SSH host); its projects are the
  // folders the user added via the 🐧 section's + picker. Group by distro.
  const wslConnections: WslConnectionGroup[] = useMemo(() => {
    const distros = new Set<string>();
    for (const t of tabs) if (t.isWsl && t.wslDistro) distros.add(t.wslDistro);
    for (const p of projects) if (p.type === "wsl" && p.distro) distros.add(p.distro);
    return [...distros].sort().map((distro) => {
      const wslTab = tabs.find((t) => t.isWsl && t.wslDistro === distro);
      const projs = projects
        .filter((p) => p.type === "wsl" && p.distro === distro && p.path && p.path !== "~")
        .map((p) => {
          const tab = wslTab;
          return {
            key: p.id,
            label: p.name,
            cwd: p.path!,
            type: "remote" as const,
            tabId: tab?.id,
            host: p.distro,
            user: "",
            port: 0,
            sessions: projectSessions[p.id] ?? (tab ? (remoteSessions[remoteSessionCacheKey(tab.id, p.path!)] ?? []) : []),
            disabled: !wslTab,
            error: projectErrors[p.id],
            hydrationPhase: "idle" as const,
            diagnostics: projectDiagnostics[p.id],
          };
        });
      return { distro, tabId: wslTab?.id, connected: !!wslTab, projects: projs };
    });
  }, [tabs, projects, projectSessions, remoteSessions, projectErrors, projectDiagnostics]);

  // The session (if any) the active tab is linked to — drives the "current
  // session" highlight in the left sidebar when switching middle tabs.
  const activeSessionPath = useMemo(
    () => tabs.find((t) => t.id === activeTab)?.sessionPath ?? null,
    [tabs, activeTab],
  );

  // Latest project groups (incl. WSL projects) for locating a session's owning
  // group. Read via a ref so the scroll effect below does NOT re-run on every
  // session poll (which would re-center the sidebar on each 4s refresh).
  const sessionOwnerRef = useRef<ProjectGroup[]>([]);
  sessionOwnerRef.current = [
    ...localProjectGroups,
    ...remoteServers.flatMap((s) => s.projects),
    ...wslConnections.flatMap((c) => c.projects),
  ];

  // Switching middle tabs locates the linked session in the left sidebar: the
  // owning project group auto-expands if collapsed, then the row scrolls to
  // the CENTER of the session list ("点击标签页 → 左侧定位并居中显示"). rAF
  // defers one frame so the freshly-rendered rows exist before we look them up.
  useEffect(() => {
    if (!activeSessionPath) return;
    const owner = sessionOwnerRef.current.find((g) => g.sessions.some((s) => s.path === activeSessionPath));
    if (owner) {
      const st = useSessionsStore.getState();
      if (!st.expandedProjects.has(owner.key)) {
        st.setExpandedProjects((prev) => new Set(prev).add(owner.key));
      }
    }
    const raf = requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>(".session-row[data-session-path]");
      for (const el of rows) {
        if (el.dataset.sessionPath === activeSessionPath) {
          el.scrollIntoView({ block: "center" });
          return;
        }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSessionPath]);

  // Stable wrapper so the memoized Sidebar never re-renders from changing
  // closure identities (only from actual data changes).
  const handleBatchDeleteClick = useCallback(() => {
    const st = useTabsStore.getState();
    void useSessionsStore.getState().batchDelete(st.activeTab ?? undefined, st.remoteDir ?? undefined);
  }, []);

  return (
    <>
      <Sidebar
        leftWidth={leftWidth}
        sidebarRef={sidebarRef}
        sidebarSplit={sidebarSplit}
        theme={theme}
        toggleTheme={toggleTheme}
        selectedSessions={selectedSessions}
        handleBatchDelete={handleBatchDeleteClick}
        setSelectedSessions={setSelectedSessions}
        localProjectGroups={localProjectGroups}
        remoteServers={remoteServers}
        wslConnections={wslConnections}
        onWslConnect={onWslConnect}
        onAddWslProject={onAddWslProject}
        isRemote={isRemote}
        cwd={cwd}
        remoteDir={remoteDir}
        expandedProjects={expandedProjects}
        projectLoading={projectLoading}
        projectSessionStatus={projectSessionStatus}
        activeTab={activeTab}
        activeSessionPath={activeSessionPath}
        tree={tree}
        remoteHydration={remoteHydration}
        fileTreeStatus={fileTreeStatus}
        fileTreeError={fileTreeError}
        onSidebarResizerDown={onSidebarResizerDown}
        onToggleProject={toggleProject}
        onNewLocalProject={onNewLocalProject}
        onDeleteProject={deleteProject}
        onNewProjectSession={newProjectSession}
        onAddRemoteServer={onAddRemoteServer}
        onConnectServer={onConnectServer}
        onAddRemoteProjectForServer={onAddRemoteProjectForServer}
        onOpenSession={openSession}
        onOpenRemoteSession={openRemoteSession}
        onDeleteSession={deleteSession}
        onHandleSessionCtx={handleSessionCtx}
        onSelectAllSessions={selectAllSessions}
        onToggleSessionSelect={toggleSessionSelect}
        renderTree={renderTree}
        onTreeCtx={openTreeMenu}
      />

      {/* Hydration feedback: bottom-right, clear of the viewer. */}
      {remoteHydration.phase !== "idle" && isRemote && (
        <div className="toast toast-ok" style={{ right: viewerCollapsed ? 20 : rightWidth + 20, bottom: 20 }}>
          {remoteHydration.phase === "loading" ? "远程会话加载中…" : "正在补全远程会话信息…"}
        </div>
      )}

      {/* Session context menu */}
      {ctxMenuSession && (
        <>
          <div className="ctx-backdrop" onClick={() => setCtxMenuSession(null)} />
          <div className="ctx-menu" style={{ left: ctxMenuPos.x, top: ctxMenuPos.y }}>
            <button className="ctx-item" onClick={handleRenameStart}><Icon name="pencil" /> 重命名</button>
            <button className="ctx-item ctx-danger" onClick={handleCtxDelete}><Icon name="trash" /> 删除</button>
          </div>
        </>
      )}

      {/* Rename dialog */}
      {renameSession && (
        <div className="dialog-overlay" onClick={() => setRenameSession(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">重命名会话</div>
            <div className="dialog-body">
              <input
                className="dialog-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="输入新名称"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") void handleRenameSubmit(); }}
              />
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setRenameSession(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => void handleRenameSubmit()}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* File tree context menu + create/rename/delete dialogs */}
      {/* The synthetic ".." entry points outside the browse dir: mutations are
          contained to the browse root, so no menu items apply to it. */}
      {treeCtx && treeCtx.node?.name !== ".." && (
        <FileContextMenu
          x={treeCtx.x}
          y={treeCtx.y}
          onClose={closeTreeMenu}
          items={[
            { label: "新建文件", icon: "file" as const, onSelect: () => setFilePrompt({ kind: "file", title: "新建文件", node: treeCtx.node }) },
            { label: "新建文件夹", icon: "folder" as const, onSelect: () => setFilePrompt({ kind: "dir", title: "新建文件夹", node: treeCtx.node }) },
            ...(treeCtx.node
              ? [
                  { label: "重命名", icon: "pencil" as const, onSelect: () => setFilePrompt({ kind: "rename", title: "重命名", node: treeCtx.node }) },
                  { label: "删除", icon: "trash" as const, danger: true, onSelect: () => setFileConfirm({ node: treeCtx.node! }) },
                ]
              : []),
          ]}
        />
      )}
      {filePrompt && (
        <PromptDialog
          title={filePrompt.title}
          placeholder={filePrompt.kind === "rename" ? "新名称" : "名称（如 utils/helper.ts）"}
          initial={filePrompt.kind === "rename" ? filePrompt.node?.name ?? "" : ""}
          hint={filePrompt.kind === "rename" ? "仅改名称，保持在当前目录" : undefined}
          confirmLabel={filePrompt.kind === "rename" ? "重命名" : "创建"}
          onConfirm={(value) => {
            const p = filePrompt;
            setFilePrompt(null);
            if (p.kind === "file") void handleNewFile(value);
            else if (p.kind === "dir") void handleNewDir(value);
            else void handleRename(value);
          }}
          onCancel={() => setFilePrompt(null)}
        />
      )}
      {fileConfirm && (
        <ConfirmDialog
          title="删除"
          message={<>确定删除 <code className="confirm-path">{fileConfirm.node.path}</code> ？</>}
          danger
          confirmLabel="删除"
          onConfirm={() => {
            const node = fileConfirm.node;
            setFileConfirm(null);
            void handleDelete(node);
          }}
          onCancel={() => setFileConfirm(null)}
        />
      )}
    </>
  );
}

// --- Tree mutation handlers (create / rename / delete) ----------------------

// --- Sidebar (presentational; receives store slices via the pane) ----------

interface SidebarProps {
  leftWidth: number;
  sidebarRef: React.RefObject<HTMLDivElement>;
  sidebarSplit: number;
  theme: "dark" | "light";
  toggleTheme: () => void;
  selectedSessions: Set<string>;
  handleBatchDelete: () => void;
  setSelectedSessions: (next: Set<string>) => void;
  localProjectGroups: ProjectGroup[];
  remoteServers: RemoteServerGroup[];
  wslConnections: WslConnectionGroup[];
  onWslConnect: (distro: string) => void;
  onAddWslProject: (distro: string) => void;
  isRemote: boolean;
  cwd: string;
  remoteDir: string | null;
  expandedProjects: Set<string>;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, "idle" | "loading" | "ready" | "empty" | "error">;
  activeTab: string | null;
  activeSessionPath: string | null;
  tree: FileNode[];
  remoteHydration: RemoteHydrationState;
  fileTreeStatus: "idle" | "loading" | "refreshing" | "error";
  fileTreeError: string | null;
  onSidebarResizerDown: () => void;
  onToggleProject: (project: ProjectGroup) => void;
  onNewLocalProject: () => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onNewProjectSession: (project: ProjectGroup) => void;
  onAddRemoteServer: () => void;
  onConnectServer: (server: RemoteServerGroup) => Promise<boolean> | void;
  onAddRemoteProjectForServer: (server: RemoteServerGroup) => void;
  onOpenSession: (session: SessionItem, projectCwd?: string) => void;
  onOpenRemoteSession: (tabId: string, projectCwd: string, session: SessionItem) => void;
  onDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => void;
  onHandleSessionCtx: (e: React.MouseEvent, session: SessionItem) => void;
  onSelectAllSessions: (sessions: SessionItem[]) => void;
  onToggleSessionSelect: (path: string) => void;
  renderTree: (nodes: FileNode[], depth: number) => ReactNode;
  onTreeCtx: (e: React.MouseEvent, node: FileNode | null) => void;
}

const Sidebar = memo(function Sidebar({
  leftWidth,
  sidebarRef,
  sidebarSplit,
  theme,
  toggleTheme,
  selectedSessions,
  handleBatchDelete,
  setSelectedSessions,
  localProjectGroups,
  remoteServers,
  isRemote,
  cwd,
  remoteDir,
  expandedProjects,
  projectLoading,
  projectSessionStatus,
  activeTab,
  activeSessionPath,
  tree,
  remoteHydration,
  fileTreeStatus,
  fileTreeError,
  onSidebarResizerDown,
  onToggleProject,
  onNewLocalProject,
  onDeleteProject,
  onNewProjectSession,
  onAddRemoteServer,
  onConnectServer,
  onAddRemoteProjectForServer,
  onOpenSession,
  onOpenRemoteSession,
  onDeleteSession,
  onHandleSessionCtx,
  onSelectAllSessions,
  onToggleSessionSelect,
  renderTree,
  onTreeCtx,
  wslConnections,
  onWslConnect,
  onAddWslProject,
}: SidebarProps) {
  // Stable per-section active predicates (memoized) so the memoized section
  // components don't re-render on every Sidebar render.
  const isLocalProjectActive = useCallback(
    (project: ProjectGroup) => !isRemote && (cwd === project.cwd || project.sessions.some((s) => s.path === activeSessionPath)),
    [isRemote, cwd, activeSessionPath],
  );
  const isRemoteProjectActive = useCallback(
    (project: ProjectGroup) => project.tabId === activeTab || project.sessions.some((s) => s.path === activeSessionPath),
    [activeTab, activeSessionPath],
  );
  return (
    <aside className="sidebar" ref={sidebarRef} style={{ width: leftWidth, flex: "0 0 auto" }}>
      <div className="sidebar-header">
        <span className="sidebar-title" title={isRemote && remoteDir ? remoteDir : cwd}>项目与会话</span>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={toggleTheme} title={theme === "dark" ? "浅色主题" : "深色主题"}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </div>
      <div className="sidebar-top" style={{ height: `${sidebarSplit}%` }}>
        <div className="panel-label">项目 / 会话</div>
        {selectedSessions.size > 0 && (
          <div className="batch-bar">
            <span>已选 {selectedSessions.size} 个</span>
            <button className="btn btn-danger btn-small" onClick={handleBatchDelete}>删除选中</button>
            <button className="btn btn-small" onClick={() => setSelectedSessions(new Set())}>取消</button>
          </div>
        )}
        <div className="session-scroll">
          <ProjectGroupSection
            title="本地项目"
            emptyText="（暂无本地项目）"
            addTitle="新增本地项目"
            onAdd={onNewLocalProject}
            projects={localProjectGroups}
            expandedProjects={expandedProjects}
            projectLoading={projectLoading}
            projectSessionStatus={projectSessionStatus}
            selectedSessions={selectedSessions}
            activeSessionPath={activeSessionPath}
            isProjectActive={isLocalProjectActive}
            onToggleProject={onToggleProject}
            onDeleteProject={onDeleteProject}
            onNewProjectSession={onNewProjectSession}
            onOpenSession={onOpenSession}
            onDeleteSession={onDeleteSession}
            onHandleSessionCtx={onHandleSessionCtx}
            onSelectAllSessions={onSelectAllSessions}
            onToggleSessionSelect={onToggleSessionSelect}
          />
          <RemoteServerSection
            title="远程服务器"
            titleIcon="globe"
            emptyText="（暂无服务器，点 + 连接）"
            servers={remoteServers}
            expandedProjects={expandedProjects}
            projectLoading={projectLoading}
            projectSessionStatus={projectSessionStatus}
            selectedSessions={selectedSessions}
            activeSessionPath={activeSessionPath}
            isProjectActive={isRemoteProjectActive}
            onToggleProject={onToggleProject}
            onDeleteProject={onDeleteProject}
            onNewProjectSession={onNewProjectSession}
            onOpenRemoteSession={onOpenRemoteSession}
            onDeleteSession={onDeleteSession}
            onSelectAllSessions={onSelectAllSessions}
            onToggleSessionSelect={onToggleSessionSelect}
            onAddServer={onAddRemoteServer}
            onConnectServer={onConnectServer}
            onAddProjectForServer={onAddRemoteProjectForServer}
          />
          <WslConnectionSection
            title="WSL"
            titleIcon="penguin"
            emptyText="（暂无 WSL 连接）"
            connections={wslConnections}
            expandedProjects={expandedProjects}
            projectLoading={projectLoading}
            projectSessionStatus={projectSessionStatus}
            selectedSessions={selectedSessions}
            activeSessionPath={activeSessionPath}
            isProjectActive={isRemoteProjectActive}
            onToggleProject={onToggleProject}
            onDeleteProject={onDeleteProject}
            onNewProjectSession={onNewProjectSession}
            onOpenRemoteSession={onOpenRemoteSession}
            onDeleteSession={onDeleteSession}
            onSelectAllSessions={onSelectAllSessions}
            onToggleSessionSelect={onToggleSessionSelect}
            onWslConnect={onWslConnect}
            onAddWslProject={onAddWslProject}
          />
        </div>
      </div>
      <div className="sidebar-resizer" onMouseDown={onSidebarResizerDown} />
      <div className="sidebar-bottom" style={{ height: `${100 - sidebarSplit}%` }}>
        <div className="panel-label">当前项目文件</div>
        {(isRemote ? remoteDir : cwd) ? (
          <div className="tree-path" title={isRemote ? remoteDir! : cwd}>
            <Icon name="folder-open" className="tree-path-icon" /> {(isRemote ? remoteDir! : cwd).replace(/^\/home\/[^/]+/, "~")}
          </div>
        ) : null}
        <div className="tree-scroll" onContextMenu={(e) => onTreeCtx(e, null)}>
          {fileTreeStatus === "loading" ? (
            <div className="placeholder">远程文件加载中…</div>
          ) : fileTreeStatus === "refreshing" ? (
            <>
              <div className="placeholder">远程文件刷新中…</div>
              {renderTree(tree, 0)}
            </>
          ) : fileTreeStatus === "error" ? (
            <div className="placeholder">远程文件加载失败{fileTreeError ? `：${fileTreeError}` : "，请重试"}</div>
          ) : tree.length === 0 && !isRemote ? (
            <div className="placeholder">（无文件）</div>
          ) : tree.length === 0 && isRemote ? (
            <div className="placeholder">加载中…</div>
          ) : (
            renderTree(tree, 0)
          )}
        </div>
      </div>
    </aside>
  );
});

// --- Project sections --------------------------------------------------------

interface ProjectGroupSectionProps {
  title: string;
  titleIcon?: IconName;
  emptyText: string;
  addTitle: string;
  onAdd: () => void;
  projects: ProjectGroup[];
  expandedProjects: Set<string>;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, "idle" | "loading" | "ready" | "empty" | "error">;
  selectedSessions: Set<string>;
  activeSessionPath: string | null;
  isProjectActive: (project: ProjectGroup) => boolean;
  onToggleProject: (project: ProjectGroup) => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onNewProjectSession: (project: ProjectGroup) => void;
  onOpenSession?: (session: SessionItem, projectCwd?: string) => void;
  onOpenRemoteSession?: (tabId: string, projectCwd: string, session: SessionItem) => void;
  onDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => void;
  onHandleSessionCtx?: (e: React.MouseEvent, session: SessionItem) => void;
  onSelectAllSessions: (sessions: SessionItem[]) => void;
  onToggleSessionSelect: (path: string) => void;
  isRemoteSection?: boolean;
  isWslSection?: boolean;
}

interface ProjectItemProps {
  project: ProjectGroup;
  expanded: boolean;
  isRemoteSection?: boolean;
  isWslSection?: boolean;
  active: boolean;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, "idle" | "loading" | "ready" | "empty" | "error">;
  selectedSessions: Set<string>;
  activeSessionPath: string | null;
  onToggleProject: (project: ProjectGroup) => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onNewProjectSession: (project: ProjectGroup) => void;
  onOpenSession?: (session: SessionItem, projectCwd?: string) => void;
  onOpenRemoteSession?: (tabId: string, projectCwd: string, session: SessionItem) => void;
  onDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => void;
  onHandleSessionCtx?: (e: React.MouseEvent, session: SessionItem) => void;
  onSelectAllSessions: (sessions: SessionItem[]) => void;
  onToggleSessionSelect: (path: string) => void;
}

/** A single project row + its expanded session list (shared by all sections). */
const ProjectItem = memo(function ProjectItem({
  project, expanded, isRemoteSection, isWslSection, active,
  projectLoading, projectSessionStatus, selectedSessions, activeSessionPath,
  onToggleProject, onDeleteProject, onNewProjectSession, onOpenSession,
  onOpenRemoteSession, onDeleteSession, onHandleSessionCtx,
  onSelectAllSessions, onToggleSessionSelect,
}: ProjectItemProps) {
  const disabled = !!project.disabled;
  const onOpen = (session: SessionItem) => {
    if (isRemoteSection) {
      if (project.tabId && onOpenRemoteSession) onOpenRemoteSession(project.tabId, project.cwd, session);
      return;
    }
    onOpenSession?.(session, project.cwd);
  };
  return (
    <div className="project-group">
      <div
        className={`project-row${active ? " active" : ""}${disabled ? " disabled" : ""}`}
        onClick={() => {
          // WSL / server projects: clicking a disconnected project auto-connects
          // its host (handled inside toggleProject) rather than no-op.
          if (!disabled || isWslSection || isRemoteSection) onToggleProject(project);
        }}
        title={disabled ? `未连接：${isWslSection ? project.host : `${project.user}@${project.host}`}` : isWslSection ? `🐧 ${project.host}:${project.cwd}` : isRemoteSection ? `${project.user}@${project.host}:${project.cwd}` : project.cwd}
      >
        <span className="tree-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="project-icon"><Icon name={isWslSection ? "penguin" : isRemoteSection ? "globe" : "folder"} /></span>
        <span className="project-name">{project.label}</span>
        <button className="row-action" disabled={disabled} onClick={(e) => { e.stopPropagation(); onNewProjectSession(project); }} title={disabled ? "请先连接远程" : "新建会话"}>+</button>
        <button className="row-delete" onClick={(e) => { e.stopPropagation(); onDeleteProject(project); }} title="删除项目">×</button>
      </div>
      {expanded && (
        <div className="project-sessions">
          {isRemoteSection && <div className="remote-project-path">{project.cwd}</div>}
          {isRemoteSection && project.error ? <div className="placeholder">远程会话加载失败：{project.error}</div> : isRemoteSection && (projectSessionStatus[project.key] === "loading" || projectSessionStatus[project.key] === "idle") && project.sessions.length === 0 ? <div className="placeholder">远程会话加载中…</div> : projectLoading[project.key] ? <div className="placeholder">加载中…</div> : project.sessions.length === 0 ? <div className="placeholder">（无会话，点 + 新建）</div> : (
            <>
              <div className="session-select-all" onClick={() => onSelectAllSessions(project.sessions)}>
                {project.sessions.every((s) => selectedSessions.has(s.path)) ? "☑" : "☐"} 全选
              </div>
              {project.sessions.map((session) => (
                <SessionRow
                  key={session.path}
                  session={session}
                  active={session.path === activeSessionPath}
                  checked={selectedSessions.has(session.path)}
                  onToggleChecked={onToggleSessionSelect}
                  onOpen={() => onOpen(session)}
                  onDelete={() => onDeleteSession(session, isRemoteSection ? project.tabId : undefined, isRemoteSection ? project.cwd : undefined)}
                  onContextMenu={onHandleSessionCtx ? (e) => onHandleSessionCtx(e, session) : undefined}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
});

const ProjectGroupSection = memo(function ProjectGroupSection({
  title,
  titleIcon,
  emptyText,
  addTitle,
  onAdd,
  projects,
  expandedProjects,
  projectLoading,
  projectSessionStatus,
  selectedSessions,
  activeSessionPath,
  isProjectActive,
  onToggleProject,
  onDeleteProject,
  onNewProjectSession,
  onOpenSession,
  onOpenRemoteSession,
  onDeleteSession,
  onHandleSessionCtx,
  onSelectAllSessions,
  onToggleSessionSelect,
  isRemoteSection,
  isWslSection,
}: ProjectGroupSectionProps) {
  return (
    <div className="group-block">
      <div className="group-title group-title-row"><span className="group-title-label">{titleIcon && <Icon name={titleIcon} />}{title}</span><button className="group-add" onClick={onAdd} title={addTitle}>+</button></div>
      {projects.length === 0 ? <div className="placeholder">{emptyText}</div> : projects.map((project) => (
        <ProjectItem
          key={project.key}
          project={project}
          expanded={expandedProjects.has(project.key)}
          isRemoteSection={isRemoteSection}
          isWslSection={isWslSection}
          active={isProjectActive(project)}
          projectLoading={projectLoading}
          projectSessionStatus={projectSessionStatus}
          selectedSessions={selectedSessions}
          activeSessionPath={activeSessionPath}
          onToggleProject={onToggleProject}
          onDeleteProject={onDeleteProject}
          onNewProjectSession={onNewProjectSession}
          onOpenSession={onOpenSession}
          onOpenRemoteSession={onOpenRemoteSession}
          onDeleteSession={onDeleteSession}
          onHandleSessionCtx={onHandleSessionCtx}
          onSelectAllSessions={onSelectAllSessions}
          onToggleSessionSelect={onToggleSessionSelect}
        />
      ))}
    </div>
  );
});

interface WslConnectionSectionProps {
  title: string;
  titleIcon?: IconName;
  emptyText: string;
  connections: WslConnectionGroup[];
  expandedProjects: Set<string>;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, "idle" | "loading" | "ready" | "empty" | "error">;
  selectedSessions: Set<string>;
  activeSessionPath: string | null;
  isProjectActive: (project: ProjectGroup) => boolean;
  onToggleProject: (project: ProjectGroup) => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onNewProjectSession: (project: ProjectGroup) => void;
  onOpenRemoteSession?: (tabId: string, projectCwd: string, session: SessionItem) => void;
  onDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => void;
  onSelectAllSessions: (sessions: SessionItem[]) => void;
  onToggleSessionSelect: (path: string) => void;
  onWslConnect: (distro: string) => void;
  onAddWslProject: (distro: string) => void;
}

/** WSL sidebar section: each distro is a connection node with a + that opens
 *  the folder picker; projects (folders) hang beneath it. */
const WslConnectionSection = memo(function WslConnectionSection({
  title, titleIcon, emptyText, connections, expandedProjects, projectLoading,
  projectSessionStatus, selectedSessions, activeSessionPath, isProjectActive,
  onToggleProject, onDeleteProject, onNewProjectSession, onOpenRemoteSession,
  onDeleteSession, onSelectAllSessions, onToggleSessionSelect,
  onWslConnect, onAddWslProject,
}: WslConnectionSectionProps) {
  const [openConnections, setOpenConnections] = useState<Set<string>>(new Set());
  const toggleConnection = (distro: string) => {
    setOpenConnections((prev) => {
      const next = new Set(prev);
      if (next.has(distro)) next.delete(distro);
      else next.add(distro);
      return next;
    });
  };
  return (
    <div className="group-block">
      <div className="group-title"><span className="group-title-label">{titleIcon && <Icon name={titleIcon} />}{title}</span></div>
      {connections.length === 0 ? <div className="placeholder">{emptyText}</div> : connections.map((conn) => {
        const isOpen = openConnections.has(conn.distro);
        return (
          <div key={conn.distro} className="wsl-connection">
            <div
              className={`project-row${conn.connected ? " wsl-connected" : ""}`}
              onClick={() => {
                if (!conn.connected) { void onWslConnect(conn.distro); return; }
                // Connected: activate the tab AND toggle the project list.
                void onWslConnect(conn.distro);
                toggleConnection(conn.distro);
              }}
              title={conn.connected ? `🐧 ${conn.distro}（点击收起/展开）` : `连接 ${conn.distro}`}
            >
              <span className="tree-chevron">{isOpen ? "▾" : "▸"}</span>
              <span className="project-icon"><Icon name="penguin" /></span>
              <span className="project-name">{conn.distro}</span>
              {!conn.connected && <span className="wsl-connect-hint">连接</span>}
              <button
                className="row-action"
                onClick={(e) => { e.stopPropagation(); void onAddWslProject(conn.distro); }}
                title={`在 ${conn.distro} 中选择目录创建项目`}
              >+</button>
            </div>
            {isOpen && (
              <div className="wsl-projects">
                {conn.projects.length === 0 ? (
                  <div className="placeholder">暂无项目，点击右侧 + 选择目录</div>
                ) : conn.projects.map((project) => (
                  <ProjectItem
                    key={project.key}
                    project={project}
                    expanded={expandedProjects.has(project.key)}
                    isRemoteSection
                    isWslSection
                    active={isProjectActive(project)}
                    projectLoading={projectLoading}
                    projectSessionStatus={projectSessionStatus}
                    selectedSessions={selectedSessions}
                    activeSessionPath={activeSessionPath}
                    onToggleProject={onToggleProject}
                    onDeleteProject={onDeleteProject}
                    onNewProjectSession={onNewProjectSession}
                    onOpenRemoteSession={onOpenRemoteSession}
                    onDeleteSession={onDeleteSession}
                    onSelectAllSessions={onSelectAllSessions}
                    onToggleSessionSelect={onToggleSessionSelect}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

interface RemoteServerSectionProps {
  title: string;
  titleIcon?: IconName;
  emptyText: string;
  servers: RemoteServerGroup[];
  expandedProjects: Set<string>;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, "idle" | "loading" | "ready" | "empty" | "error">;
  selectedSessions: Set<string>;
  activeSessionPath: string | null;
  isProjectActive: (project: ProjectGroup) => boolean;
  onToggleProject: (project: ProjectGroup) => void;
  onDeleteProject: (project: ProjectGroup) => void;
  onNewProjectSession: (project: ProjectGroup) => void;
  onOpenRemoteSession?: (tabId: string, projectCwd: string, session: SessionItem) => void;
  onDeleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => void;
  onSelectAllSessions: (sessions: SessionItem[]) => void;
  onToggleSessionSelect: (path: string) => void;
  onAddServer: () => void;
  onConnectServer: (server: RemoteServerGroup) => Promise<boolean> | void;
  onAddProjectForServer: (server: RemoteServerGroup) => void;
}

/** SSH server section: each server (user@host) is a connection node with its
 *  project folders hanging beneath it — mirrors the WSL section. The header +
 *  opens the connect dialog; each node's + browses THAT server's directories
 *  (the old picker always targeted the first remote tab, which made a second
 *  server impossible to reach). */
const RemoteServerSection = memo(function RemoteServerSection({
  title, titleIcon, emptyText, servers, expandedProjects, projectLoading,
  projectSessionStatus, selectedSessions, activeSessionPath, isProjectActive,
  onToggleProject, onDeleteProject, onNewProjectSession, onOpenRemoteSession,
  onDeleteSession, onSelectAllSessions, onToggleSessionSelect,
  onAddServer, onConnectServer, onAddProjectForServer,
}: RemoteServerSectionProps) {
  const [openServers, setOpenServers] = useState<Set<string>>(new Set());
  const toggleServer = (key: string) => {
    setOpenServers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="group-block">
      <div className="group-title group-title-row">
        <span className="group-title-label">{titleIcon && <Icon name={titleIcon} />}{title}</span>
        <button className="group-add" onClick={onAddServer} title="连接新的服务器">+</button>
      </div>
      {servers.length === 0 ? <div className="placeholder">{emptyText}</div> : servers.map((server) => {
        const isOpen = openServers.has(server.key);
        const status = server.status;
        const hint =
          status === "connecting" ? "连接中…" :
          status === "failed" ? "连接失败" :
          status === "disconnected" ? "未连接" : null;
        return (
          <div key={server.key} className="remote-server-connection">
            <div
              className={`project-row${status === "connected" ? " server-connected" : ""}`}
              onClick={() => {
                if (status !== "connected") {
                  // Connect (or reconnect after a failure), then reveal the
                  // projects once the shell is confirmed alive.
                  const p = onConnectServer(server) as Promise<boolean> | undefined;
                  if (p?.then) void p.then((ok) => { if (ok) toggleServer(server.key); });
                  return;
                }
                // Connected: activate the server's shell tab AND toggle the projects.
                void onConnectServer(server);
                toggleServer(server.key);
              }}
              title={status === "connected" ? `${server.label}（点击收起/展开）` : `连接 ${server.label}`}
            >
              <span className="tree-chevron">{isOpen ? "▾" : "▸"}</span>
              <span className="project-icon"><Icon name="globe" /></span>
              <span className="project-name">{server.label}</span>
              {hint && <span className={`server-connect-hint${status === "failed" ? " failed" : status === "connecting" ? " connecting" : ""}`}>{hint}</span>}
              <button
                className="row-action"
                onClick={(e) => { e.stopPropagation(); void onAddProjectForServer(server); }}
                title={`在 ${server.label} 中选择目录创建项目`}
              >+</button>
              <button
                className="row-delete"
                onClick={(e) => { e.stopPropagation(); void useSessionsStore.getState().deleteServer(server); }}
                title={`删除服务器 ${server.label}`}
              >×</button>
            </div>
            {isOpen && (
              <div className="remote-server-projects">
                {server.projects.length === 0 ? (
                  <div className="placeholder">暂无项目，点击右侧 + 选择目录</div>
                ) : server.projects.map((project) => (
                  <ProjectItem
                    key={project.key}
                    project={project}
                    expanded={expandedProjects.has(project.key)}
                    isRemoteSection
                    active={isProjectActive(project)}
                    projectLoading={projectLoading}
                    projectSessionStatus={projectSessionStatus}
                    selectedSessions={selectedSessions}
                    activeSessionPath={activeSessionPath}
                    onToggleProject={onToggleProject}
                    onDeleteProject={onDeleteProject}
                    onNewProjectSession={onNewProjectSession}
                    onOpenRemoteSession={onOpenRemoteSession}
                    onDeleteSession={onDeleteSession}
                    onSelectAllSessions={onSelectAllSessions}
                    onToggleSessionSelect={onToggleSessionSelect}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

interface SessionRowProps {
  session: SessionItem;
  active?: boolean;
  checked: boolean;
  onToggleChecked: (path: string) => void;
  onOpen: () => void;
  onDelete: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

const SessionRow = memo(function SessionRow({ session, active, checked, onToggleChecked, onOpen, onDelete, onContextMenu }: SessionRowProps) {
  // Remote metadata-only entries (not yet hydrated) carry no name/firstMessage
  // and a placeholder count of 0 — rendering "0 条" would be misleading.
  const hydrating = session.name === null && session.firstMessage === "" && session.messageCount === 0;
  return (
    <div
      className={`session-row${active ? " active" : ""}`}
      data-session-path={session.path}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={session.firstMessage || "会话信息加载中…"}
    >
      <input type="checkbox" className="session-check" checked={checked} onChange={() => onToggleChecked(session.path)} onClick={(e) => e.stopPropagation()} />
      <div className="session-body">
        <div className="session-preview">{sessionLabel(session)}</div>
        <div className="session-meta"><span>{hydrating ? "同步中…" : `${session.messageCount} 条`}</span><span>{relativeTime(session.mtime)}</span></div>
      </div>
      <button className="row-delete session-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="删除会话">×</button>
    </div>
  );
});

// --- Tree row ---------------------------------------------------------------

interface TreeRowProps {
  node: FileNode;
  depth: number;
  isExpanded: boolean;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string, followed: boolean) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

const TreeRow = memo(function TreeRow({ node, depth, isExpanded, expandedPaths, onToggle, onOpen, onContextMenu }: TreeRowProps) {
  const isDir = node.type === "directory";
  return (
    <>
      <div
        className={`tree-row${isDir ? " tree-dir" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={() => (isDir ? onToggle(node.path) : onOpen(node.path, false))}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className="tree-chevron">{isDir ? (isExpanded ? "▾" : "▸") : ""}</span>
        <span className="tree-icon"><Icon name={isDir ? (isExpanded ? "folder-open" : "folder") : "file"} /></span>
        <span className="tree-name">{node.name}</span>
      </div>
      {isDir && isExpanded && node.children && (
        <>{node.children.map((c) => (
          <TreeBranch
            key={c.path}
            node={c}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
        ))}</>
      )}
      {/* Lazy tree: an expanded dir whose children haven't loaded yet. */}
      {isDir && isExpanded && node.children === undefined && (
        <div className="tree-row" style={{ paddingLeft: `${(depth + 1) * 12 + 6}px` }}>
          <span className="tree-name tree-muted">…加载中</span>
        </div>
      )}
    </>
  );
});

interface TreeBranchProps {
  node: FileNode;
  depth: number;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string, followed: boolean) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

const TreeBranch = memo(function TreeBranch({ node, depth, expandedPaths, onToggle, onOpen, onContextMenu }: TreeBranchProps) {
  return (
    <TreeRow
      node={node}
      depth={depth}
      isExpanded={expandedPaths.has(node.path)}
      expandedPaths={expandedPaths}
      onToggle={onToggle}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
    />
  );
});

// --- Helpers ----------------------------------------------------------------

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  if (diff < min) return "刚刚";
  if (diff < hr) return `${Math.floor(diff / min)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hr)}小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  return new Date(ms).toLocaleDateString();
}

