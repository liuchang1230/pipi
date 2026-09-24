/**
 * perf.ts — event-loop lag, measured and attributed.
 *
 * Every "卡顿" report in this project so far had to be reconstructed after the
 * fact from a video or a log's timestamps. `monitorEventLoopDelay` turns it into
 * a number: the main process serves every IPC call, the terminal streams and
 * all scheduling, so its event-loop delay IS the app's responsiveness.
 *
 * Honest limitation: a SYNCHRONOUS freeze (a blocking spawnSync) stops the loop
 * that measures it, so the sample is only read once the loop breathes again.
 * That makes this monitor (a) a post-hoc record for sync freezes and (b) a live
 * signal for async slow work (SFTP, hydration) — where the in-flight registry
 * can name what the user is waiting on.
 *
 * The busy decision is hysteretic: entering needs `consecutive` bad samples and
 * a high p95, leaving needs a clearly good p95. Anything twitchy here would
 * become banner noise, and a noisy warning is one users learn to ignore.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { describeOps, type InFlightOpSnapshot, snapshotOps } from "./in-flight";

export interface LagSample {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface BusyState {
  busy: boolean;
  badStreak: number;
  goodStreak: number;
}

export interface BusyPolicy {
  /** p95 at/above which a sample counts as bad. */
  enterMs: number;
  /** p95 at/below which a sample counts as good (hysteresis gap). */
  exitMs: number;
  /** Consecutive bad samples required before declaring "busy". */
  consecutive: number;
}

export const DEFAULT_BUSY_POLICY: BusyPolicy = { enterMs: 250, exitMs: 150, consecutive: 2 };

export interface LagReport {
  sample: LagSample;
  busy: boolean;
  ops: InFlightOpSnapshot[];
  opsText: string;
  at: number;
}

/** Nanoseconds → whole milliseconds, tolerating an empty histogram (NaN). */
export function msFromNs(ns: number): number {
  return Number.isFinite(ns) ? Math.round(ns / 1e6) : 0;
}

/**
 * Read (and reset) the histogram. Percentiles are read from the SAME window as
 * the mean/max, so one tick describes one interval rather than the process's
 * whole history.
 */
export function sampleFromHistogram(h: Pick<IntervalHistogram, "mean" | "max" | "percentile" | "reset">): LagSample {
  const sample: LagSample = {
    p50Ms: msFromNs(h.percentile(50)),
    p95Ms: msFromNs(h.percentile(95)),
    maxMs: msFromNs(h.max),
    meanMs: msFromNs(h.mean),
  };
  h.reset();
  return sample;
}

/** Pure hysteresis state machine. `changed` marks the busy↔idle transitions. */
export function nextBusyState(state: BusyState, p95Ms: number, policy: BusyPolicy = DEFAULT_BUSY_POLICY): BusyState & { changed: boolean } {
  if (state.busy) {
    const goodStreak = p95Ms <= policy.exitMs ? state.goodStreak + 1 : 0;
    const busy = goodStreak < policy.consecutive;
    return { busy, badStreak: 0, goodStreak: busy ? goodStreak : 0, changed: !busy };
  }
  const badStreak = p95Ms >= policy.enterMs ? state.badStreak + 1 : 0;
  const busy = badStreak >= policy.consecutive;
  return { busy, badStreak: busy ? 0 : badStreak, goodStreak: 0, changed: busy };
}

export function formatLagLine(sample: LagSample, opsText: string, busy: boolean): string {
  const marker = busy ? "BUSY " : "";
  return `lag ${marker}p50=${sample.p50Ms}ms p95=${sample.p95Ms}ms max=${sample.maxMs}ms${opsText ? ` inflight=[${opsText}]` : ""}`;
}

export interface LagMonitorDeps {
  /** Where samples go. `warn` is used for busy windows so they survive a crash. */
  log: (tag: string, msg: string) => void;
  debug: (tag: string, msg: string) => void;
  /** Fired on every busy↔idle transition only. */
  onBusy?: (report: LagReport | null) => void;
  intervalMs?: number;
  policy?: BusyPolicy;
  /** Test seam: inject a histogram instead of a real one. */
  histogram?: Pick<IntervalHistogram, "mean" | "max" | "percentile" | "reset" | "enable" | "disable">;
}

export interface LagMonitor {
  /** Run one sample now (also the unit-test entry point). */
  tick(now?: number): LagReport;
  stop(): void;
}

export function createLagMonitor(deps: LagMonitorDeps): LagMonitor {
  const intervalMs = deps.intervalMs ?? 10_000;
  const policy = deps.policy ?? DEFAULT_BUSY_POLICY;
  const histogram = deps.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  let state: BusyState = { busy: false, badStreak: 0, goodStreak: 0 };
  let timer: NodeJS.Timeout | null = null;

  const tick = (now = Date.now()): LagReport => {
    const sample = sampleFromHistogram(histogram);
    const next = nextBusyState(state, sample.p95Ms, policy);
    const ops = snapshotOps(now);
    const opsText = describeOps(now);
    const report: LagReport = { sample, busy: next.busy, ops, opsText, at: now };
    const line = formatLagLine(sample, opsText, next.busy);
    if (next.busy) deps.log("perf", line);
    else deps.debug("perf", line);
    if (next.changed) deps.onBusy?.(next.busy ? report : null);
    state = { busy: next.busy, badStreak: next.badStreak, goodStreak: next.goodStreak };
    return report;
  };

  timer = setInterval(() => tick(), intervalMs);
  timer.unref?.();
  try {
    histogram.enable();
  } catch {
    /* already enabled / unavailable — sampling still reports zeros */
  }

  return {
    tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try {
        histogram.disable();
      } catch {
        /* nothing to disable */
      }
    },
  };
}
