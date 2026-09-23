/**
 * with-deadline — a caller-side bound for the "plain" IPC channels.
 *
 * `rpcRequest` has always carried its own timeout, but every other channel
 * (`file:*`, `session:*`, `diff:*`, `model:*Remote`) can wait forever: main
 * only bounds the SFTP *connect* (`readyTimeout`), never an operation on an
 * already-established connection. When such a connection goes silent (NAT
 * drop, roaming laptop, wedged server) `client.list`/`client.get` simply
 * never settles, and the renderer spins on "加载中…" indefinitely.
 *
 * A `try/finally` does NOT help — `finally` only runs once the promise
 * settles. The caller needs its own deadline.
 *
 * Phase 2 replaces these call sites with the task registry (`tasksStore`),
 * which owns the two-stage deadline (visible stall → terminal error) in one
 * place. This helper is deliberately tiny so that migration is mechanical.
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
