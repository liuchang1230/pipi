// Project + session sidebar state: the project catalog, per-project session
// lists, hydration progress, batch selection. Setters accept either a direct
// value or an updater function (mirroring React's Dispatch<SetStateAction>).
// Session lifecycle (open/delete/batch) is owned here as store actions — the
// sidebar calls one action instead of threading a 9-item handler object; the
// "refresh caches after delete" invariant lives next to the delete itself.
import { create } from "zustand";
import { useTabsStore } from "./tabsStore";
import type {
  AutoFollowSettings,
  ProjectListItem,
  ProjectSessionStatus,
  RemoteFileDiagnostics,
  RemoteHistoryItem,
  RemoteHydrationState,
  SessionItem,
} from "./types";

type Updater<T> = T | ((prev: T) => T);

function apply<T>(prev: T, value: Updater<T>): T {
  return typeof value === "function" ? (value as (p: T) => T)(prev) : value;
}

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
}));

export type { AutoFollowSettings };
