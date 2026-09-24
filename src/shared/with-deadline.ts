/**
 * with-deadline — a caller-side bound for any promise that may never settle.
 *
 * The failures this exists for are the ones `try/finally` cannot fix: an
 * operation on an already-established connection (SFTP, SSH exec, a plain IPC
 * channel) can simply never settle when the peer goes silent — NAT drop,
 * roaming laptop, wedged server. `finally` only runs once the promise settles,
 * so a spinner driven by that promise stays up forever.
 *
 * Shared by main (SFTP ops via op-guard) and renderer (plain IPC channels),
 * because "give up after N ms and report" must behave identically on both sides.
 */
export class DeadlineError extends Error {
  constructor(
    label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} 超过 ${Math.round(timeoutMs / 1000)}s 未响应`);
    this.name = "DeadlineError";
  }
}

/** Resolve/reject with `promise`, but give up after `ms` with a DeadlineError. */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A promise that never settles still costs the caller its deadline timer; this
 * says whether a rejection came from US giving up rather than from the work
 * failing — the difference between "slow/unreachable" and "it said no".
 */
export function isDeadlineError(error: unknown): error is DeadlineError {
  return error instanceof DeadlineError || (error instanceof Error && error.name === "DeadlineError");
}
