/**
 * failureStore — the persistent record of what went wrong.
 *
 * A 3-second toast is the wrong container for a failure: it is gone before the
 * user has read it, it cannot be re-opened, and it carries no advice. This store
 * keeps the last N failures with their code, technical cause, suggested next
 * step and (when the call site can supply it) a retry action, so the UI can
 * offer "what happened / what can I do" instead of silence.
 *
 * Deduplication matters as much as recording: a failing poll loop or a retried
 * action would otherwise bury the first, informative failure under thousands of
 * identical ones. Same code+title+cause inside a window bumps a counter.
 */
import { create } from "zustand";
import { type AppError, type AppErrorTarget, type ErrCode, toAppError } from "../../../shared/outcome";

export interface FailureRecord {
  id: string;
  at: number;
  code: ErrCode;
  title: string;
  cause?: string;
  hint?: string;
  target?: AppErrorTarget;
  /** How many times this same failure happened inside the dedupe window. */
  count: number;
  /** Re-run the action that failed, when the call site knows how. */
  retry?: () => void;
}

/** Oldest records are dropped beyond this; a failure list is a working set. */
export const MAX_FAILURES = 20;
export const FAILURE_DEDUPE_MS = 30_000;

export interface FailureInput {
  error?: unknown;
  /** Overrides the title when the thrown value is not the whole story. */
  title?: string;
  cause?: string;
  target?: AppErrorTarget;
  retry?: () => void;
}

/** Identity for dedupe: same kind of failure, same words. */
export function failureKey(f: Pick<FailureRecord, "code" | "title" | "cause">): string {
  return `${f.code}|${f.title}|${f.cause ?? ""}`;
}

let seq = 0;

interface FailureStore {
  failures: FailureRecord[];
  /** Newest first. Returns the record (also for a dedupe bump). */
  report: (input: FailureInput) => FailureRecord;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

export const useFailureStore = create<FailureStore>()((set, get) => ({
  failures: [],

  report: (input) => {
    const appError: AppError = input.error !== undefined
      ? toAppError(input.error, { title: input.title ?? "操作失败", target: input.target })
      : toAppError(new Error(input.cause ?? ""), { title: input.title ?? "操作失败", target: input.target });
    const candidate: FailureRecord = {
      id: `f${++seq}`,
      at: Date.now(),
      code: appError.code,
      title: input.title ?? appError.title,
      // `toAppError` turns a bare `cause` string into "Error: <cause>" — keep
      // the caller's text verbatim when they provided one.
      cause: input.cause ?? appError.cause,
      hint: appError.hint,
      target: input.target ?? appError.target,
      count: 1,
      retry: input.retry,
    };

    const existing = get().failures.find((f) => failureKey(f) === failureKey(candidate));
    if (existing && Date.now() - existing.at < FAILURE_DEDUPE_MS) {
      const bumped: FailureRecord = { ...existing, at: candidate.at, count: existing.count + 1, retry: candidate.retry ?? existing.retry };
      set((s) => ({ failures: [bumped, ...s.failures.filter((f) => f.id !== existing.id)] }));
      return bumped;
    }

    set((s) => ({ failures: [candidate, ...s.failures].slice(0, MAX_FAILURES) }));
    return candidate;
  },

  dismiss: (id) => set((s) => ({ failures: s.failures.filter((f) => f.id !== id) })),

  clearAll: () => set({ failures: [] }),
}));
