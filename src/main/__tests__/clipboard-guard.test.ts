import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the hard crash fixed on 2026-09-28.
 *
 * pi's SDK eager-requires the `@mariozechner/clipboard` N-API addon while it is
 * being imported. Inside electron.exe that DLL is a whole-app crash vector
 * (Windows Error Reporting: two 0xc0000005 access violations in
 * `clipboard.win32-x64-msvc.node_unloaded`), so `sdk-worker.ts` flips
 * `TERMUX_VERSION` — pi's own documented "no clipboard" switch — around the
 * dynamic SDK import.
 *
 * The behaviour is checked in a CHILD process (importing the SDK into the vitest
 * worker would load the very addon we are proving is absent, and would fight the
 * module cache), with a control run that shows the addon really is what this
 * guards against.
 */
const sdkEntry = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const probe = join(process.cwd(), "src", "main", "__tests__", "fixtures", "clipboard-guard-probe.mjs");
const workerSource = join(process.cwd(), "src", "main", "chat-backend", "sdk-worker.ts");

interface ProbeResult {
  mode: string;
  error: string | null;
  exportsCount: number | null;
  clipboardModules: string[];
  loadedNative: boolean;
  termuxAfter: string | null;
}

function runProbe(mode: "guard" | "control"): ProbeResult {
  const out = execFileSync(process.execPath, [probe, sdkEntry, mode], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop() as string) as ProbeResult;
}

const available = existsSync(sdkEntry) && existsSync(probe);

/** Each of these boots a child node process that imports the whole SDK; the
 *  `control` one also loads the native clipboard addon. That is seconds of work
 *  under a full parallel suite, i.e. well past vitest's 5s default. */
const PROBE_TIMEOUT_MS = 30_000;

describe.skipIf(!available)("the SDK import must not load the clipboard native addon", () => {
  it("loads the addon when nothing guards the import (the crash vector is real)", () => {
    const result = runProbe("control");
    expect(result.error).toBeNull();
    expect(result.loadedNative).toBe(true);
    expect(result.clipboardModules.some((m) => m.includes("@mariozechner/clipboard"))).toBe(true);
  }, PROBE_TIMEOUT_MS);

  it("loads nothing from the clipboard package when TERMUX_VERSION guards the import", () => {
    const result = runProbe("guard");
    // The SDK itself must still import fine — a guard that broke the SDK would be
    // worse than the crash.
    expect(result.error).toBeNull();
    expect(result.exportsCount).toBeGreaterThan(50);
    expect(result.clipboardModules).toEqual([]);
    expect(result.loadedNative).toBe(false);
  }, PROBE_TIMEOUT_MS);

  it("leaves TERMUX_VERSION as it found it", () => {
    // The guard must not leak into the environment of the agent's own shell
    // commands / child processes.
    const inherited = process.env.TERMUX_VERSION ?? null;
    expect(runProbe("guard").termuxAfter).toBe(inherited);
    expect(runProbe("control").termuxAfter).toBe(inherited);
  }, PROBE_TIMEOUT_MS);

  it("keeps sdk-worker.ts flipping the flag around the import", () => {
    // Source-level, deliberately: the behavioural probe above proves the
    // MECHANISM, this proves the worker still uses it (and restores it in a
    // finally, so a failed import cannot leave the flag behind).
    const src = readFileSync(workerSource, "utf8");
    const setAt = src.indexOf('process.env.TERMUX_VERSION = "pipi-sdk-worker"');
    const importAt = src.indexOf('await import("@earendil-works/pi-coding-agent")');
    const restoreAt = src.indexOf("delete process.env.TERMUX_VERSION");
    expect(setAt, "sdk-worker.ts must set TERMUX_VERSION").toBeGreaterThan(-1);
    expect(importAt, "sdk-worker.ts must import the SDK").toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(importAt);
    expect(restoreAt).toBeGreaterThan(importAt);
    expect(src).toMatch(/finally \{[^}]*TERMUX_VERSION/s);
  });
});
