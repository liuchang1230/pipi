/**
 * op-guard.ts — the ONE place where an operation against the outside world is
 * bounded.
 *
 * The rule this enforces (docs/robustness-plan.md §S2): every operation that
 * touches a peer (SFTP, SSH, WSL, an unconvertible sync read) has a deadline,
 * and an operation that HOLDS A RESOURCE must also release or poison it when
 * that deadline fires. Bounding only the caller is not enough —
 * `ssh2-sftp-client` has no per-operation cancellation, so a `client.list` on a
 * wedged connection that keeps awaiting forever also keeps the lease's
 * refCount above zero, and the idle-TTL cleanup refuses to reclaim it. The
 * result would be "the user gets an error, then every later call also times
 * out, and the pool slowly fills with dead connections".
 *
 * The guard also registers the operation in the in-flight registry, which is
 * what lets a lag report name a culprit instead of printing a number.
 */
import { beginOp } from "./in-flight";
import { type AppError, type AppErrorTarget, type Outcome, makeError, toAppError } from "../shared/outcome";
import { DeadlineError, isDeadlineError, withDeadline } from "../shared/with-deadline";

export interface OpTimeoutInfo {
  name: string;
  deadlineMs: number;
  elapsedMs: number;
  target?: AppErrorTarget;
}

export interface OpGuardOptions {
  /** Hard bound. Must come from a measured worst case, not a guess. */
  deadlineMs: number;
  /** What the operation acts on (server/path/tab) — carried into the AppError. */
  target?: AppErrorTarget;
  /** Fired exactly once when the deadline is hit. Required for ops that hold a
   *  resource: destroy/poison it here so a retry starts clean. */
  onTimeout?: (info: OpTimeoutInfo) => void | Promise<void>;
  /** Title for the timeout AppError; defaults to "<name> 超时". */
  timeoutTitle?: string;
  /** Title for a non-timeout AppError; defaults to "<name> 失败". */
  failureTitle?: string;
}

/** A failure with a structured AppError attached, still throwable. */
export class OpGuardError extends Error {
  constructor(
    readonly appError: AppError,
    options?: { cause?: unknown },
  ) {
    super(appError.cause, options);
    this.name = "OpGuardError";
  }
}

export function isOpGuardError(error: unknown): error is OpGuardError {
  return error instanceof OpGuardError;
}

export interface OpProgress {
  elapsed(): number;
}

/**
 * Run `fn` under a deadline. Throws `OpGuardError` (whose `appError` carries
 * code/title/cause/hint) — the throwing form exists so call sites that already
 * handle Errors keep their `catch` shape.
 */
export async function withOpGuard<T>(
  name: string,
  opts: OpGuardOptions,
  fn: (progress: OpProgress) => Promise<T>,
): Promise<T> {
  const endOp = beginOp(name);
  const startedAt = Date.now();
  try {
    return await withDeadline(fn({ elapsed: () => Date.now() - startedAt }), opts.deadlineMs, name);
  } catch (error) {
    if (isDeadlineError(error) || error instanceof DeadlineError) {
      const info: OpTimeoutInfo = {
        name,
        deadlineMs: opts.deadlineMs,
        elapsedMs: Date.now() - startedAt,
        target: opts.target,
      };
      if (opts.onTimeout) {
        // Cleanup must never mask the timeout it is reacting to.
        try {
          await opts.onTimeout(info);
        } catch {
          /* poisoning failed; the caller still learns the op timed out */
        }
      }
      throw new OpGuardError(
        makeError("timeout", opts.timeoutTitle ?? `${name} 超时`, error.message, { target: opts.target, hint: undefined }),
        { cause: error },
      );
    }
    if (isOpGuardError(error)) throw error;
    // Deliberately NOT re-wrapped: the app already classifies peer errors by
    // inspecting the original object (`isSftpMissingPathError` reads the SFTP
    // status code, `isSshAuthError` reads the message). Re-wrapping would
    // silently break those—e.g. "missing directory = empty session list" would
    // turn into a hard error. Callers that want the taxonomy use `runGuarded`.
    throw error;
  } finally {
    endOp();
  }
}

/** Outcome form for new call sites (never throws). */
export async function runGuarded<T>(name: string, opts: OpGuardOptions, fn: (progress: OpProgress) => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await withOpGuard(name, opts, fn) };
  } catch (error) {
    if (isOpGuardError(error)) return { ok: false, error: error.appError };
    return { ok: false, error: toAppError(error, { title: opts.failureTitle ?? `${name} 失败`, target: opts.target }) };
  }
}