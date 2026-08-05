// Session store: open-session dedup, the shared helpers, and the
// "refresh caches after delete" invariant (the multi-project case is the one
// that used to clobber with a stale snapshot).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore, sessionLabel, remoteSessionCacheKey, buildRemoteKey } from "../sessionsStore";
import { useTabsStore } from "../tabsStore";
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
    },
    project: {
      list: vi.fn(async () => [] as ProjectListItem[]),
    },
    remote: {
      getInfo: vi.fn(async () => null as { host: string; user: string; port?: number; path?: string; password?: string; isWsl?: boolean } | null),
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
  it("creates a pi tab for the session when no tab holds it", async () => {
    await useSessionsStore.getState().openSession(SESSION);
    const api = (globalThis as any).window.api;
    expect(api.tab.create).toHaveBeenCalledWith({
      cwd: "/proj",
      sessionPath: SESSION.path,
      continueRecent: false,
      title: "帮我改个 bug",
    });
  });

  it("activates the existing tab instead of creating a duplicate", async () => {
    useTabsStore.setState({ tabs: [{ id: "t-open", sessionPath: SESSION.path, title: "x" } as any] });
    await useSessionsStore.getState().openSession(SESSION);
    const api = (globalThis as any).window.api;
    expect(api.tab.activate).toHaveBeenCalledWith("t-open");
    expect(api.tab.create).not.toHaveBeenCalled();
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
  it("creates a WSL tab when the source tab is a WSL connection", async () => {
    const api = makeApi();
    api.remote.getInfo.mockResolvedValue({ host: "Ubuntu", user: "", isWsl: true, path: "~" });
    await useSessionsStore.getState().openRemoteSession("t-wsl", "/proj", SESSION);
    expect(api.tab.create).toHaveBeenCalledWith({
      cwd: "/proj",
      sessionPath: SESSION.path,
      title: "帮我改个 bug",
      wsl: { distro: "Ubuntu", path: "/proj" },
    });
  });

  it("creates an SSH tab for a regular remote tab", async () => {
    const api = makeApi();
    api.remote.getInfo.mockResolvedValue({ host: "h", user: "u", port: 22, password: "p", path: "~" });
    await useSessionsStore.getState().openRemoteSession("t-ssh", "/proj", SESSION);
    expect(api.tab.create).toHaveBeenCalledWith(
      expect.objectContaining({ remote: { host: "h", user: "u", port: 22, path: "/proj", password: "p" } }),
    );
  });

  it("dedups against an already-open tab for the session", async () => {
    const api = makeApi();
    useTabsStore.setState({ tabs: [{ id: "t-open", sessionPath: SESSION.path, title: "x" } as any] });
    await useSessionsStore.getState().openRemoteSession("t-any", "/proj", SESSION);
    expect(api.tab.activate).toHaveBeenCalledWith("t-open");
    expect(api.tab.create).not.toHaveBeenCalled();
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
