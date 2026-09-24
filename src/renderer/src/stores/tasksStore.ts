/**
 * tasksStore — the single owner of "something is being awaited".
 *
 * Before this, seven hand-written loading flags lived in four stores
 * (`fileTreeStatus`, `fileLoading`, `projectLoading`, `remoteHydration`,
 * `booted`, `historyLoaded`, `mentionsLoading`). "Set ⇒ eventually reset" was
 * a rule each call site had to remember, and a promise that never settles
 * (the whole B-class of bugs) left the user staring at 加载中… with no way to
 * retry, cancel, or even tell what is being waited on.
 *
 * Two things make it structural here:
 *
 * 1. **A deadline is part of the task.** At `stallMs` the task becomes
 *    `stalled` — still waiting, but the UI may now say so and offer a retry —
 *    and at `failMs` it becomes a terminal `error`. A task cannot sit in
 *    `running` forever.
 * 2. **Derived, not hand-set.** Panes render from the task's phase, so
 *    "loading" and "the flag got cleared" cannot drift apart.
 *
 * Scope: `background` tasks (poll loops) are excluded from the global count and
 * never escalate — otherwise routine polling would keep an "N 个任务进行中"
 * badge lit forever and users would learn to ignore the indicator.
 */
import { create } from "zustand";
import type { AppError } from "../../../shared/outcome";
import { toAppError } from "../../../shared/outcome";

export type TaskPhase = "idle" | "running" | "stalled" | "error" | "done";

export interface TaskState {
  key: string;
  /** What is being awaited, in user words ("远程文件加载中…"). */
  label: string;
  scope: "visible" | "background";
  phase: TaskPhase;
  startedAt: number;
  /** T1: when the waiting becomes worth mentioning. */
  stallMs: number;
  /** T2: when we stop claiming to be loading and report a failure. */
  failMs: number;
  /** Why it is slow (a failure cause, or what we know about the operation). */
  detail?: string;
  error?: AppError;
  /** What "再试一次" means for this task. */
  retry?: () => void;
}

export interface TaskPolicy {
  stallMs: number;
  failMs: number;
}

/** T1 = long enough that normal work never flickers; T2 = well past any
 *  plausible round trip, so reaching it means something is actually wrong. */
export const DEFAULT_TASK_POLICY: TaskPolicy = { stallMs: 10_000, failMs: 30_000 };

/**
 * One sweep timer for ALL tasks, not one timer per task: the phase boundaries
 * only need to be accurate to half a second, and a task list can be long.
 * Consequence for tests: advances must be a multiple of this.
 */
export const TASK_SWEEP_MS = 500;

/** Pure: which phase does this task have `now`? Terminal phases never change. */
export function phaseAt(task: Pick<TaskState, "phase" | "startedAt" | "stallMs" | "failMs">, now: number): TaskPhase {
  if (task.phase === "error" || task.phase === "done" || task.phase === "idle") return task.phase;
  const elapsed = now - task.startedAt;
  if (elapsed >= task.failMs) return "error";
  if (elapsed >= task.stallMs) return "stalled";
  return "running";
}

/** One user-facing sentence for a task; `null` when there is nothing to show. */
export function describeTask(task: TaskState, now = Date.now()): string | null {
  const elapsed = Math.max(0, Math.round((now - task.startedAt) / 1000));
  switch (task.phase) {
    case "idle":
    case "done":
      return null;
    case "running":
      return task.label;
    case "stalled":
      return `${task.label}（已等待 ${elapsed}s${task.detail ? ` · ${task.detail}` : ""}）`;
    case "error":
      return task.error ? `${task.error.title}：${task.error.cause}` : `${task.label}失败`;
  }
}

/** Promoting a task to `error` at T2 needs an AppError with the right advice. */
export function timeoutErrorFor(task: TaskState, now = Date.now()): AppError {
  const seconds = Math.round((now - task.startedAt) / 1000);
  return toAppError(new Error(`${task.label}已等待 ${seconds}s 仍未响应`), { title: `${task.label}超时` });
}

