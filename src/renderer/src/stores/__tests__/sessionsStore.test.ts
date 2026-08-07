// Session store: open-session dedup, the shared helpers, and the
// "refresh caches after delete" invariant (the multi-project case is the one
// that used to clobber with a stale snapshot).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore, sessionLabel, remoteSessionCacheKey, buildRemoteKey } from "../sessionsStore";
import { useTabsStore } from "../tabsStore";
import { useTreeStore } from "../treeStore";
import type { SessionItem, ProjectListItem } from "../types";

const SESSION: SessionItem = {
  path: "/sessions/x.jsonl",
  sessionId: "s1",
  mtime: 1234,
  messageCount: 3,
  firstMessage: "帮我改个 bug",
  name: null,
};

function makeApi(opts: { sessionList?: (cwd?: string) => Promise<SessionItem[]> } = {}) {
  const api = {
    tab: {
      create: vi.fn(async () => "tab-1"),
      close: vi.fn(async () => true),
      activate: vi.fn(async () => true),
    },
    session: {
      delete: vi.fn(async () => ({ ok: true })),
      list: vi.fn(opts.sessionList ?? (async () => [])),
      listRemote: vi.fn(async () => ({ sessions: [] as SessionItem[], error: undefined, diagnostics: undefined })),
      setRemoteHydrationPaused: vi.fn(async () => true),
      prioritizeRemote: vi.fn(async () => true),
    },
    project: {
      list: vi.fn(async () => [] as ProjectListItem[]),
      addLocal: vi.fn(async (cwd: string) => ({ id: `local-${cwd}`, type: "local" as const, name: cwd, cwd })),
      addRemote: vi.fn(async (r: { host: string; user: string }) => ({ id: `remote-${r.host}`, type: "remote" as const, name: r.host, host: r.host, user: r.user })),
      addWsl: vi.fn(async (_d: string, path: string) => ({ id: `wsl-${path}`, type: "wsl" as const, name: path, distro: _d, path })),
      delete: vi.fn(async () => true),
    },
    remote: {
      getInfo: vi.fn(async () => null as { host: string; user: string; port?: number; path?: string; password?: string; isWsl?: boolean } | null),
      setBrowsePath: vi.fn(async () => true),
    },
    file: {
      list: vi.fn(async () => [] as ProjectListItem[]),
    },
  };
  (globalThis as any).window = { api };
  return api;
}

