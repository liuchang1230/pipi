/**
 * in-flight.ts — "what is the main process waiting on right now?"
 *
 * The app's freeze complaints ("卡顿 / 未响应") are event-loop problems, but the
 * loop itself cannot tell you *why* it was busy: by the time a lag sample is
 * read, the blocking work is usually over (or still pending). Recording every
 * operation that crosses an await boundary gives the lag monitor something to
 * attribute the stall to, and gives the user a sentence instead of a spinner
 * ("应用繁忙：正在列举远程目录").
 *
 * The registry is deliberately tiny and allocation-light: one Map entry per
 * in-flight operation, removed in a `finally`. It must never be able to break
 * the operation it is measuring.
 */

export interface InFlightOp {
  name: string;
  startedAt: number;
}

export interface InFlightOpSnapshot extends InFlightOp {
  elapsedMs: number;
}

const ops = new Map<number, InFlightOp>();
let seq = 0;

/** Register an operation; call the returned function when it settles. */
export function beginOp(name: string): () => void {
  const id = ++seq;
  ops.set(id, { name, startedAt: Date.now() });
  let done = false;
  return () => {
    if (done) return; // idempotent: a double call must not free another op's slot
    done = true;
    ops.delete(id);
  };
}

/** In-flight operations, longest-running first (the likeliest stall cause). */
export function snapshotOps(now = Date.now()): InFlightOpSnapshot[] {
  return [...ops.values()]
    .map((op) => ({ ...op, elapsedMs: Math.max(0, now - op.startedAt) }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs);
}

/** `"sftp:list 3.2s, hydrate 1.1s"` — empty string when nothing is pending. */
export function describeOps(now = Date.now(), limit = 3): string {
  return snapshotOps(now)
    .slice(0, limit)
    .map((op) => `${op.name} ${(op.elapsedMs / 1000).toFixed(1)}s`)
    .join(", ");
}

export function clearOpsForTests(): void {
  ops.clear();
  seq = 0;
}

/**
 * Wrap a listener so its whole execution is attributed in the registry.
 *
 * Used once, around `ipcMain.handle` at startup, instead of sprinkling
 * bookkeeping through ~60 handlers: the channel name is exactly the granularity
 * a user report can be matched against ("I clicked the file tree, then it
 * froze" → `ipc:file:list`). Sync listeners are fine — the wrapper is async,
 * and Electron awaits a returned promise.
 */
export function withOpTracking<A extends unknown[], R>(
  name: string,
  listener: (...args: A) => R,
): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    const end = beginOp(name);
    try {
      return (await listener(...args)) as Awaited<R>;
    } finally {
      end();
    }
  };
}

/** The slice of Electron's `ipcMain` this module needs (injectable for tests). */
export interface IpcRegistrar {
  handle(channel: string, listener: (...args: never[]) => unknown): unknown;
}

/**
 * Patch a registrar so every handler it accepts from NOW ON is tracked.
 *
 * Called once at startup, before the first `ipcMain.handle` (the app registers
 * all of them inside `whenReady`). The original registrar still does the
 * registering, so nothing else about it changes.
 */
export function trackIpcHandlersOn(registrar: IpcRegistrar): void {
  const original = registrar.handle.bind(registrar);
  registrar.handle = (channel: string, listener: (...args: never[]) => unknown): unknown =>
    original(channel, withOpTracking(`ipc:${channel}`, listener) as (...args: never[]) => unknown);
}
