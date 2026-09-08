// SessionIndex tests — the interface is the test surface.
//
// Both backend adapters (local fs, WSL distro) are exercised through the same
// seam: cached / refresh / startPolling / onAnyChange / invalidateFile. The
// WSL adapter is tested with an injected home resolver + path mapper (a temp
// dir), so no wsl.exe spawn and no \\wsl$ UNC is involved.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex, localTarget, wslTarget, targetKey } from "../session-index";
import { encodeCwd } from "../session-list";
import { sameSessionPaths } from "../../shared/session-paths";

let root: string;
let agentDir: string;
let wslRoot: string; // stands in for \\wsl$\<distro> in tests

function sessionLine(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

/** Create a fake session JSONL. Returns the file path. */
function seedSession(dir: string, name: string, opts: { messages?: number; first?: string; name?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [sessionLine("session", { id: `sess-${name}` })];
  if (opts.name) lines.push(sessionLine("session_info", { name: opts.name }));
  const msgs = opts.messages ?? 1;
  for (let i = 0; i < msgs; i++) {
    lines.push(sessionLine("message", { message: { role: i === 0 ? "user" : "assistant", content: i === 0 ? (opts.first ?? `hello ${name}`) : "hi" } }));
  }
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

/** The distro's per-cwd session dir inside the fake WSL root. Mirrors the
 *  module's layout: mapper(distro, home) + .pi/agent/sessions/<enc>. */
const wslDirFor = (linuxCwd: string) => join(wslRoot, "home-tester", ".pi", "agent", "sessions", encodeCwd(linuxCwd));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-index-"));
  agentDir = join(root, "agent");
  wslRoot = join(root, "wsl-home");
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeIndex(): SessionIndex {
  const idx = new SessionIndex();
  idx.setAgentDir(agentDir);
  idx.setWslHomeResolver(async () => "/home/tester");
  idx.setWslPathMapperForTests((_distro, home) => join(wslRoot, home.replace(/^\//, "").replace(/\//g, "-")));
  return idx;
}

describe("local target", () => {
  it("refresh lists sessions of the encoded cwd dir (most recent first)", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    const dir = join(agentDir, "sessions", encodeCwd(cwd));
    const old = seedSession(dir, "old", { messages: 2, first: "first msg" });
    seedSession(dir, "new", { messages: 1, first: "second msg" });
    const past = new Date(Date.now() - 100_000);
    utimesSync(old, past, past);

    const list = await idx.refresh(localTarget(), cwd);
    expect(list).toHaveLength(2);
    expect(list[0].firstMessage).toBe("second msg");
    expect(list[1].firstMessage).toBe("first msg");
    expect(list[1].messageCount).toBe(2);
    expect(list[1].sessionId).toBe("sess-old");
  });

  it("cached returns undefined when absent/stale, then the list inside the TTL", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    expect(idx.cached(localTarget(), cwd)).toBeUndefined();
    await idx.refresh(localTarget(), cwd);
    expect(idx.cached(localTarget(), cwd)).toEqual([]);
    seedSession(join(agentDir, "sessions", encodeCwd(cwd)), "a");
    // Still cached (fresh) — the seeded file is invisible until refresh.
    expect(idx.cached(localTarget(), cwd)).toEqual([]);
    await idx.refresh(localTarget(), cwd);
    expect(idx.cached(localTarget(), cwd)).toHaveLength(1);
  });

  it("cached expires after the TTL (8s) and returns undefined", async () => {
    vi.useFakeTimers();
    try {
      const idx = makeIndex();
      const cwd = "D:/work/proj";
      seedSession(join(agentDir, "sessions", encodeCwd(cwd)), "a");
      await idx.refresh(localTarget(), cwd);
      expect(idx.cached(localTarget(), cwd)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(8001);
      expect(idx.cached(localTarget(), cwd)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("concurrent refreshes of the same (target, cwd) share one in-flight parse", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    seedSession(join(agentDir, "sessions", encodeCwd(cwd)), "a");
    const spy = vi.spyOn(idx as any, "doRefresh");
    const [r1, r2] = await Promise.all([idx.refresh(localTarget(), cwd), idx.refresh(localTarget(), cwd)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it("missing dir yields an empty list without throwing", async () => {
    const idx = makeIndex();
    const list = await idx.refresh(localTarget(), "D:/does/not/exist");
    expect(list).toEqual([]);
  });

  it("refresh reuses parsed entries for unchanged files (snapshot incremental)", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    const dir = join(agentDir, "sessions", encodeCwd(cwd));
    seedSession(dir, "a", { messages: 3, first: "aaa" });
    const first = await idx.refresh(localTarget(), cwd);
    const before = first[0];
    // Re-refresh WITHOUT modification: the entry object must be reused.
    const second = await idx.refresh(localTarget(), cwd);
    expect(second[0]).toBe(before); // same reference → reused from cache
  });

  it("invalidateFile drops the owning cwd cache so deleted files don't resurrect", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    const dir = join(agentDir, "sessions", encodeCwd(cwd));
    seedSession(dir, "a");
    await idx.refresh(localTarget(), cwd);
    expect(idx.cached(localTarget(), cwd)).toHaveLength(1);
    idx.invalidateFile(join(dir, "a.jsonl"));
    expect(idx.cached(localTarget(), cwd)).toBeUndefined();
  });

  it("invalidateFile ignores paths without a sessions segment", () => {
    const idx = makeIndex();
    // Must not throw and must not disturb other caches.
    idx.invalidateFile("D:/some/random/path/file.jsonl");
  });

  it("setAgentDir clears only local caches", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    seedSession(join(agentDir, "sessions", encodeCwd(cwd)), "a");
    await idx.refresh(localTarget(), cwd);
    seedSession(wslDirFor("/home/tester/proj"), "w");
    await idx.refresh(wslTarget("u"), "/home/tester/proj");
    expect(idx.cached(localTarget(), cwd)).toHaveLength(1);
    expect(idx.cached(wslTarget("u"), "/home/tester/proj")).toHaveLength(1);

    idx.setAgentDir(join(root, "other-agent"));
    expect(idx.cached(localTarget(), cwd)).toBeUndefined();
    // WSL cache untouched (independent of agentDir).
    expect(idx.cached(wslTarget("u"), "/home/tester/proj")).toHaveLength(1);
  });
});

describe("wsl target", () => {
  it("refresh lists sessions from the distro session dir (via injected mapper)", async () => {
    const idx = makeIndex();
    const cwd = "/home/tester/proj";
    seedSession(wslDirFor(cwd), "s1", { messages: 1, first: "wsl hello", name: "My WSL session" });
    const list = await idx.refresh(wslTarget("ubuntu"), cwd);
    expect(list).toHaveLength(1);
    expect(list[0].firstMessage).toBe("wsl hello");
    expect(list[0].name).toBe("My WSL session");
    // UNC-free: paths point into the injected root.
    expect(list[0].path.startsWith(wslRoot)).toBe(true);
  });

  it("~ cwds resolve against the injected home", async () => {
    const idx = makeIndex();
    seedSession(wslDirFor("/home/tester"), "home-sess");
    const list = await idx.refresh(wslTarget("ubuntu"), "~");
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe("sess-home-sess");
  });

  it("two distros with the same cwd never collide (target-aware cache key)", async () => {
    const idx = makeIndex();
    const cwd = "/home/tester/proj";
    seedSession(wslDirFor(cwd), "from-u", { first: "distro u" });
    const otherRoot = join(root, "wsl-home-2");
    idx.setWslPathMapperForTests((distro, home) =>
      distro === "u"
        ? join(wslRoot, home.replace(/^\//, "").replace(/\//g, "-"))
        : join(otherRoot, home.replace(/^\//, "").replace(/\//g, "-")),
    );
    seedSession(join(otherRoot, "home-tester", ".pi", "agent", "sessions", encodeCwd(cwd)), "from-deb", { first: "distro deb" });

    const u = await idx.refresh(wslTarget("u"), cwd);
    const deb = await idx.refresh(wslTarget("debian"), cwd);
    expect(u).toHaveLength(1);
    expect(deb).toHaveLength(1);
    expect(u[0].sessionId).not.toBe(deb[0].sessionId);
    expect(targetKey(wslTarget("u"))).not.toBe(targetKey(wslTarget("debian")));
  });

  it("invalidateFile handles UNC-style paths (forward-slash normalized)", async () => {
    const idx = makeIndex();
    const cwd = "/home/tester/proj";
    seedSession(wslDirFor(cwd), "a");
    await idx.refresh(wslTarget("ubuntu"), cwd);
    expect(idx.cached(wslTarget("ubuntu"), cwd)).toHaveLength(1);
    // UNC path as the app hands it around:
    // \\wsl$\ubuntu\home\tester\.pi\agent\sessions\<enc>\a.jsonl
    const unc = "\\\\wsl$\\ubuntu\\home\\tester\\.pi\\agent\\sessions\\" + encodeCwd(cwd) + "\\a.jsonl";
    idx.invalidateFile(unc);
    expect(idx.cached(wslTarget("ubuntu"), cwd)).toBeUndefined();
  });

  it("invalidateFile on one distro leaves the other distro's cache intact", async () => {
    const idx = makeIndex();
    const cwd = "/home/tester/proj";
    seedSession(wslDirFor(cwd), "a");
    await idx.refresh(wslTarget("ubuntu"), cwd);
    await idx.refresh(wslTarget("debian"), cwd); // mapper roots differ by distro? No — same fake root; cache keys differ
    idx.invalidateFile("\\\\wsl$\\ubuntu\\home\\tester\\.pi\\agent\\sessions\\" + encodeCwd(cwd) + "\\a.jsonl");
    expect(idx.cached(wslTarget("ubuntu"), cwd)).toBeUndefined();
    expect(idx.cached(wslTarget("debian"), cwd)).toHaveLength(1);
  });

  it("unresolvable home keeps the previous list", async () => {
    const idx = makeIndex();
    const cwd = "/home/tester/proj";
    seedSession(wslDirFor(cwd), "a");
    // First refresh with a broken resolver → empty (nothing cached yet).
    idx.setWslHomeResolver(async () => {
      throw new Error("wsl.exe timeout");
    });
    expect(await idx.refresh(wslTarget("ubuntu"), cwd)).toEqual([]);
    // Now a working resolver seeds the cache…
    idx.setWslHomeResolver(async () => "/home/tester");
    await idx.refresh(wslTarget("ubuntu"), cwd);
    // …and a later failure must KEEP the previous list, not clear it.
    idx.setWslHomeResolver(async () => {
      throw new Error("down");
    });
    const kept = await idx.refresh(wslTarget("ubuntu"), cwd);
    expect(kept).toHaveLength(1);
  });
});

describe("change emission", () => {
  it("onAnyChange fires with (target, cwd, sessions) on real changes only", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    const dir = join(agentDir, "sessions", encodeCwd(cwd));
    const seen: Array<{ target: string; cwd: string; n: number }> = [];
    idx.onAnyChange((target, c, sessions) => seen.push({ target: targetKey(target), cwd: c, n: sessions.length }));

    // First refresh of a MISSING dir: lists=[] and prev=undefined → emitted
    // once (the sidebar must learn the empty list).
    await idx.refresh(localTarget(), cwd);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ target: "local", cwd, n: 0 });

    // No-op refresh: no emission.
    await idx.refresh(localTarget(), cwd);
    expect(seen).toHaveLength(1);

    // Seeded file → emission with the new list.
    seedSession(dir, "a", { first: "hi" });
    await idx.refresh(localTarget(), cwd);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ target: "local", cwd, n: 1 });
  });

  it("wsl changes carry the wsl target to onAnyChange", async () => {
    const idx = makeIndex();
    const seen: string[] = [];
    idx.onAnyChange((target) => seen.push(targetKey(target)));
    seedSession(wslDirFor("/home/tester/proj"), "w");
    await idx.refresh(wslTarget("ubuntu"), "/home/tester/proj");
    expect(seen).toEqual([targetKey(wslTarget("ubuntu"))]);
  });

  it("targeted onChange receives only its (target, cwd)", async () => {
    const idx = makeIndex();
    const cwd = "D:/work/proj";
    let localCalls = 0;
    idx.onChange(localTarget(), cwd, () => localCalls++);
    seedSession(join(agentDir, "sessions", encodeCwd(cwd)), "a");
    await idx.refresh(localTarget(), cwd);
    seedSession(wslDirFor("/home/tester/proj"), "w");
    await idx.refresh(wslTarget("u"), "/home/tester/proj");
    expect(localCalls).toBe(1);
  });

  it("startPolling polls the given (target, cwd); stopPolling stops", async () => {
    vi.useFakeTimers();
    try {
      const idx = makeIndex();
      const refreshSpy = vi.spyOn(idx, "refresh");
      idx.startPolling(localTarget(), "D:/work/proj");
      expect(idx.getPolledScope()).toEqual({ target: localTarget(), cwd: "D:/work/proj" });
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(8000);
      expect(refreshSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

      idx.stopPolling();
      expect(idx.getPolledScope()).toBeNull();
      const callsAfterStop = refreshSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(8000);
      expect(refreshSpy.mock.calls.length).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("startPolling switches scope when called again", async () => {
    vi.useFakeTimers();
    try {
      const idx = makeIndex();
      idx.startPolling(localTarget(), "D:/a");
      idx.startPolling(wslTarget("u"), "/home/tester/b");
      expect(idx.getPolledScope()).toEqual({ target: wslTarget("u"), cwd: "/home/tester/b" });
      idx.stopPolling();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sameSessionPaths (shared consumer helper)", () => {
  const e = (path: string, mtime = 1): any => ({ path, mtime, sessionId: "", size: 0, messageCount: 0, firstMessage: "", name: null });

  it("ignores mtime drift, detects file-set changes", () => {
    const a = [e("p://a", 1), e("p://b", 2)];
    expect(sameSessionPaths(a, [e("p://a", 99), e("p://b", 98)])).toBe(true);
    expect(sameSessionPaths(a, [e("p://a", 1)])).toBe(false);
    expect(sameSessionPaths(a, [e("p://a", 1), e("p://c", 2)])).toBe(false);
    expect(sameSessionPaths([], [])).toBe(true);
  });
});
