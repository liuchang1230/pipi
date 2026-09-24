// THE regression net for this whole effort: no user-visible wait may be
// endless, and every "loading" state must reach a terminal one.
//
// Each case drives a real store action with a fake api whose promise NEVER
// settles — the exact shape of a wedged SFTP connection, the bug class that
// produced "一直加载中 / 点了没反应". `try/finally` cannot pass these: a promise
// that never settles never runs its finally. Only a deadline can.
//
// If you add a new user-visible wait, add a case here. If your case cannot be
// made to pass, the wait is unbounded and that is the bug.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "../stores/sessionsStore";
import { useTasksStore } from "../stores/tasksStore";
import { useTabsStore } from "../stores/tabsStore";
import { useTreeStore } from "../stores/treeStore";
import { useViewerStore, VIEWER_TASK } from "../stores/viewerStore";

/** A promise that never settles — the only honest way to model a hang. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function makeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    tab: { create: vi.fn(async () => "t1"), close: vi.fn(async () => true), activate: vi.fn(async () => true) },
    session: {
      list: vi.fn(async () => []),
      listRemote: vi.fn(async () => ({ sessions: [], error: undefined, diagnostics: undefined })),
      setRemoteHydrationPaused: vi.fn(async () => true),
      prioritizeRemote: vi.fn(async () => true),
    },
    file: { list: vi.fn(async () => []), listDirChildren: vi.fn(async () => []), read: vi.fn(async () => ({ content: "", bytes: 0, isBinary: false })) },
    remote: { getInfo: vi.fn(async () => null), setBrowsePath: vi.fn(async () => true) },
    ...overrides,
  };
  (globalThis as { window?: unknown }).window = { api };
  return api;
}

beforeEach(() => {
  useTasksStore.setState({ tasks: {} });
  useSessionsStore.setState({ projectSessions: {}, projectTrees: {}, projectSessionStatus: {}, projectLoading: {}, projectErrors: {}, remoteHydration: { phase: "idle" }, expandedProjects: new Set() });
  useTreeStore.setState({ tree: [], expanded: new Set(), fileTreeStatus: "idle", fileTreeError: null, remoteTreeCache: {}, treeOrigin: null });
  useTabsStore.setState({ activeTab: "t1", isRemote: true, cwd: "/r", remoteDir: "/r", remoteLabel: "h" });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("no user-visible wait can be endless", () => {
  it("viewer: opening a file on a hung read ends in a terminal task error", async () => {
    makeApi({ file: { list: async () => [], listDirChildren: async () => [], read: () => never() } });

    void useViewerStore.getState().openFile("src/a.ts", false);
    await vi.advanceTimersByTimeAsync(500); // let the task register
    expect(useTasksStore.getState().tasks[VIEWER_TASK]?.phase).toBe("running");

    // T2 (30s default) — past it the UI must be able to say "failed" + retry.
    await vi.advanceTimersByTimeAsync(31_000);
    const task = useTasksStore.getState().tasks[VIEWER_TASK]!;
    expect(task.phase).toBe("error");
    expect(task.error?.code).toBe("timeout");
    expect(task.retry).toBeTypeOf("function");
  });

  it("tree: listing a hung remote directory lands in an error state with a reason", async () => {
    makeApi({ file: { list: vi.fn(() => never()), listDirChildren: vi.fn(() => never()), read: vi.fn(async () => ({ content: "", bytes: 0, isBinary: false })) } });

    // The remote shape is the one that can hang (SFTP); a local listing error is
    // reported differently by design.
    void useTreeStore.getState().loadTree("/r", "t1", undefined, {
      isRemote: true,
      remote: { host: "h", user: "u", port: 22 },
      force: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(useTreeStore.getState().fileTreeStatus).toBe("loading");

    await vi.advanceTimersByTimeAsync(31_000);
    const st = useTreeStore.getState();
    expect(st.fileTreeStatus).toBe("error");
    expect(st.fileTreeError).toMatch(/未响应/);
  });

  it("sessions: expanding a project on hung remote reads ends in error, not '加载中'", async () => {
    makeApi({
      file: { list: vi.fn(() => never()), listDirChildren: vi.fn(() => never()), read: vi.fn(async () => ({ content: "", bytes: 0, isBinary: false })) },
      session: {
        list: vi.fn(async () => []),
        listRemote: vi.fn(() => never()),
        setRemoteHydrationPaused: async () => true,
        prioritizeRemote: async () => true,
      },
    });
    // WSL-shaped project: it goes straight through the shared remote branch that
    // sets projectLoading + remoteHydration before the (hung) SFTP reads.
    const project = { key: "wp", label: "WP", cwd: "/w/proj", type: "remote" as const, host: "Ubuntu", user: "", port: 0, sessions: [] };

    void useSessionsStore.getState().toggleProject(project);
    await vi.advanceTimersByTimeAsync(500);
    expect(useSessionsStore.getState().projectLoading.wp).toBe(true);

    await vi.advanceTimersByTimeAsync(31_000);
    const st = useSessionsStore.getState();
    expect(st.projectLoading.wp).toBe(false);
    expect(st.projectSessionStatus.wp).toBe("error");
    expect(st.remoteHydration.phase).toBe("idle");
    expect(st.projectErrors.wp).toMatch(/未响应/);
  });

  it("a hung action resolves rather than trapping the caller forever", async () => {
    // The whole point: the awaiting code must CONTINUE (so it can render an
    // error), not sit in a pending await for the rest of the session.
    const api = makeApi({ file: { list: vi.fn(() => never()), listDirChildren: vi.fn(() => never()), read: vi.fn(() => never()) } });
    let finished = false;
    void useTreeStore
      .getState()
      .loadTree("/r", "t1", undefined, { isRemote: true, remote: { host: "h", user: "u", port: 22 }, force: true })
      .then(() => {
        finished = true;
      });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(finished).toBe(true);
    expect(api.file.list).toHaveBeenCalled();
  });
});