interface TasksStore {
  tasks: Record<string, TaskState>;
  /** Start (or refresh) a task. Returns false when the same key is already
   *  running — the caller uses that as a single-flight guard. */
  begin: (
    key: string,
    opts: {
      label: string;
      scope?: "visible" | "background";
      policy?: Partial<TaskPolicy>;
      retry?: () => void;
      /** The caller's new request SUPERSEDES the running one (opening another
       *  file): reset the timer instead of being refused by single-flight. */
      restart?: boolean;
    },
  ) => boolean;
  settle: (key: string, result?: { error?: unknown; detail?: string }) => void;
  /** Forget a task entirely (pane unmount / tab closed). */
  clear: (key: string) => void;
  clearWhere: (predicate: (task: TaskState) => boolean) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

function stopTimerIfIdle(get: () => TasksStore): void {
  const active = Object.values(get().tasks).some((t) => t.phase === "running" || t.phase === "stalled");
  if (!active && timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const useTasksStore = create<TasksStore>()((set, get) => ({
  tasks: {},

  begin: (key, opts) => {
    const existing = get().tasks[key];
    if (existing && (existing.phase === "running" || existing.phase === "stalled") && !opts.restart) return false;
    const policy = { ...DEFAULT_TASK_POLICY, ...opts.policy };
    set((s) => ({
      tasks: {
        ...s.tasks,
        [key]: {
          key,
          label: opts.label,
          scope: opts.scope ?? "visible",
          phase: "running",
          startedAt: Date.now(),
          stallMs: policy.stallMs,
          failMs: policy.failMs,
          retry: opts.retry ?? existing?.retry,
        },
      },
    }));
    if (!timer) {
      timer = setInterval(() => {
        const now = Date.now();
        const tasks = get().tasks;
        let changed = false;
        const next: Record<string, TaskState> = {};
        for (const [k, task] of Object.entries(tasks)) {
          const phase = phaseAt(task, now);
          if (phase === task.phase) {
            next[k] = task;
            continue;
          }
          changed = true;
          next[k] = phase === "error" ? { ...task, phase, error: task.error ?? timeoutErrorFor(task, now) } : { ...task, phase };
        }
        if (changed) set({ tasks: next });
        stopTimerIfIdle(get);
      }, TASK_SWEEP_MS);
    }
    return true;
  },

  settle: (key, result) => {
    set((s) => {
      const task = s.tasks[key];
      if (!task) return s;
      // A late answer after T2 is GOOD news (the data did arrive): accept it
      // rather than leaving a stale error on screen. `idle`/`done` are final.
      if (task.phase === "idle" || task.phase === "done") return s;
      const error = result?.error;
      return {
        tasks: {
          ...s.tasks,
          [key]: error
            ? { ...task, phase: "error", error: toAppError(error, { title: `${task.label}失败` }), detail: result?.detail }
            : { ...task, phase: "done", error: undefined, detail: result?.detail },
        },
      };
    });
    stopTimerIfIdle(get);
  },

  clear: (key) => {
    set((s) => {
      if (!(key in s.tasks)) return s;
      const tasks = { ...s.tasks };
      delete tasks[key];
      return { tasks };
    });
    stopTimerIfIdle(get);
  },

  clearWhere: (predicate) => {
    set((s) => {
      const tasks: Record<string, TaskState> = {};
      let dropped = false;
      for (const [k, t] of Object.entries(s.tasks)) {
        if (predicate(t)) dropped = true;
        else tasks[k] = t;
      }
      return dropped ? { tasks } : s;
    });
    stopTimerIfIdle(get);
  },
}));

/** Subscribe to one task's phase (panes use this instead of a loading flag). */
export function useTask(key: string): TaskState | undefined {
  return useTasksStore((s) => s.tasks[key]);
}

/** Visible tasks for the global "N 个任务进行中" indicator. */
export function selectVisibleTasks(state: TasksStore): TaskState[] {
  return Object.values(state.tasks).filter(
    (t) => t.scope === "visible" && (t.phase === "running" || t.phase === "stalled" || t.phase === "error"),
  );
}

/** Reset the module-level timer between tests. */
export function stopTaskTimerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
