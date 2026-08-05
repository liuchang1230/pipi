// Project + session sidebar state: the project catalog, per-project session
// lists, hydration progress, batch selection. Setters accept either a direct
// value or an updater function (mirroring React's Dispatch<SetStateAction>).
// Session lifecycle (open/delete/batch) is owned here as store actions — the
// sidebar calls one action instead of threading a 9-item handler object; the
// "refresh caches after delete" invariant lives next to the delete itself.
import { create } from "zustand";
import { useTabsStore } from "./tabsStore";
import { useTreeStore, sortFileNodes } from "./treeStore";
import { apply, type Updater } from "./utils";
import type {
  AutoFollowSettings,
  FileNode,
  ProjectGroup,
  ProjectListItem,
  ProjectSessionStatus,
  RemoteFileDiagnostics,
  RemoteHistoryItem,
  RemoteHydrationState,
  SessionItem,
} from "./types";

// --- Shared helpers (were module-level in App.tsx) -------------------------

export function sessionLabel(s: SessionItem): string {
  const label = (s.name || s.firstMessage || "").trim();
  return label ? label.slice(0, 40) : "正在加载会话信息…";
}

export const remoteSessionCacheKey = (tabId: string, remoteCwd: string) => `${tabId}:${remoteCwd}`;
export const buildRemoteKey = (host?: string, user?: string, port?: number) => `${user ?? ""}@${host ?? ""}:${port ?? 22}`;

/** In-flight open guards (module-level, not reactive: never a re-render). */
const openingSessions = new Set<string>();

interface SessionsState {
  // Project catalog
  projects: ProjectListItem[];
  remoteHistory: RemoteHistoryItem[];
  refreshProjects: () => Promise<void>;
  setProjects: (projects: ProjectListItem[]) => void;
  upsertProject: (project: ProjectListItem) => void;
  setRemoteHistory: (items: RemoteHistoryItem[]) => void;

  // Active local session list + per-project lists
  sessions: SessionItem[];
  projectSessions: Record<string, SessionItem[]>;
  remoteSessions: Record<string, SessionItem[]>;
  projectLoading: Record<string, boolean>;
  projectSessionStatus: Record<string, ProjectSessionStatus>;
  projectErrors: Record<string, string | undefined>;
  projectDiagnostics: Record<string, RemoteFileDiagnostics | undefined>;
  projectTrees: Record<string, import("./types").FileNode[]>;
  selectedSessions: Set<string>;
  remoteHydration: RemoteHydrationState;
  expandedProjects: Set<string>;

  setSessions: (updater: Updater<SessionItem[]>) => void;
  loadSessions: (cwd?: string) => Promise<void>;
  setProjectSessions: (updater: Updater<Record<string, SessionItem[]>>) => void;
  setRemoteSessions: (updater: Updater<Record<string, SessionItem[]>>) => void;
  setProjectLoading: (updater: Updater<Record<string, boolean>>) => void;
  setProjectSessionStatus: (updater: Updater<Record<string, ProjectSessionStatus>>) => void;
  setProjectErrors: (updater: Updater<Record<string, string | undefined>>) => void;
  setProjectDiagnostics: (updater: Updater<Record<string, RemoteFileDiagnostics | undefined>>) => void;
  setProjectTrees: (updater: Updater<Record<string, import("./types").FileNode[]>>) => void;
  setSelectedSessions: (updater: Updater<Set<string>>) => void;
  setRemoteHydration: (updater: Updater<RemoteHydrationState>) => void;
  setExpandedProjects: (updater: Updater<Set<string>>) => void;

  // Session lifecycle actions
  openSession: (session: SessionItem, projectCwd?: string) => Promise<void>;
  openRemoteSession: (tabId: string, projectCwd: string, session: SessionItem) => Promise<void>;
  deleteSession: (session: SessionItem, tabId?: string, projectCwd?: string) => Promise<void>;
  batchDelete: (tabId?: string, projectCwd?: string) => Promise<void>;
  toggleSessionSelect: (path: string) => void;
  selectAllSessions: (items: SessionItem[]) => void;

