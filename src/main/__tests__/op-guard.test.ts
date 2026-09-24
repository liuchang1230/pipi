// op-guard: bounding an operation must ALSO release what it holds, or the
// resource outlives the timeout and poisons every later call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOpsForTests, snapshotOps } from "../in-flight";
import { isOpGuardError, runGuarded, withOpGuard } from "../op-guard";

beforeEach(() => clearOpsForTests());

describe("withOpGuard", () => {
  it("passes the value through and tracks the operation while it runs", async () => {
    const seen: string[] = [];
    const value = await withOpGuard("sftp:list", { deadlineMs: 1000 }, async () => {
      seen.push(...snapshotOps().map((o) => o.name));
      return "files";
    });
    expect(value).toBe("files");
    expect(seen).toEqual(["sftp:list"]);
    expect(snapshotOps()).toEqual([]);
  });

  it("reports how long the operation had been running to progress()", async () => {
    const elapsed = await withOpGuard("sftp:list", { deadlineMs: 1000 }, async (p) => {
      expect(p.elapsed()).toBeGreaterThanOrEqual(0);
      return p.elapsed();
    });
    expect(elapsed).toBeLessThan(1000);
  });

  it("rethrows the ORIGINAL failure untouched so peer-error helpers keep working", async () => {
    // `isSftpMissingPathError` / `isSshAuthError` inspect the original object
    // (SFTP status code, message). Wrapping it would silently break
    // "missing directory = empty session list".
    const failure = Object.assign(new Error("ENOENT: no such file, open '/data/x'"), { code: "ENOENT" });
    await expect(
      withOpGuard("sftp:get", { deadlineMs: 1000, target: { host: "h" } }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("classifies that failure into an AppError in the Outcome form", async () => {
    const failure = Object.assign(new Error("ENOENT: no such file, open '/data/x'"), { code: "ENOENT" });
    const outcome = await runGuarded(
      "sftp:get",
      { deadlineMs: 1000, target: { host: "h", path: "/data/x" } },
      async () => {
        throw failure;
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("notfound");
    expect(outcome.error.title).toBe("sftp:get 失败");
    expect(outcome.error.target).toEqual({ host: "h", path: "/data/x" });
    expect(outcome.error.cause).toContain("ENOENT");
  });

  it("times out, reports it once, and releases the resource it held", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const pending = withOpGuard("sftp:list", { deadlineMs: 20_000, onTimeout }, () => new Promise<never>(() => {}));
      const assertion = expect(pending).rejects.toThrow(/未响应/);
      await vi.advanceTimersByTimeAsync(20_001);
      await assertion;

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout.mock.calls[0]?.[0]).toMatchObject({ name: "sftp:list", deadlineMs: 20_000 });
      expect(snapshotOps()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late settlement — the caller already gave up", async () => {
    vi.useFakeTimers();
    try {
      let lateResolved = false;
      const pending = withOpGuard("sftp:list", { deadlineMs: 1000 }, async () => {
        await new Promise((r) => setTimeout(r, 5000));
        lateResolved = true;
        return "too late";
      });
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      await vi.advanceTimersByTimeAsync(10_000);
      // The promise settled late, but the timeout outcome was already delivered
      // and nothing was written through to the caller.
      expect(lateResolved).toBe(true);
      expect(snapshotOps()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports the timeout when its own cleanup fails", async () => {
    vi.useFakeTimers();
    try {
      const pending = withOpGuard(
        "sftp:list",
        {
          deadlineMs: 1000,
          onTimeout: () => {
            throw new Error("destroy failed");
          },
        },
        () => new Promise<never>(() => {}),
      );
      const assertion = expect(pending).rejects.toThrow(/未响应/);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runGuarded", () => {
  it("returns an Outcome instead of throwing", async () => {
    const good = await runGuarded("sftp:list", { deadlineMs: 1000 }, async () => 1);
    expect(good).toEqual({ ok: true, value: 1 });

    const bad = await runGuarded("sftp:list", { deadlineMs: 1000 }, async () => {
      throw new Error("boom");
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("internal");
  });
});
