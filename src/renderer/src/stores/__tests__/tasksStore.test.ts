// tasksStore: a loading state that cannot be forgotten and cannot wait forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TASK_POLICY,
  TASK_SWEEP_MS,
  describeTask,
  phaseAt,
  selectVisibleTasks,
  stopTaskTimerForTests,
  timeoutErrorFor,
  useTasksStore,
  type TaskState,
} from "../tasksStore";

function makeState(over: Partial<TaskState> = {}): TaskState {
  return {
    key: "tree:load",
    label: "远程文件加载中…",
    scope: "visible",
    phase: "running",
    startedAt: 1_000,
    stallMs: 10_000,
    failMs: 30_000,
    ...over,
  };
}

beforeEach(() => {
  useTasksStore.setState({ tasks: {} });
});
afterEach(() => {
  stopTaskTimerForTests();
  vi.useRealTimers();
});

describe("phaseAt (the T1/T2 policy)", () => {
  it("stays running before T1", () => {
    expect(phaseAt(makeState(), 1_000 + 9_999)).toBe("running");
  });

  it("becomes stalled at T1 — the UI may now say how long it has been waiting", () => {
    expect(phaseAt(makeState(), 1_000 + 10_000)).toBe("stalled");
  });

  it("becomes a terminal error at T2 (never an eternal spinner)", () => {
    expect(phaseAt(makeState(), 1_000 + 30_000)).toBe("error");
  });

  it("never re-opens a terminal phase", () => {
    expect(phaseAt(makeState({ phase: "done" }), 1_000 + 60_000)).toBe("done");
    expect(phaseAt(makeState({ phase: "error" }), 1_000 + 60_000)).toBe("error");
    expect(phaseAt(makeState({ phase: "idle" }), 1_000 + 60_000)).toBe("idle");
  });
});

describe("describeTask", () => {
  it("renders the label while running", () => {
    expect(describeTask(makeState(), 2_000)).toBe("远程文件加载中…");
  });

  it("states the wait and the reason once stalled", () => {
    const task = makeState({ phase: "stalled", detail: "远程 /data/x 列举无响应" });
    expect(describeTask(task, 1_000 + 12_000)).toBe("远程文件加载中…（已等待 12s · 远程 /data/x 列举无响应）");
  });

  it("renders title + cause for an error", () => {
    const task = makeState({ phase: "error", error: timeoutErrorFor(makeState(), 31_000) });
    expect(describeTask(task, 31_000)).toContain("远程文件加载中…超时");
  });

  it("shows nothing for terminal/idle phases", () => {
    expect(describeTask(makeState({ phase: "done" }), 2_000)).toBeNull();
    expect(describeTask(makeState({ phase: "idle" }), 2_000)).toBeNull();
  });
});

