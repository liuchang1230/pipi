// A pi probe that hits the spawn timeout is INCONCLUSIVE — it must never be
// reported as "pi is missing". `ensurePiReady()` answers a missing pi by
// copying the BUNDLED pi over the user's global install, which would silently
// downgrade a pi they keep current with `pi update`. Regression for
// docs/robustness-plan.md A1 (bounded, non-destructive detection).
//
// ADR 0007 决策 6：这条规则现在是具名状态 `unverified`，不再折叠成一个
// boolean 让调用方去猜 —— 测试直接断言三态，而不是断言 `true`。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "C:\\fake\\app", getPath: () => "C:\\fake\\userdata" },
}));
vi.mock("../debug-log", () => ({ debugLog: vi.fn() }));

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync, spawn: vi.fn() }));

const { present, invalidate } = await import("../local-pi");

function probeResult(code: string | undefined, status: number | null) {
  return {
    error: code ? Object.assign(new Error(`spawnSync pi ${code}`), { code }) : undefined,
    status,
    signal: null,
    output: [],
    pid: 1,
    stdout: status === 0 ? "0.85.1\n" : "",
    stderr: "",
  };
}

describe("pi detection timeout", () => {
  beforeEach(() => {
    invalidate();
    spawnSync.mockReset();
  });

  it("reports a TIMED-OUT probe as unverified, so nothing reinstalls over the user's pi", () => {
    spawnSync.mockReturnValue(probeResult("ETIMEDOUT", null));
    expect(present()).toBe("unverified");
  });

  it("still reports a genuinely MISSING pi as absent (install path stays reachable)", () => {
    spawnSync.mockReturnValue(probeResult("ENOENT", null));
    expect(present()).toBe("absent");
  });

  it("treats a successful probe as present", () => {
    spawnSync.mockReturnValue(probeResult(undefined, 0));
    expect(present()).toBe("present");
  });

  it("recovers once a later probe succeeds (the timeout is not sticky)", () => {
    spawnSync.mockReturnValue(probeResult("ETIMEDOUT", null));
    expect(present()).toBe("unverified");

    invalidate();
    spawnSync.mockReturnValue(probeResult(undefined, 0));
    expect(present()).toBe("present");
  });

  it("keeps the timeout verdict inside the re-check window (no second probe)", () => {
    spawnSync.mockReturnValue(probeResult("ETIMEDOUT", null));
    expect(present()).toBe("unverified");
    const probes = spawnSync.mock.calls.length;
    expect(present()).toBe("unverified");
    // 一次超时只换一次有界冻结：窗口内不再探测（第二次调用没多出 spawn）。
    expect(spawnSync.mock.calls.length).toBe(probes);
  });
});
