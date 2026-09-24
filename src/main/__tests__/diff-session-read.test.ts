// The synthetic "whole file" diff is display-only, and reading a huge file for
// it used to happen synchronously on the main process — a real freeze source
// (docs/robustness-plan.md A4). The cap must refuse, not truncate: a truncated
// diff would show lines the file does not have.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCtx } from "../diff-session";

vi.mock("electron", () => ({ app: { getPath: () => "C:\\fake\\userdata", getAppPath: () => "C:\\fake\\app" } }));

const { MAX_SYNTHETIC_DIFF_BYTES, readFileContentCapped } = await import("../diff-session");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipi-diff-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Built per test: `dir` is assigned in beforeEach, so a module-level
 *  literal would capture the empty initial value. */
const localCtx = (): GitCtx => ({ kind: "local", dir });

describe("readFileContentCapped", () => {
  it("reads a local file under the cap", async () => {
    writeFileSync(join(dir, "small.txt"), "hello");
    await expect(readFileContentCapped(localCtx(), "small.txt", 1024)).resolves.toBe("hello");
  });

  it("refuses a local file over the cap WITHOUT reading it (stat first)", async () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(2048));
    await expect(readFileContentCapped(localCtx(), "big.txt", 1024)).rejects.toThrow("文件过大");
  });

  it("reports the sizes, so the user knows why the diff is missing", async () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(2 * 1024 * 1024));
    await expect(readFileContentCapped(localCtx(), "big.txt", 1024)).rejects.toThrow("2.0MB > 0.0MB");
  });

  it("lets a missing local file fail as a normal read error", async () => {
    await expect(readFileContentCapped(localCtx(), "nope.txt", 1024)).rejects.toThrow();
  });

  it("gates streamed (WSL/SSH) content on what came back", async () => {
    const wslCtx: GitCtx = { kind: "wsl", wslDistro: "Ubuntu" };
    const read = vi.fn(async () => "y".repeat(2048));
    await expect(readFileContentCapped(wslCtx, "big.txt", 1024, read)).rejects.toThrow("文件过大");

    const smallRead = vi.fn(async () => "ok");
    await expect(readFileContentCapped(wslCtx, "small.txt", 1024, smallRead)).resolves.toBe("ok");
  });

  it("defaults to a 2MB cap", () => {
    expect(MAX_SYNTHETIC_DIFF_BYTES).toBe(2 * 1024 * 1024);
  });
});
