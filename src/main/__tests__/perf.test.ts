// perf: the lag monitor turns "卡顿" into a number and a culprit. The policy is
// hysteretic on purpose — a warning that fires on every normal sample is a
// warning users learn to ignore.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOpsForTests, beginOp } from "../in-flight";
import {
  DEFAULT_BUSY_POLICY,
  createLagMonitor,
  formatLagLine,
  msFromNs,
  nextBusyState,
  sampleFromHistogram,
  type BusyState,
  type LagSample,
} from "../perf";

const idle: BusyState = { busy: false, badStreak: 0, goodStreak: 0 };

function fakeHistogram(ns: { p50?: number; p95?: number; max?: number; mean?: number } = {}) {
  return {
    mean: ns.mean ?? 0,
    max: ns.max ?? 0,
    percentile: (p: number) => (p === 50 ? ns.p50 ?? 0 : ns.p95 ?? 0),
    reset: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  };
}

beforeEach(() => clearOpsForTests());

describe("msFromNs", () => {
  it("converts nanoseconds to whole milliseconds", () => {
    expect(msFromNs(2_500_000)).toBe(3);
    expect(msFromNs(0)).toBe(0);
  });

  it("treats an empty histogram (NaN) as zero rather than poisoning the report", () => {
    expect(msFromNs(Number.NaN)).toBe(0);
  });
});

describe("sampleFromHistogram", () => {
  it("reads percentiles and resets the window (one tick = one interval)", () => {
    const h = fakeHistogram({ p50: 5_000_000, p95: 320_000_000, max: 900_000_000, mean: 20_000_000 });
    expect(sampleFromHistogram(h)).toEqual({ p50Ms: 5, p95Ms: 320, maxMs: 900, meanMs: 20 });
    expect(h.reset).toHaveBeenCalledOnce();
  });
});

describe("nextBusyState", () => {
  it("needs consecutive bad samples before declaring busy", () => {
    const first = nextBusyState(idle, 300);
    expect(first.busy).toBe(false);
    expect(first.changed).toBe(false);

    const second = nextBusyState(first, 300);
    expect(second.busy).toBe(true);
    expect(second.changed).toBe(true);
  });

  it("resets the streak when a good sample interrupts", () => {
    const bad = nextBusyState(idle, 300);
    const good = nextBusyState(bad, 10);
    expect(good.badStreak).toBe(0);
    expect(nextBusyState(good, 300).busy).toBe(false);
  });

  it("stays busy through a single fast sample (hysteresis band)", () => {
    const busy = nextBusyState(nextBusyState(idle, 300), 300);
    expect(busy.busy).toBe(true);
    // 180ms is between exitMs and enterMs: neither clearly good nor bad.
    const mid = nextBusyState(busy, 180);
    expect(mid.busy).toBe(true);
  });

  it("leaves busy only after consecutive good samples, reporting the transition once", () => {
    const busy = nextBusyState(nextBusyState(idle, 300), 300);
    const first = nextBusyState(busy, 50);
    expect(first.busy).toBe(true);
    expect(first.changed).toBe(false);

    const second = nextBusyState(first, 50);
    expect(second.busy).toBe(false);
    expect(second.changed).toBe(true);
  });

  it("uses the documented default policy", () => {
    expect(DEFAULT_BUSY_POLICY).toEqual({ enterMs: 250, exitMs: 150, consecutive: 2 });
  });
});

describe("formatLagLine", () => {
  const sample: LagSample = { p50Ms: 4, p95Ms: 310, maxMs: 900, meanMs: 20 };

  it("marks a busy window and names the in-flight work", () => {
    expect(formatLagLine(sample, "ipc:file:list 3.2s", true)).toBe(
      "lag BUSY p50=4ms p95=310ms max=900ms inflight=[ipc:file:list 3.2s]",
    );
  });

  it("omits the attribution when nothing is pending", () => {
    expect(formatLagLine(sample, "", false)).toBe("lag p50=4ms p95=310ms max=900ms");
  });
});

describe("createLagMonitor", () => {
  it("logs normal samples at debug and busy windows at the default level", () => {
    const log = vi.fn();
    const debug = vi.fn();
    const monitor = createLagMonitor({ log, debug, histogram: fakeHistogram({ p95: 400_000_000 }) });
    try {
      monitor.tick();
      expect(log).not.toHaveBeenCalled();
      monitor.tick();
      expect(log).toHaveBeenCalledWith("perf", expect.stringContaining("BUSY"));
    } finally {
      monitor.stop();
    }
  });

  it("reports busy once (with the culprit) and idle once on recovery", () => {
    const seen: Array<unknown> = [];
    let p95 = 400_000_000;
    const histogram = { ...fakeHistogram(), percentile: (p: number) => (p === 50 ? 0 : p95), reset: vi.fn() };
    const monitor = createLagMonitor({ log: vi.fn(), debug: vi.fn(), histogram, onBusy: (r) => seen.push(r) });
    try {
      beginOp("ipc:session:list-remote");
      monitor.tick();
      monitor.tick();
      expect(seen).toHaveLength(1);
      expect((seen[0] as { opsText: string }).opsText).toBe("ipc:session:list-remote 0.0s");

      p95 = 10_000_000;
      monitor.tick();
      monitor.tick();
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBeNull();
    } finally {
      monitor.stop();
    }
  });

  it("stops its timer without throwing", () => {
    const monitor = createLagMonitor({ log: vi.fn(), debug: vi.fn(), histogram: fakeHistogram(), intervalMs: 5 });
    expect(() => monitor.stop()).not.toThrow();
  });
});
