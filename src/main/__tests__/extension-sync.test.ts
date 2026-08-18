// ensureShippedExtensions — ships app-bundled pi extension sources to the
// target dir, only writing when content differs, returning what was actually
// updated. Uses a real temp dir (no Electron runtime needed).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureShippedExtensions } from "../extension-sync";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "extsync-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("ensureShippedExtensions", () => {
  it("writes all shipped extensions on first run and returns their names", () => {
    const dir = tempDir();
    const updated = ensureShippedExtensions(dir);
    expect(updated.length).toBeGreaterThan(0);
    for (const name of updated) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
  });

  it("returns an empty list when nothing changed on the second run", () => {
    const dir = tempDir();
    expect(ensureShippedExtensions(dir).length).toBeGreaterThan(0);
    expect(ensureShippedExtensions(dir)).toEqual([]);
  });

  it("returns only the changed file after one file is modified", () => {
    const dir = tempDir();
    const updated = ensureShippedExtensions(dir);
    expect(updated.length).toBeGreaterThan(1);
    // Corrupt one file: the next sync must rewrite exactly that one.
    const target = join(dir, updated[0]!);
    writeFileSync(target, "// tampered\n", "utf8");
    expect(ensureShippedExtensions(dir)).toEqual([updated[0]]);
    expect(existsSync(target)).toBe(true);
  });
});
