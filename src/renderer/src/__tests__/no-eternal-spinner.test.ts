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
import { stopTaskTimerForTests, useTasksStore } from "../stores/tasksStore";
import { useTabsStore } from "../stores/tabsStore";
import { useTreeStore } from "../stores/treeStore";
import { useViewerStore, VIEWER_TASK } from "../stores/viewerStore";
import {
  HISTORY_TASK_LABEL,
  HISTORY_TASK_POLICY,
  HISTORY_TASK_STALL_MS,
  deriveTranscriptWait,
  historyTaskKey,
  type TranscriptWaitInput,
} from "../panes/chat-transcript-wait";

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
  stopTaskTimerForTests();
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

  it("chat transcript: a download that never lands becomes a visible failure with a retry", async () => {
    // The wait the chat view registers while it reads a session's transcript
    // (file-first over SFTP/SSH — 17–45s measured on a slow link, and the reason
    // 「正在启动 Pi…」 used to vanish onto a blank area). Off-link or wedged, it
    // must NOT become 「正在读取会话历史…」 forever: T1 says how long it has been,
    // and the terminal phase is a failure the user can act on.
    const key = historyTaskKey("t1");
    const retry = vi.fn();
    useTasksStore.getState().begin(key, { label: HISTORY_TASK_LABEL, policy: HISTORY_TASK_POLICY, retry });
    const waitInput = (): TranscriptWaitInput => {
      const task = useTasksStore.getState().tasks[key]!;
      return {
        booted: true, // pi answered state_ready long before the transcript arrived
        bootTimedOut: false,
        exited: false,
        messageCount: 0,
        historyLoaded: false,
        historyPhase: task.phase,
        historyStartedAt: task.startedAt,
        historyError: task.error,
      };
    };

    await vi.advanceTimersByTimeAsync(HISTORY_TASK_STALL_MS + 1_000);
    const stalled = deriveTranscriptWait(waitInput());
    expect(stalled.kind).toBe("history");
    expect(stalled.kind === "history" && stalled.text).toMatch(/已等待 \d+s/);
    expect(stalled.kind === "history" && stalled.retry).toBe(true);

    await vi.advanceTimersByTimeAsync(HISTORY_TASK_POLICY.failMs);
    expect(useTasksStore.getState().tasks[key]!.phase).toBe("error");
    const failed = deriveTranscriptWait(waitInput());
    expect(failed.kind).toBe("history-failed");
    expect(failed.kind === "history-failed" && failed.retry).toBe(true);
    expect(useTasksStore.getState().tasks[key]!.retry).toBeTypeOf("function");
  });
});
