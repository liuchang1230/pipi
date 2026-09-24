// withDeadline: the caller-side bound that turns "hangs forever" into a
// terminal error. The regression it locks down: a promise that never settles
// (wedged SFTP op) must not leave a spinner up.
import { describe, expect, it, vi } from "vitest";
import { DeadlineError, isDeadlineError, withDeadline } from "../with-deadline";

describe("withDeadline", () => {
  it("passes through a value that arrives in time", async () => {
    await expect(withDeadline(Promise.resolve(42), 50, "读取文件")).resolves.toBe(42);
  });

  it("propagates the original rejection instead of a timeout", async () => {
    const boom = new Error("permission denied");
    await expect(withDeadline(Promise.reject(boom), 50, "读取文件")).rejects.toBe(boom);
  });

  it("rejects with DeadlineError when the promise never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = withDeadline(new Promise<never>(() => {}), 30_000, "列举远程目录 /data/x");
      const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineError);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the operation and the elapsed budget in the message", async () => {
    vi.useFakeTimers();
    try {
      const pending = withDeadline(new Promise<never>(() => {}), 15_000, "列举远程目录 /data/x");
      const assertion = expect(pending).rejects.toThrow("列举远程目录 /data/x 超过 15s 未响应");
      await vi.advanceTimersByTimeAsync(15_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer on success (no dangling handle)", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      await withDeadline(Promise.resolve("ok"), 30_000, "读取文件");
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("isDeadlineError", () => {
  it("recognises our own timeout from either realm (name-based fallback)", () => {
    expect(isDeadlineError(new DeadlineError("列举远程目录", 30_000))).toBe(true);
    // A structurally identical error from another module instance still counts:
    // instanceof is not reliable across bundles.
    const lookalike = new Error("x");
    lookalike.name = "DeadlineError";
    expect(isDeadlineError(lookalike)).toBe(true);
  });

  it("does not claim ordinary failures", () => {
    expect(isDeadlineError(new Error("ECONNRESET"))).toBe(false);
    expect(isDeadlineError("timeout")).toBe(false);
  });
});