  // Project explorer orchestration (hydration phases + cache fast paths)
  toggleProject: (project: ProjectGroup) => Promise<void>;
  deleteProject: (project: ProjectGroup) => Promise<void>;
  newProjectSession: (project: ProjectGroup) => Promise<void>;

  // Project catalog actions (used by the native picker + remote dir picker)
  addLocalProject: (dir: string) => Promise<void>;
  addRemoteProject: (remote: { host: string; user: string; port?: number; path: string; password?: string }) => Promise<void>;
  addWslProject: (distro: string, path: string) => Promise<void>;
}

/** After deleting session files, refresh any LOCAL project cache that held
 *  them so the sidebar never shows deleted rows. Shared by deleteSession and
 *  batchDelete (the invariant lives with the delete, not at call sites). */
async function refreshProjectCachesForDeleted(
  deletedPaths: string[],
  get: () => SessionsState,
  set: (updater: Partial<SessionsState> | ((s: SessionsState) => Partial<SessionsState>)) => void,
): Promise<void> {
  if (deletedPaths.length === 0) return;
  const deletedSet = new Set(deletedPaths);
  const st = get();
  for (const p of st.projects) {
    if (p.type !== "local" || !p.cwd) continue;
    const cached = st.projectSessions[p.id];
    if (!cached?.some((s) => deletedSet.has(s.path))) continue;
    // Functional updaters only: the loop may touch several projects, and a
    // snapshot taken once at the top would revert earlier updates (the
    // deleted session would reappear for the first project).
    set((s) => ({ projectSessionStatus: { ...s.projectSessionStatus, [p.id]: "loading" } }));
    try {
      const list = (await window.api.session.list(p.cwd)) as SessionItem[];
      set((s) => ({
        projectSessions: { ...s.projectSessions, [p.id]: list },
        projectSessionStatus: { ...s.projectSessionStatus, [p.id]: list.length > 0 ? "ready" : "empty" },
      }));
    } catch {
      set((s) => ({ projectSessionStatus: { ...s.projectSessionStatus, [p.id]: "error" } }));
    }
  }
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  projects: [],
  remoteHistory: [],
  refreshProjects: async () => {
    try {
      set({ projects: await window.api.project.list() });
    } catch {
      set({ projects: [] });
    }
  },
  setProjects: (projects) => set({ projects }),
  upsertProject: (project) =>
    set((s) => {
      const idx = s.projects.findIndex((p) => p.id === project.id);
      if (idx < 0) return { projects: [...s.projects, project] };
      const next = [...s.projects];
      next[idx] = project;
      return { projects: next };
    }),
  setRemoteHistory: (remoteHistory) => set({ remoteHistory }),

  sessions: [],
  projectSessions: {},
  remoteSessions: {},
  projectLoading: {},
  projectSessionStatus: {},
  projectErrors: {},
  projectDiagnostics: {},
  projectTrees: {},
  selectedSessions: new Set<string>(),
  remoteHydration: { phase: "idle" },
  expandedProjects: new Set<string>(),

  setSessions: (updater) => set((s) => ({ sessions: apply(s.sessions, updater) })),
  loadSessions: async (cwd) => {
    try {
      const list = (await window.api.session.list(cwd)) as SessionItem[];
      set({ sessions: list });
    } catch {
      set({ sessions: [] });
    }
  },
  setProjectSessions: (updater) => set((s) => ({ projectSessions: apply(s.projectSessions, updater) })),
  setRemoteSessions: (updater) => set((s) => ({ remoteSessions: apply(s.remoteSessions, updater) })),
  setProjectLoading: (updater) => set((s) => ({ projectLoading: apply(s.projectLoading, updater) })),
  setProjectSessionStatus: (updater) => set((s) => ({ projectSessionStatus: apply(s.projectSessionStatus, updater) })),
  setProjectErrors: (updater) => set((s) => ({ projectErrors: apply(s.projectErrors, updater) })),
  setProjectDiagnostics: (updater) => set((s) => ({ projectDiagnostics: apply(s.projectDiagnostics, updater) })),
  setProjectTrees: (updater) => set((s) => ({ projectTrees: apply(s.projectTrees, updater) })),
  setSelectedSessions: (updater) => set((s) => ({ selectedSessions: apply(s.selectedSessions, updater) })),
  setRemoteHydration: (updater) => set((s) => ({ remoteHydration: apply(s.remoteHydration, updater) })),
  setExpandedProjects: (updater) => set((s) => ({ expandedProjects: apply(s.expandedProjects, updater) })),

  openSession: async (session, projectCwd) => {
    if (openingSessions.has(session.path)) return;
    const existing = useTabsStore.getState().tabs.find((t) => t.sessionPath === session.path);
    if (existing) {
      await window.api.tab.activate(existing.id);
      return;
    }
    openingSessions.add(session.path);
    try {
      await window.api.tab.create({
        cwd: projectCwd || useTabsStore.getState().cwd,
        sessionPath: session.path,
        continueRecent: false,
        title: sessionLabel(session),
      });
    } finally {
      openingSessions.delete(session.path);
    }
  },
  openRemoteSession: async (tabId, projectCwd, session) => {
    if (openingSessions.has(session.path)) return;
    const existing = useTabsStore.getState().tabs.find((t) => t.sessionPath === session.path);
    if (existing) {
      await window.api.tab.activate(existing.id);
      return;
    }
    const remote = await window.api.remote.getInfo(tabId);
    if (!remote) return;
    openingSessions.add(session.path);
    try {
      if ((remote as { isWsl?: boolean }).isWsl) {
        await window.api.tab.create({
          cwd: useTabsStore.getState().cwd || ".",
          sessionPath: session.path,
          title: sessionLabel(session),
          wsl: { distro: (remote as { host: string }).host, path: projectCwd },
        });
      } else {
        await window.api.tab.create({
          cwd: useTabsStore.getState().cwd || ".",
          sessionPath: session.path,
          title: sessionLabel(session),
          remote: {
            host: remote.host,
            user: remote.user,
            port: remote.port,
            path: projectCwd,
            password: remote.password,
          },
        });
      }
    } finally {
      openingSessions.delete(session.path);
    }
  },
  deleteSession: async (session, tabId, projectCwd) => {
    if (!confirm(`删除该会话？\n${sessionLabel(session)}`)) return;
    const opened = useTabsStore.getState().tabs.filter((t) => t.sessionPath === session.path);
    for (const tab of opened) {
      try {
        await window.api.tab.close(tab.id);
      } catch {
        /* 标签页可能已关闭，忽略 */
      }
    }
    const result = await window.api.session.delete(session.path, tabId);
    if (!result.ok) {
      alert(`删除失败: ${result.error}`);
      return;
    }
    set((s) => ({ sessions: s.sessions.filter((item) => item.path !== session.path) }));
    await refreshProjectCachesForDeleted([session.path], get, set);
    await get().loadSessions(useTabsStore.getState().cwd);
    await get().refreshProjects();
    if (tabId && projectCwd) {
      const remoteList = await window.api.session.listRemote(tabId, projectCwd);
      set((s) => ({ remoteSessions: { ...s.remoteSessions, [remoteSessionCacheKey(tabId, projectCwd)]: remoteList.sessions as SessionItem[] } }));
    }
  },
  batchDelete: async (tabId, projectCwd) => {
    const selected = get().selectedSessions;
    if (selected.size === 0) return;
    if (!confirm(`确定删除已选中的 ${selected.size} 个会话？\n此操作不可撤销。`)) return;
    const paths = [...selected];
    try {
      const tabsNow = useTabsStore.getState().tabs;
      for (const tab of tabsNow) {
        if (tab.sessionPath && paths.includes(tab.sessionPath)) {
          try {
            await window.api.tab.close(tab.id);
          } catch {
            /* 标签页可能已关闭，忽略 */
          }
        }
      }
      let ok = 0;
      const errors: string[] = [];
      for (const path of paths) {
        try {
          const result = await window.api.session.delete(path);
          if (result.ok) ok += 1;
          else errors.push(`${path}：${result.error ?? "未知错误"}`);
        } catch (err) {
          errors.push(`${path}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const fail = errors.length;
      if (fail > 0) {
        const detail = errors.slice(0, 5).join("\n");
        alert(`删除完成：${ok} 个成功，${fail} 个失败${errors.length > 5 ? `（还有 ${errors.length - 5} 个省略）` : ""}\n\n${detail}`);
      }
      if (ok > 0) {
        await refreshProjectCachesForDeleted(paths, get, set);
        await get().loadSessions(useTabsStore.getState().cwd);
        await get().refreshProjects();
      }
      const tabsState = useTabsStore.getState();
      if (tabsState.isRemote && tabId && projectCwd) {
        const remoteList = await window.api.session.listRemote(tabId, projectCwd);
        set((s) => ({ remoteSessions: { ...s.remoteSessions, [remoteSessionCacheKey(tabId, projectCwd)]: remoteList.sessions as SessionItem[] } }));
      }
    } catch (err) {
      alert(`批量删除出错：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      set({ selectedSessions: new Set() });
    }
  },
  toggleSessionSelect: (path) =>
    set((s) => {
      const next = new Set(s.selectedSessions);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { selectedSessions: next };
    }),
  selectAllSessions: (items) =>
    set((s) => {
      const next = new Set(s.selectedSessions);
      const allSelected = items.every((x) => next.has(x.path));
      for (const session of items) {
        if (allSelected) next.delete(session.path);
        else next.add(session.path);
      }
      return { selectedSessions: next };
    }),

  toggleProject: async (project) => {
    const willExpand = !get().expandedProjects.has(project.key);
    set((s) => {
      const next = new Set(s.expandedProjects);
      if (next.has(project.key)) next.delete(project.key);
      else next.add(project.key);
      return { expandedProjects: next };
    });

    if (project.type === "local") {
      const hasCachedSessions = !!get().projectSessions[project.key]?.length;
      if (willExpand && !hasCachedSessions) {
        set((s) => ({ projectLoading: { ...s.projectLoading, [project.key]: true } }));
        const list = await window.api.session.list(project.cwd);
        set((s) => ({
          projectSessions: { ...s.projectSessions, [project.key]: list as SessionItem[] },
          projectSessionStatus: { ...s.projectSessionStatus, [project.key]: list.length > 0 ? "ready" : "empty" },
          projectLoading: { ...s.projectLoading, [project.key]: false },
        }));
      }
      useTabsStore.getState().setCwd(project.cwd);
      useTabsStore.getState().setRemoteDir(null);
      useTabsStore.getState().setIsRemote(false);
      await useTreeStore.getState().loadTree(undefined, undefined, project.cwd, { isRemote: false });
      return;
    }

    // WSL projects: if the distro has no open tab, auto-connect it so the
    // click actually opens the project (was previously a silent no-op).
    let tabId = project.tabId;
    const tabsState = useTabsStore.getState();
    if (!tabId && project.host && (project.port ?? 22) === 0) {
      tabId = await window.api.tab.create({ cwd: tabsState.cwd || ".", wsl: { distro: project.host, path: project.cwd } });
      project.tabId = tabId;
    }
    if (!tabId) return;

    // Set the browse path BEFORE activating: the activation handler reads
    // getBrowsePath when tabs:active fires, so a stale path would load the
    // wrong tree and clobber the treeOrigin we set below (pre-existing race,
    // fixed here by ordering).
    await window.api.remote.setBrowsePath(tabId, project.cwd);
    await window.api.tab.activate(tabId);
    // One atomic activation (was six separate setters in App's hook).
    useTabsStore.setState({
      activeTab: tabId,
      isRemote: true,
      remoteDir: project.cwd,
      cwd: project.cwd,
      remoteLabel: project.host && (project.port ?? 22) === 0 ? `🐧 ${project.host}` : `${project.user}@${project.host}`,
    });
    // Record the origin BEFORE any cached tree is shown: file reads/mutations
    // must resolve against this project even while the activation handler's
    // async loadTree is still in flight.
    useTreeStore.setState({ treeOrigin: { tabId, dirPath: project.cwd, isRemote: true } });

    const remoteCacheKey = `${tabId}:${project.cwd}`;
    await window.api.session.setRemoteHydrationPaused(tabId, project.cwd, !willExpand);
    if (willExpand) await window.api.session.prioritizeRemote(tabId, project.cwd, 2);
    const st = get();
    const cachedTree = st.projectTrees[project.key] ?? useTreeStore.getState().remoteTreeCache[remoteCacheKey];
    if (cachedTree) useTreeStore.getState().setTree(sortFileNodes(cachedTree));

    if (willExpand) {
      const cachedSessions = st.projectSessions[project.key] ?? st.remoteSessions[remoteCacheKey] ?? [];
      const hasCachedTree = !!cachedTree?.length;
      const hasCachedSessions = cachedSessions.length > 0;
      if (hasCachedSessions) {
        set((s) => ({ projectSessions: { ...s.projectSessions, [project.key]: cachedSessions } }));
      }
      if (hasCachedTree && hasCachedSessions) {
        set((s) => ({ projectSessionStatus: { ...s.projectSessionStatus, [project.key]: "ready" } }));
        void window.api.session.listRemote(tabId, project.cwd).then((listResult) => {
          set((s) => ({
            projectSessions: { ...s.projectSessions, [project.key]: listResult.sessions as SessionItem[] },
            projectErrors: { ...s.projectErrors, [project.key]: listResult.error },
            projectDiagnostics: { ...s.projectDiagnostics, [project.key]: listResult.diagnostics },
            projectSessionStatus: { ...s.projectSessionStatus, [project.key]: listResult.error ? "error" : listResult.sessions.length > 0 ? "ready" : "empty" },
          }));
        }).catch(() => undefined);
        set((s) => ({ projectLoading: { ...s.projectLoading, [project.key]: false } }));
        set({ remoteHydration: { phase: "idle" } });
        return;
      }
      set((s) => ({ projectLoading: { ...s.projectLoading, [project.key]: true } }));
      set((s) => ({ projectSessionStatus: { ...s.projectSessionStatus, [project.key]: hasCachedSessions ? "ready" : "loading" } }));
      set({ remoteHydration: { phase: hasCachedSessions ? "hydrating" : "loading", tabId, remoteCwd: project.cwd } });

      if (!hasCachedSessions) {
        void window.api.session.listRemote(tabId, project.cwd).then((listResult) => {
          set((s) => ({
            projectSessions: { ...s.projectSessions, [project.key]: listResult.sessions as SessionItem[] },
            projectErrors: { ...s.projectErrors, [project.key]: listResult.error },
            projectDiagnostics: { ...s.projectDiagnostics, [project.key]: listResult.diagnostics },
            projectSessionStatus: { ...s.projectSessionStatus, [project.key]: listResult.error ? "error" : listResult.sessions.length > 0 ? "ready" : "empty" },
            projectLoading: { ...s.projectLoading, [project.key]: false },
          }));
          set({ remoteHydration: { phase: "idle" } });
        }).catch((error) => {
          set((s) => ({
            projectErrors: { ...s.projectErrors, [project.key]: error instanceof Error ? error.message : String(error) },
            projectSessionStatus: { ...s.projectSessionStatus, [project.key]: "error" },
            projectLoading: { ...s.projectLoading, [project.key]: false },
          }));
          set({ remoteHydration: { phase: "idle" } });
        });
      } else {
        set((s) => ({ projectLoading: { ...s.projectLoading, [project.key]: false } }));
      }

      if (!hasCachedTree) {
        const nodes = await window.api.file.list(tabId, project.cwd);
        const sortedNodes = sortFileNodes(nodes as FileNode[]);
        useTreeStore.getState().setTree(sortedNodes);
        set((s) => ({ projectTrees: { ...s.projectTrees, [project.key]: sortedNodes } }));
        useTreeStore.setState((s) => ({ remoteTreeCache: { ...s.remoteTreeCache, [remoteCacheKey]: sortedNodes } }));
      }
      return;
    }

    const nodes = await window.api.file.list(tabId, project.cwd);
    const sortedNodes = sortFileNodes(nodes as FileNode[]);
    useTreeStore.getState().setTree(sortedNodes);
    set((s) => ({
      projectTrees: { ...s.projectTrees, [project.key]: sortedNodes },
      projectLoading: { ...s.projectLoading, [project.key]: false },
    }));
    useTreeStore.setState((s) => ({ remoteTreeCache: { ...s.remoteTreeCache, [remoteCacheKey]: sortedNodes } }));
    set({ remoteHydration: { phase: "idle" } });
  },

  deleteProject: async (project) => {
    if (!confirm(`删除项目 ${project.label}？\n这不会删除实际文件夹。`)) return;
    const ok = await window.api.project.delete(project.key);
    if (!ok) {
      alert("删除项目失败");
      return;
    }
    set((s) => {
      const next = new Set(s.expandedProjects);
      next.delete(project.key);
      return { expandedProjects: next };
    });
    await get().refreshProjects();
  },

  newProjectSession: async (project) => {
    const tabsState = useTabsStore.getState();
    // WSL projects reuse type "remote" but are identified by port === 0 +
    // host = distro. Create a WSL tab (not SSH) for a new session.
    if (project.type === "remote" && (project.port ?? 22) === 0 && project.host) {
      const id = await window.api.tab.create({
        cwd: tabsState.cwd || ".",
        wsl: { distro: project.host, path: project.cwd },
      });
      const wslTabId = project.tabId || id;
      const wslListResult = await window.api.session.listRemote(wslTabId, project.cwd);
      set((s) => ({
        remoteSessions: { ...s.remoteSessions, [remoteSessionCacheKey(wslTabId, project.cwd)]: wslListResult.sessions as SessionItem[] },
        projectErrors: { ...s.projectErrors, [project.key]: wslListResult.error },
        projectDiagnostics: { ...s.projectDiagnostics, [project.key]: wslListResult.diagnostics },
        projectSessionStatus: { ...s.projectSessionStatus, [project.key]: wslListResult.error ? "error" : wslListResult.sessions.length > 0 ? "ready" : "empty" },
      }));
      return;
    }
    if (project.type === "remote") {
      let remoteInfo = project.tabId ? await window.api.remote.getInfo(project.tabId) : null;
      if (!remoteInfo && project.host && project.user) {
        remoteInfo = {
          host: project.host,
          user: project.user,
          port: project.port,
          path: project.cwd,
          password: project.password,
        };
      }
      if (!remoteInfo) return;
      const id = await window.api.tab.create({
        cwd: tabsState.cwd || ".",
        remote: {
          host: remoteInfo.host,
          user: remoteInfo.user,
          port: remoteInfo.port,
          path: project.cwd,
          password: remoteInfo.password,
        },
      });
      const remoteTabId = project.tabId || id;
      const remoteListResult = await window.api.session.listRemote(remoteTabId, project.cwd);
      set((s) => ({
        remoteSessions: { ...s.remoteSessions, [remoteSessionCacheKey(remoteTabId, project.cwd)]: remoteListResult.sessions as SessionItem[] },
        projectErrors: { ...s.projectErrors, [project.key]: remoteListResult.error },
        projectDiagnostics: { ...s.projectDiagnostics, [project.key]: remoteListResult.diagnostics },
        projectSessionStatus: { ...s.projectSessionStatus, [project.key]: remoteListResult.error ? "error" : remoteListResult.sessions.length > 0 ? "ready" : "empty" },
      }));
      return;
    }
    await window.api.tab.create({ cwd: project.cwd });
  },

  addLocalProject: async (dir) => {
    const project = await window.api.project.addLocal(dir);
    get().upsertProject(project);
    await get().refreshProjects();
  },
  addRemoteProject: async (remote) => {
    const project = await window.api.project.addRemote(remote);
    get().upsertProject(project);
    await get().refreshProjects();
  },
  addWslProject: async (distro, path) => {
    const project = await window.api.project.addWsl(distro, path);
    get().upsertProject(project);
    await get().refreshProjects();
  },
}));

export type { AutoFollowSettings };
