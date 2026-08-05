// FileTreeIndex — the local file-tree cache (P2). Tests the TTL-guarded sync
// peek, the in-flight walk dedup, and mutation invalidation against a real
// temp directory (no Electron runtime needed — the module only uses fs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileTreeIndex } from "../file-tree-index";
import type { FileNode } from "../file-tree";

let root: string;
let index: FileTreeIndex;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "filetree-"));
  index = new FileTreeIndex();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeProject() {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "x");
  writeFileSync(join(root, "README.md"), "y");
}

describe("FileTreeIndex", () => {
  it("walks and caches a fresh root; cached() serves the snapshot", async () => {
    makeProject();
    const nodes = await index.refresh(root);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(["README.md", "src"]);
    const src = nodes.find((n) => n.name === "src");
    expect(src?.children?.map((c) => c.name)).toEqual(["a.ts"]);
    // Sync peek hits within the TTL (no re-walk).
    expect(index.cached(root)?.length).toBe(2);
  });

  it("an invalidate() landing mid-walk cannot be undone by the stale walk", async () => {
    // Slow, controllable walk: the mutation invalidates while the FIRST walk
    // is still in flight; the second refresh must NOT join the stale walk
    // and the stale snapshot must never be cached.
    let resolveFirst!: (nodes: FileNode[]) => void;
    let callCount = 0;
    const walk = (_r: string) => {
      callCount++;
      return callCount === 1
        ? new Promise<FileNode[]>((r) => (resolveFirst = r)) // first walk hangs
        : Promise.resolve([{ name: "after.md", path: "after.md", type: "file" as const }]);
    };
    const idx = new FileTreeIndex(walk);
    const first = idx.refresh(root);
    idx.invalidate(root); // mutation lands while the first walk is in flight
    const second = await idx.refresh(root); // must start a FRESH walk
    expect(second.map((n) => n.name)).toEqual(["after.md"]);
    resolveFirst([{ name: "before.md", path: "before.md", type: "file" as const }]);
    await first;
    // The stale snapshot must not have been cached by the completing walk.
    expect(idx.cached(root)?.map((n) => n.name)).toEqual(["after.md"]);
  });

  it("re-walks and picks up new files once the TTL has expired", async () => {
    vi.useFakeTimers();
    makeProject();
    await index.refresh(root);
    vi.advanceTimersByTime(5000);
    writeFileSync(join(root, "LATE.md"), "z");
    const nodes = await index.refresh(root);
    expect(nodes.map((n) => n.name)).toContain("LATE.md");
  });

  it("cached() returns undefined once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    makeProject();
    await index.refresh(root);
    expect(index.cached(root)?.length).toBe(2);
    vi.advanceTimersByTime(5000);
    expect(index.cached(root)).toBeUndefined();
  });

  it("dedups concurrent refreshes of the same root (one shared walk)", async () => {
    makeProject();
    const p1 = index.refresh(root);
    const p2 = index.refresh(root);
    const [r1, r2] = await Promise.all([p1, p2]);
    // Same promise → same array identity proves the in-flight dedup.
    expect(r1).toBe(r2);
  });

  it("invalidate() drops the entry so the next refresh re-walks", async () => {
    makeProject();
    await index.refresh(root);
    writeFileSync(join(root, "NEW.md"), "z");
    index.invalidate(root);
    expect(index.cached(root)).toBeUndefined();
    const nodes = await index.refresh(root);
    expect(nodes.map((n) => n.name)).toContain("NEW.md");
  });

  it("serves the stale snapshot until a mutation invalidates it", async () => {
    makeProject();
    await index.refresh(root);
    // A file appears on disk WITHOUT an invalidation (e.g. pi writing): the
    // cache still serves the pre-change snapshot within the TTL.
    writeFileSync(join(root, "LATE.md"), "z");
    expect(index.cached(root)?.map((n) => n.name)).not.toContain("LATE.md");
  });

  it("treats a vanished root as an empty tree (listFiles swallows the error)", async () => {
    const nodes = await index.refresh(join(root, "does-not-exist"));
    expect(nodes).toEqual([]);
    expect(index.cached(join(root, "does-not-exist"))).toEqual([]);
  });
});
