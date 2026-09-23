// A pi probe that hits the spawn timeout is INCONCLUSIVE — it must never be
// reported as "pi is missing". `ensurePiReady()` answers a missing pi by
// copying the BUNDLED pi over the user's global install, which would silently
// downgrade a pi they keep current with `pi update`. Regression for
// docs/robustness-plan.md A1 (bounded, non-destructive detection).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getAppPath: () => "C:\\fake\\app", getPath: () => "C:\\fake\\userdata" },
}));
vi.mock("../debug-log", () => ({ debugLog: vi.fn() }));

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync, spawn: vi.fn() }));

const { hasGlobalPiInstalled, invalidatePiDetection } = await import("../pty");

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
    invalidatePiDetection();
    spawnSync.mockReset();
  });

  it("reports a TIMED-OUT probe as present, so nothing reinstalls over the user's pi", () => {
    spawnSync.mockReturnValue(probeResult("ETIMEDOUT", null));
    expect(hasGlobalPiInstalled()).toBe(true);
  });

  it("still reports a genuinely MISSING pi as not installed (install path stays reachable)", () => {
    spawnSync.mockReturnValue(probeResult("ENOENT", null));
    expect(hasGlobalPiInstalled()).toBe(false);
  });

  it("treats a successful probe as installed", () => {
    spawnSync.mockReturnValue(probeResult(undefined, 0));
    expect(hasGlobalPiInstalled()).toBe(true);
  });

  it("recovers once a later probe succeeds (the timeout is not sticky)", () => {
    spawnSync.mockReturnValue(probeResult("ETIMEDOUT", null));
    expect(hasGlobalPiInstalled()).toBe(true);

    invalidatePiDetection();
    spawnSync.mockReturnValue(probeResult(undefined, 0));
    expect(hasGlobalPiInstalled()).toBe(true);
  });
});