beforeEach(() => {
  makeApi();
  useSessionsStore.setState({
    projects: [],
    sessions: [],
    projectSessions: {},
    remoteSessions: {},
    projectLoading: {},
    projectSessionStatus: {},
    projectErrors: {},
    projectDiagnostics: {},
    projectTrees: {},
    selectedSessions: new Set(),
    remoteHydration: { phase: "idle" },
    expandedProjects: new Set(),
  });
  useTabsStore.setState({ tabs: [], activeTab: null, isRemote: false, cwd: "/proj", remoteDir: null, remoteLabel: "" });
  useTreeStore.setState({ tree: [], expanded: new Set(), fileTreeStatus: "idle", fileTreeError: null, remoteTreeCache: {}, treeOrigin: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("helpers", () => {
  it("sessionLabel prefers the display name, truncated to 40 chars", () => {
    expect(sessionLabel({ ...SESSION, name: "My Session" })).toBe("My Session");
    expect(sessionLabel({ ...SESSION, firstMessage: "a".repeat(50) })).toBe("a".repeat(40));
    expect(sessionLabel({ ...SESSION, name: null, firstMessage: "" })).toBe("正在加载会话信息…");
  });
  it("cache keys and remote keys are stable", () => {
    expect(remoteSessionCacheKey("t1", "/a/b")).toBe("t1:/a/b");
    expect(buildRemoteKey("h", "u", 22)).toBe("u@h:22");
    expect(buildRemoteKey()).toBe("@:22");
  });
});

describe("openSession", () => {
  it("creates and immediately shows a pi tab for the session when no tab holds it", async () => {
    await useSessionsStore.getState().openSession(SESSION);
    const api = (globalThis as any).window.api;
    expect(api.tab.create).toHaveBeenCalledWith({
      cwd: "/proj",
      sessionPath: SESSION.path,
      continueRecent: false,
      title: "帮我改个 bug",
    });
    expect(useTabsStore.getState().activeTab).toBe("tab-1");
    expect(useTabsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: "tab-1", cwd: "/proj", sessionPath: SESSION.path, title: "帮我改个 bug" }),
    ]);
  });

  it("activates and immediately shows the existing tab instead of creating a duplicate", async () => {
    useTabsStore.setState({ tabs: [{ id: "t-open", cwd: "/old", sessionPath: SESSION.path, title: "x", pi: true } as any] });
    await useSessionsStore.getState().openSession(SESSION);
    const api = (globalThis as any).window.api;
    expect(api.tab.activate).toHaveBeenCalledWith("t-open");
    expect(api.tab.create).not.toHaveBeenCalled();
    expect(useTabsStore.getState().activeTab).toBe("t-open");
  });

  it("does not switch when activating an existing tab fails", async () => {
    const api = makeApi();
    api.tab.activate.mockResolvedValue(false);
    useTabsStore.setState({ tabs: [{ id: "stale", cwd: "/old", sessionPath: SESSION.path, title: "x", pi: true } as any], activeTab: "current" });
    await useSessionsStore.getState().openSession(SESSION);
    expect(useTabsStore.getState().activeTab).toBe("current");
  });

  it("dedups concurrent double-clicks on the same session", async () => {
    let resolveCreate!: (value: string) => void;
    const api = makeApi();
    api.tab.create.mockImplementation(() => new Promise<string>((r) => (resolveCreate = r)));
    const p1 = useSessionsStore.getState().openSession(SESSION);
    const p2 = useSessionsStore.getState().openSession(SESSION); // second click while first in flight
    resolveCreate("tab-1");
    await Promise.all([p1, p2]);
    expect(api.tab.create).toHaveBeenCalledTimes(1);
  });

  it("uses the project cwd when opening from a project row", async () => {
    await useSessionsStore.getState().openSession(SESSION, "/other-project");
    const api = (globalThis as any).window.api;
    expect(api.tab.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/other-project" }));
  });
});

describe("openRemoteSession", () => {
  it("creates and immediately shows a WSL tab when the source tab is a WSL connection", async () => {
    const api = makeApi();
    api.remote.getInfo.mockResolvedValue({ host: "Ubuntu", user: "", isWsl: true, path: "~" });
    await useSessionsStore.getState().openRemoteSession("t-wsl", "/proj", SESSION);
    expect(api.tab.create).toHaveBeenCalledWith({
      cwd: "/proj",
      sessionPath: SESSION.path,
      title: "帮我改个 bug",
      wsl: { distro: "Ubuntu", path: "/proj" },
    });
    expect(useTabsStore.getState().activeTab).toBe("tab-1");
    expect(useTabsStore.getState().isRemote).toBe(true);
    expect(useTabsStore.getState().remoteDir).toBe("/proj");
  });

  it("creates an SSH tab for a regular remote tab", async () => {
    const api = makeApi();
    api.remote.getInfo.mockResolvedValue({ host: "h", user: "u", port: 22, password: "p", path: "~" });
    await useSessionsStore.getState().openRemoteSession("t-ssh", "/proj", SESSION);
    expect(api.tab.create).toHaveBeenCalledWith(
      expect.objectContaining({ remote: { host: "h", user: "u", port: 22, path: "/proj", password: "p" } }),
    );
  });

  it("dedups against an already-open tab for the session without clobbering remoteDir", async () => {
    const api = makeApi();
    useTabsStore.setState({
      tabs: [{ id: "t-open", cwd: "D:/app", isRemote: true, sessionPath: SESSION.path, title: "x", pi: true } as any],
      remoteDir: "/remote/project",
    });
    await useSessionsStore.getState().openRemoteSession("t-any", "/proj", SESSION);
    expect(api.tab.activate).toHaveBeenCalledWith("t-open");
    expect(api.tab.create).not.toHaveBeenCalled();
    expect(useTabsStore.getState().activeTab).toBe("t-open");
    expect(useTabsStore.getState().remoteDir).toBe("/remote/project");
  });
});

describe("deleteSession cache refresh", () => {
  it("refreshes BOTH local projects that cached the deleted session (no snapshot clobber)", async () => {
    vi.stubGlobal("confirm", () => true);
    const fresh = [
      { ...SESSION, path: "/sessions/x.jsonl" },
      { ...SESSION, path: "/sessions/other.jsonl", firstMessage: "另一个会话" },
    ];
    const api = makeApi({ sessionList: async (cwd) => (cwd === "/p1" || cwd === "/p2" ? fresh : []) });
    const projects = [
      { id: "p1", type: "local" as const, name: "P1", cwd: "/p1" },
      { id: "p2", type: "local" as const, name: "P2", cwd: "/p2" },
    ];
    useSessionsStore.setState({
      projects,
      sessions: [SESSION],
      projectSessions: {
        p1: [SESSION], // both projects cache the deleted session
        p2: [SESSION],
      },
      projectSessionStatus: { p1: "ready", p2: "ready" },
    });
    await useSessionsStore.getState().deleteSession(SESSION);
    const s = useSessionsStore.getState();
    // Both projects must now show the fresh list (which no longer contains
    // the deleted path) — a stale snapshot would revert p1's update.
    expect(s.projectSessions.p1?.map((x) => x.path)).toEqual(["/sessions/x.jsonl", "/sessions/other.jsonl"]);
    expect(s.projectSessions.p2?.map((x) => x.path)).toEqual(["/sessions/x.jsonl", "/sessions/other.jsonl"]);
    expect(s.projectSessionStatus.p1).toBe("ready");
    expect(s.projectSessionStatus.p2).toBe("ready");
    expect(api.session.delete).toHaveBeenCalledWith(SESSION.path, undefined);
  });
});

describe("selectAllSessions", () => {
  it("selects all, then deselects all when every item is already selected", () => {
    const a = { ...SESSION, path: "/a" };
    const b = { ...SESSION, path: "/b" };
    useSessionsStore.getState().selectAllSessions([a, b]);
    expect(useSessionsStore.getState().selectedSessions).toEqual(new Set(["/a", "/b"]));
    useSessionsStore.getState().selectAllSessions([a, b]);
    expect(useSessionsStore.getState().selectedSessions.size).toBe(0);
    // A fresh item joins the existing selection.
    useSessionsStore.getState().selectAllSessions([b]);
    expect(useSessionsStore.getState().selectedSessions).toEqual(new Set(["/b"]));
  });
});

describe("toggleProject (explorer orchestration)", () => {
  it("expands a local project: lists sessions, previews the tree, switches tab context", async () => {
    const api = makeApi({
      sessionList: async (cwd) => (cwd === "/p1" ? [{ ...SESSION, path: "/sessions/p1.jsonl" }] : []),
    });
    const localProject = { key: "p1", label: "P1", cwd: "/p1", type: "local" as const, sessions: [] };
    await useSessionsStore.getState().toggleProject(localProject);
    const s = useSessionsStore.getState();
    // Session cache populated + status ready.
    expect(s.projectSessions.p1?.map((x) => x.path)).toEqual(["/sessions/p1.jsonl"]);
    expect(s.projectSessionStatus.p1).toBe("ready");
    // Tab context switched to the project dir (local mode).
    const tabs = useTabsStore.getState();
    expect(tabs.cwd).toBe("/p1");
    expect(tabs.isRemote).toBe(false);
    // Tree preview: loadTree with rootPath + isRemote:false → file.list called.
    expect(api.file.list).toHaveBeenCalled();
  });

  it("remote project with cached tree+sessions takes the fast path", async () => {
    const api = makeApi();
    api.remote.getInfo.mockResolvedValue({ host: "h", user: "u", port: 22, password: "p", path: "/r" });
    useSessionsStore.setState({
      expandedProjects: new Set(),
      projectSessions: { rp: [{ ...SESSION, path: "/sessions/r.jsonl" }] },
      projectTrees: { rp: [{ name: "a.ts", path: "a.ts", type: "file" }] },
    });
    const remoteProject = {
      key: "rp", label: "RP", cwd: "/r", type: "remote" as const,
      tabId: "t-conn", host: "h", user: "u", port: 22, password: "p", sessions: [],
    };
    await useSessionsStore.getState().toggleProject(remoteProject);
    expect(api.tab.activate).toHaveBeenCalledWith("t-conn");
    expect(api.session.setRemoteHydrationPaused).toHaveBeenCalledWith("t-conn", "/r", false);
    expect(api.session.prioritizeRemote).toHaveBeenCalledWith("t-conn", "/r", 2);
    // Cached tree shown immediately (no file.list for the fast path).
    expect(api.file.list).not.toHaveBeenCalled();
    expect(useTreeStore.getState().treeOrigin).toEqual({ tabId: "t-conn", dirPath: "/r", isRemote: true });
    const tabs = useTabsStore.getState();
    expect(tabs.isRemote).toBe(true);
    expect(tabs.remoteDir).toBe("/r");
  });

  it("deleteProject removes it from the catalog and collapses it", async () => {
    vi.stubGlobal("confirm", () => true);
    const api = makeApi();
    useSessionsStore.setState({ expandedProjects: new Set(["p1"]) });
    await useSessionsStore.getState().deleteProject({ key: "p1", label: "P1", cwd: "/p1", type: "local" as const, sessions: [] });
    expect(api.project.delete).toHaveBeenCalledWith("p1");
    expect(useSessionsStore.getState().expandedProjects.has("p1")).toBe(false);
  });

  it("deleteProject cancels when the confirm is declined (no deletion)", async () => {
    vi.stubGlobal("confirm", () => false);
    const api = makeApi();
    await useSessionsStore.getState().deleteProject({ key: "p1", label: "P1", cwd: "/p1", type: "local" as const, sessions: [] });
    expect(api.project.delete).not.toHaveBeenCalled();
  });

  it("local project with cached sessions skips the session.list round-trip", async () => {
    const api = makeApi();
    useSessionsStore.setState({ projectSessions: { p1: [{ ...SESSION, path: "/sessions/p1.jsonl" }] } });
    await useSessionsStore.getState().toggleProject({ key: "p1", label: "P1", cwd: "/p1", type: "local" as const, sessions: [] });
    expect(api.session.list).not.toHaveBeenCalled();
  });

  it("WSL project without an open tab auto-connects the distro", async () => {
    const api = makeApi();
    const wslProject = {
      key: "wp", label: "WP", cwd: "/w/proj", type: "remote" as const,
      host: "Ubuntu", user: "", port: 0, sessions: [],
    };
    await useSessionsStore.getState().toggleProject(wslProject);
    expect(api.tab.create).toHaveBeenCalledWith({ cwd: "/proj", wsl: { distro: "Ubuntu", path: "/w/proj" } });
    expect(api.remote.setBrowsePath).toHaveBeenCalledWith("tab-1", "/w/proj");
    expect(useTreeStore.getState().treeOrigin).toEqual({ tabId: "tab-1", dirPath: "/w/proj", isRemote: true });
  });

  it("newProjectSession: local project opens and immediately shows a plain tab", async () => {
    const api = makeApi();
    await useSessionsStore.getState().newProjectSession({ key: "p1", label: "P1", cwd: "/p1", type: "local" as const, sessions: [] });
    expect(api.tab.create).toHaveBeenCalledWith({ cwd: "/p1" });
    expect(useTabsStore.getState().activeTab).toBe("tab-1");
    expect(useTabsStore.getState().cwd).toBe("/p1");
  });

  it("newProjectSession: WSL project creates a WSL tab and refreshes its sessions", async () => {
    const api = makeApi();
    api.session.listRemote.mockResolvedValue({ sessions: [{ ...SESSION, path: "/sessions/w.jsonl" }], error: undefined, diagnostics: undefined });
    await useSessionsStore.getState().newProjectSession({
      key: "wp", label: "WP", cwd: "/w/proj", type: "remote" as const,
      host: "Ubuntu", user: "", port: 0, sessions: [],
    });
    expect(api.tab.create).toHaveBeenCalledWith({ cwd: "/proj", wsl: { distro: "Ubuntu", path: "/w/proj" } });
    expect(api.session.listRemote).toHaveBeenCalledWith("tab-1", "/w/proj");
    expect(useTabsStore.getState().activeTab).toBe("tab-1");
    expect(useTabsStore.getState().remoteDir).toBe("/w/proj");
    expect(useSessionsStore.getState().projectSessionStatus.wp).toBe("ready");
  });
});

describe("project catalog actions", () => {
  it("addLocalProject upserts the project and refreshes the catalog", async () => {
    const api = makeApi();
    api.project.list.mockResolvedValue([{ id: "local-/new", type: "local", name: "/new", cwd: "/new" }]);
    await useSessionsStore.getState().addLocalProject("/new");
    expect(api.project.addLocal).toHaveBeenCalledWith("/new");
    expect(useSessionsStore.getState().projects.some((p) => p.cwd === "/new")).toBe(true);
  });

  it("addRemoteProject stores an SSH project", async () => {
    const api = makeApi();
    api.project.list.mockResolvedValue([{ id: "remote-h", type: "remote", name: "h", host: "h", user: "u" }]);
    await useSessionsStore.getState().addRemoteProject({ host: "h", user: "u", port: 22, path: "/r", password: "p" });
    expect(api.project.addRemote).toHaveBeenCalledWith({ host: "h", user: "u", port: 22, path: "/r", password: "p" });
    expect(useSessionsStore.getState().projects.some((p) => p.type === "remote" && p.host === "h")).toBe(true);
  });

  it("addWslProject stores a WSL project", async () => {
    const api = makeApi();
    api.project.list.mockResolvedValue([{ id: "wsl-Ubuntu", type: "wsl", name: "Ubuntu", distro: "Ubuntu", path: "/w/proj" }]);
    await useSessionsStore.getState().addWslProject("Ubuntu", "/w/proj");
    expect(api.project.addWsl).toHaveBeenCalledWith("Ubuntu", "/w/proj");
    expect(useSessionsStore.getState().projects.some((p) => p.type === "wsl" && p.distro === "Ubuntu")).toBe(true);
  });
});
