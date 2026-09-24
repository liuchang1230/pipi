// json-store: user data must survive a crash mid-write, and a damaged file must
// never be silently replaced by the empty fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupPathFor,
  drainCorruptReports,
  isWriteBlocked,
  onCorruptReport,
  readJsonRecoverable,
  resetJsonStoreForTests,
  writeJsonAtomic,
  type CorruptFileReport,
} from "../json-store";

let dir = "";
const file = () => join(dir, "config.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipi-json-"));
  resetJsonStoreForTests();
});
afterEach(() => {
  resetJsonStoreForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("writes readable JSON and leaves no temp file behind", () => {
    writeJsonAtomic(file(), { a: 1 });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ a: 1 });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("keeps a .bak of the previous content", () => {
    writeJsonAtomic(file(), { v: 1 });
    writeJsonAtomic(file(), { v: 2 });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ v: 2 });
    expect(JSON.parse(readFileSync(backupPathFor(file()), "utf8"))).toEqual({ v: 1 });
  });

  it("applies a mode without failing where modes are not supported", () => {
    expect(() => writeJsonAtomic(file(), { secret: "x" }, { mode: 0o600 })).not.toThrow();
  });

  it("creates missing parent directories", () => {
    writeJsonAtomic(join(dir, "nested", "deep.json"), { ok: true });
    expect(existsSync(join(dir, "nested", "deep.json"))).toBe(true);
  });
});

describe("readJsonRecoverable", () => {
  it("returns the fallback for a missing file without claiming corruption", () => {
    const result = readJsonRecoverable(file(), []);
    expect(result.value).toEqual([]);
    expect(result.report).toBeUndefined();
    expect(isWriteBlocked(file())).toBe(false);
  });

  it("parses a valid file", () => {
    writeFileSync(file(), JSON.stringify([{ id: "a" }]));
    expect(readJsonRecoverable<Array<{ id: string }>>(file(), []).value).toEqual([{ id: "a" }]);
  });

  it("preserves a corrupt file as .corrupt-*, reports it, and blocks writes", () => {
    writeFileSync(file(), '{"broken":');

    const result = readJsonRecoverable(file(), []);

    expect(result.value).toEqual([]);
    expect(result.report?.reason).toContain("JSON");
    expect(result.report?.backupPath).toBeTruthy();
    expect(readFileSync(result.report!.backupPath, "utf8")).toBe('{"broken":');
    expect(existsSync(file())).toBe(false);
    expect(isWriteBlocked(file())).toBe(true);
  });

  it("treats a well-formed file with the wrong shape as corrupt", () => {
    writeFileSync(file(), JSON.stringify({ not: "an array" }));
    const result = readJsonRecoverable<unknown[]>(file(), [], (raw) => (Array.isArray(raw) ? raw : null));
    expect(result.value).toEqual([]);
    expect(result.report?.reason).toContain("结构");
  });

  it("blocks writes but does not move a file it merely could not read", () => {
    // A directory at the path makes readFileSync fail without the content being
    // provably damaged — never move it aside, but do not overwrite it either.
    mkdirSync(file());
    const result = readJsonRecoverable(file(), []);
    expect(result.report?.backupPath).toBe("");
    expect(isWriteBlocked(file())).toBe(true);
    expect(existsSync(file())).toBe(true);
  });

  it("refuses to overwrite a file that failed to read, and says why", () => {
    writeFileSync(file(), "not json at all");
    readJsonRecoverable(file(), []);
    expect(() => writeJsonAtomic(file(), { would: "wipe" })).toThrow(/损坏/);
    // The damaged bytes are still recoverable (they were moved, not deleted).
    const backup = readdirSync(dir).find((f) => f.includes(".corrupt-"));
    expect(backup).toBeTruthy();
    expect(readFileSync(join(dir, backup!), "utf8")).toBe("not json at all");
  });
});

describe("reporting", () => {
  it("notifies live listeners and queues findings for a later pull", () => {
    const seen: CorruptFileReport[] = [];
    const off = onCorruptReport((r) => seen.push(r));

    writeFileSync(file(), "{");
    readJsonRecoverable(file(), []);

    expect(seen).toHaveLength(1);
    expect(drainCorruptReports()).toHaveLength(1);
    // Draining consumed it: the renderer pulls once at startup.
    expect(drainCorruptReports()).toHaveLength(0);
    off();
  });

  it("survives a listener that throws", () => {
    const off = onCorruptReport(() => {
      throw new Error("bad listener");
    });
    writeFileSync(file(), "{");
    expect(() => readJsonRecoverable(file(), [])).not.toThrow();
    off();
  });
});