describe("useTasksStore", () => {
  it("is single-flight per key: a second begin is refused while one runs", () => {
    const s = useTasksStore.getState();
    expect(s.begin("tree:load", { label: "a" })).toBe(true);
    expect(s.begin("tree:load", { label: "b" })).toBe(false);
    expect(useTasksStore.getState().tasks["tree:load"]?.label).toBe("a");
  });

  it("allows a new begin after the previous one settled", () => {
    const s = useTasksStore.getState();
    s.begin("tree:load", { label: "a" });
    s.settle("tree:load");
    expect(useTasksStore.getState().tasks["tree:load"]?.phase).toBe("done");
    expect(useTasksStore.getState().begin("tree:load", { label: "b" })).toBe(true);
    expect(useTasksStore.getState().tasks["tree:load"]?.label).toBe("b");
  });

  it("turns a failure into a terminal error carrying advice", () => {
    useTasksStore.getState().begin("tree:load", { label: "远程文件加载中…" });
    useTasksStore.getState().settle("tree:load", { error: new Error("connect ETIMEDOUT") });
    const task = useTasksStore.getState().tasks["tree:load"]!;
    expect(task.phase).toBe("error");
    expect(task.error?.code).toBe("timeout");
    expect(task.error?.hint).toBeTruthy();
  });

  it("escalates a never-settling task to stalled and then to error, without help", () => {
    vi.useFakeTimers();
    // Phase changes are quantized to the sweep timer: boundaries sit at half a
    // sweep and 1.5 sweeps, so the ticks at 1× and 2× land in each stage.
    useTasksStore.getState().begin("viewer:open", {
      label: "读取中…",
      policy: { stallMs: TASK_SWEEP_MS * 0.5, failMs: TASK_SWEEP_MS * 1.5 },
    });
    expect(useTasksStore.getState().tasks["viewer:open"]?.phase).toBe("running");

    vi.advanceTimersByTime(TASK_SWEEP_MS);
    expect(useTasksStore.getState().tasks["viewer:open"]?.phase).toBe("stalled");

    vi.advanceTimersByTime(TASK_SWEEP_MS);
    const task = useTasksStore.getState().tasks["viewer:open"]!;
    expect(task.phase).toBe("error");
    expect(task.error?.code).toBe("timeout");
  });

  it("accepts a late answer after T2 instead of leaving a stale error", () => {
    vi.useFakeTimers();
    useTasksStore.getState().begin("viewer:open", {
      label: "读取中…",
      policy: { stallMs: TASK_SWEEP_MS * 0.5, failMs: TASK_SWEEP_MS * 1.5 },
    });
    vi.advanceTimersByTime(TASK_SWEEP_MS * 2);
    expect(useTasksStore.getState().tasks["viewer:open"]?.phase).toBe("error");

    useTasksStore.getState().settle("viewer:open");
    expect(useTasksStore.getState().tasks["viewer:open"]?.phase).toBe("done");
  });

  it("lets a newer request take over the task with restart (opening another file)", () => {
    const s = useTasksStore.getState();
    s.begin("viewer:open", { label: "读取中…", restart: true });
    const firstStartedAt = useTasksStore.getState().tasks["viewer:open"]!.startedAt;
    // Without restart this second begin would be refused (single-flight).
    expect(useTasksStore.getState().begin("viewer:open", { label: "读取中…", restart: true })).toBe(true);
    expect(useTasksStore.getState().tasks["viewer:open"]!.startedAt).toBeGreaterThanOrEqual(firstStartedAt);
    expect(useTasksStore.getState().tasks["viewer:open"]!.phase).toBe("running");
  });

  it("keeps a retry handler across attempts", () => {
    const retry = vi.fn();
    useTasksStore.getState().begin("tree:load", { label: "a", retry });
    useTasksStore.getState().settle("tree:load", { error: new Error("boom") });
    useTasksStore.getState().begin("tree:load", { label: "a" });
    expect(useTasksStore.getState().tasks["tree:load"]?.retry).toBe(retry);
  });

  it("clears tasks for closed tabs", () => {
    useTasksStore.getState().begin("sessions:t1", { label: "a" });
    useTasksStore.getState().begin("sessions:t2", { label: "b" });
    useTasksStore.getState().clearWhere((t) => t.key.endsWith("t1"));
    expect(Object.keys(useTasksStore.getState().tasks)).toEqual(["sessions:t2"]);
  });
});

describe("selectVisibleTasks", () => {
  it("excludes background polling so a routine loop cannot light up the badge", () => {
    useTasksStore.getState().begin("tree:load", { label: "远程文件", scope: "visible" });
    useTasksStore.getState().begin("tree:poll", { label: "轮询", scope: "background" });
    const visible = selectVisibleTasks(useTasksStore.getState());
    expect(visible.map((t) => t.key)).toEqual(["tree:load"]);
  });

  it("uses the documented default policy", () => {
    expect(DEFAULT_TASK_POLICY).toEqual({ stallMs: 10_000, failMs: 30_000 });
  });
});
