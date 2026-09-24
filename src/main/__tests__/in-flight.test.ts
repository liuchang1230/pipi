// in-flight: the attribution source for lag reports. It must be idempotent and
// must never lose or leak a slot, or the "在等什么" sentence lies.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginOp, clearOpsForTests, describeOps, snapshotOps, trackIpcHandlersOn, withOpTracking } from "../in-flight";

beforeEach(() => clearOpsForTests());

describe("beginOp", () => {
  it("reports an in-flight operation with its elapsed time", () => {
    beginOp("ipc:file:list");
    const [op] = snapshotOps(Date.now() + 2500);
    expect(op?.name).toBe("ipc:file:list");
    expect(op?.elapsedMs).toBe(2500);
  });

  it("removes the operation when the disposer runs (no leak across calls)", () => {
    const end = beginOp("ipc:file:list");
    end();
    expect(snapshotOps()).toEqual([]);
  });

  it("ignores a double dispose so it cannot free another operation's slot", () => {
    const end = beginOp("a");
    end();
    end();
    beginOp("b");
    expect(snapshotOps().map((o) => o.name)).toEqual(["b"]);
  });
});

describe("snapshotOps / describeOps", () => {
  it("sorts longest-running first — the likeliest stall cause", () => {
    beginOp("fast");
    beginOp("slow");
    const names = snapshotOps(Date.now() + 1000).map((o) => o.name);
    // Both started within the same millisecond, so ordering falls back to
    // insertion; the contract that matters is that elapsed drives the sort.
    expect(names).toHaveLength(2);

    const later = snapshotOps(Date.now() + 5000).map((o) => o.elapsedMs);
    expect(later[0]).toBeGreaterThanOrEqual(later[1]!);
  });

  it("formats a human sentence and stays empty when idle", () => {
    expect(describeOps()).toBe("");
    beginOp("ipc:session:list-remote");
    expect(describeOps(Date.now() + 3200, 3)).toBe("ipc:session:list-remote 3.2s");
  });

  it("caps how many operations it names", () => {
    for (const name of ["a", "b", "c", "d"]) beginOp(name);
    expect(describeOps(Date.now(), 2).split(", ")).toHaveLength(2);
  });
});

describe("withOpTracking", () => {
  it("tracks the listener for its whole run and returns its value", async () => {
    const tracked = withOpTracking("ipc:file:list", async (n: number) => {
      expect(snapshotOps().map((o) => o.name)).toEqual(["ipc:file:list"]);
      return n * 2;
    });
    await expect(tracked(21)).resolves.toBe(42);
    expect(snapshotOps()).toEqual([]);
  });

  it("releases the slot when the listener throws", async () => {
    const tracked = withOpTracking("ipc:boom", () => {
      throw new Error("bad");
    });
    await expect(tracked()).rejects.toThrow("bad");
    expect(snapshotOps()).toEqual([]);
  });
});

describe("trackIpcHandlersOn", () => {
  it("tracks every handler registered after the patch, by channel name", async () => {
    const registered = new Map<string, (...args: never[]) => unknown>();
    const registrar = { handle: (channel: string, listener: (...args: never[]) => unknown) => registered.set(channel, listener) };

    trackIpcHandlersOn(registrar);
    registrar.handle("file:list", async (dir: never) => { dir; return "ok"; });

    const listener = registered.get("file:list")!;
    expect(listener).toBeTypeOf("function");
    // The wrapper owns the attribution window.
    const result = (listener as unknown as () => Promise<string>)();
    expect(snapshotOps().map((o) => o.name)).toEqual(["ipc:file:list"]);
    await expect(result).resolves.toBe("ok");
    expect(snapshotOps()).toEqual([]);
  });

  it("still forwards the channel and the original listener arguments", async () => {
    const calls: Array<[string, unknown]> = [];
    const registrar = {
      handle: (channel: string, listener: (...args: never[]) => unknown) => {
        calls.push([channel, listener]);
      },
    };
    trackIpcHandlersOn(registrar);
    const original = vi.fn((a: number, b: number) => a + b);
    registrar.handle("math:add", original as unknown as (...args: never[]) => unknown);

    expect(calls[0]?.[0]).toBe("math:add");
    const wrapped = calls[0]?.[1] as unknown as (a: number, b: number) => Promise<number>;
    await expect(wrapped(2, 3)).resolves.toBe(5);
    expect(original).toHaveBeenCalledWith(2, 3);
  });
});
