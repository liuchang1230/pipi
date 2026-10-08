// The mirror store's two failure modes:
//   1. a snapshot that was in flight when a live push arrived must not roll the
//      surface back (pi's frames are one-shot, so the stale value would stick
//      until the extension changes it again — possibly never);
//   2. a snapshot must still be applied even though the surface frames that
//      produced it were sent BEFORE the renderer attached (a tab's first
//      session_start declarations; that is the whole reason main holds state).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptySurface } from "../../../../shared/extension-ui";
import { useExtensionUiStore } from "../extensionUiStore";

type State = { seq: number; surface: ReturnType<typeof emptySurface> };

const surfaceWith = (status: Record<string, string>) => ({ ...emptySurface(), status });

let snapshots: Map<string, State | (() => Promise<State>)>;
let listeners: Map<string, (state: State) => void>;
const unsubscribed: string[] = [];
const logged: string[] = [];

beforeEach(() => {
  // Module-level subscriptions are not store state: they outlive a test, and a
  // leftover attach would make the next test's attach a no-op. (syncAttached([])
  // only touches tabs that are subscribed, so it never reads window itself.)
  useExtensionUiStore.getState().syncAttached([]);
  useExtensionUiStore.setState({ surfaces: {} });
  unsubscribed.length = 0;
  logged.length = 0;
  snapshots = new Map();
  listeners = new Map();
  // The renderer's only source: the preload bridge.
  (globalThis as unknown as { window: unknown }).window = {
    api: {
      debug: { log: (msg: string) => logged.push(msg) },
      rpcUiSnapshot: (id: string) => {
        const entry = snapshots.get(id) ?? { seq: 0, surface: emptySurface() };
        return typeof entry === "function" ? entry() : Promise.resolve(entry);
      },
      onRpcUiState: (id: string, cb: (state: State) => void) => {
        listeners.set(id, cb);
        return () => {
          unsubscribed.push(id);
          listeners.delete(id);
        };
      },
    },
  };
});

describe("attach", () => {
  it("pulls the snapshot the tab emitted before the renderer attached", async () => {
    snapshots.set("t1", { seq: 3, surface: surfaceWith({ ctx: "42%" }) });
    useExtensionUiStore.getState().attach("t1");
    await Promise.resolve();
    expect(useExtensionUiStore.getState().surfaces.t1?.surface.status).toEqual({ ctx: "42%" });
  });

  it("ignores a snapshot that is older than a push already seen", async () => {
    let release: (s: State) => void = () => {};
    snapshots.set("t1", () => new Promise<State>((resolve) => (release = resolve)));
    useExtensionUiStore.getState().attach("t1");
    listeners.get("t1")?.({ seq: 5, surface: surfaceWith({ ctx: "50%" }) });
    release({ seq: 2, surface: surfaceWith({ ctx: "20%" }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(useExtensionUiStore.getState().surfaces.t1?.seq).toBe(5);
    expect(useExtensionUiStore.getState().surfaces.t1?.surface.status).toEqual({ ctx: "50%" });
  });

  it("is idempotent: a second attach does not double-subscribe", () => {
    const store = useExtensionUiStore.getState();
    store.attach("t1");
    store.attach("t1");
    expect(unsubscribed).toEqual([]);
  });

  it("does not resurrect a tab detached while the snapshot was in flight", async () => {
    let release: (s: State) => void = () => {};
    snapshots.set("t1", () => new Promise<State>((resolve) => (release = resolve)));
    const store = useExtensionUiStore.getState();
    store.attach("t1");
    store.detach("t1");
    release({ seq: 4, surface: surfaceWith({ ctx: "42%" }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(useExtensionUiStore.getState().surfaces.t1).toBeUndefined();
  });

  it("drops a snapshot from a superseded attach (a reused id must not inherit an old seq)", async () => {
    // main forgets a closed tab's seq, so a late answer carrying seq 9 would
    // win over the new tab's seq 1 — and then every newer push (seq 2, 3…)
    // would be dropped as stale, freezing the surface forever.
    let releaseFirst: (s: State) => void = () => {};
    snapshots.set("t1", () => new Promise<State>((resolve) => (releaseFirst = resolve)));
    const store = useExtensionUiStore.getState();
    store.attach("t1");
    store.detach("t1");
    snapshots.set("t1", { seq: 1, surface: surfaceWith({ ctx: "new" }) });
    store.attach("t1");
    releaseFirst({ seq: 9, surface: surfaceWith({ ctx: "stale" }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(useExtensionUiStore.getState().surfaces.t1?.seq).toBe(1);
    listeners.get("t1")?.({ seq: 2, surface: surfaceWith({ ctx: "newer" }) });
    expect(useExtensionUiStore.getState().surfaces.t1?.seq).toBe(2);
  });

  it("logs a failed snapshot instead of swallowing the only recovery path", async () => {
    snapshots.set("t1", () => Promise.reject(new Error("channel gone")));
    useExtensionUiStore.getState().attach("t1");
    await Promise.resolve();
    await Promise.resolve();
    expect(logged.join("\n")).toContain("channel gone");
  });
});

describe("syncAttached", () => {
  it("attaches new tabs and detaches closed ones", () => {
    const store = useExtensionUiStore.getState();
    store.syncAttached(["a", "b"]);
    expect([...listeners.keys()]).toEqual(["a", "b"]);
    store.syncAttached(["b", "c"]);
    expect([...listeners.keys()].sort()).toEqual(["b", "c"]);
    expect(unsubscribed).toEqual(["a"]);
  });

  it("clears the surface of a closed tab (a reused id must not show stale state)", () => {
    const store = useExtensionUiStore.getState();
    store.syncAttached(["a"]);
    store.applyState("a", { seq: 1, surface: surfaceWith({ ctx: "42%" }) });
    store.syncAttached([]);
    expect(useExtensionUiStore.getState().surfaces).toEqual({});
  });
});

describe("applyState", () => {
  it("keeps equal seqs (a re-push of the same frame is not stale)", () => {
    const store = useExtensionUiStore.getState();
    store.applyState("a", { seq: 1, surface: surfaceWith({ ctx: "1%" }) });
    store.applyState("a", { seq: 1, surface: surfaceWith({ ctx: "1%" }) });
    expect(useExtensionUiStore.getState().surfaces.a?.seq).toBe(1);
  });

  it("notifies subscribers of the same tab only", () => {
    const seen = vi.fn();
    const off = useExtensionUiStore.subscribe((s, prev) => {
      if (s.surfaces.a !== prev.surfaces.a) seen(s.surfaces.a?.seq);
    });
    useExtensionUiStore.getState().applyState("a", { seq: 1, surface: emptySurface() });
    useExtensionUiStore.getState().applyState("b", { seq: 1, surface: emptySurface() });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });
});
