// debug-log: the diagnostic layer must be cheap enough to leave on (no sync
// write per line), honest about what it drops, and bounded on disk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let userData = "";
vi.mock("electron", () => ({
  app: { getPath: () => userData, getAppPath: () => "C:\\fake\\app" },
}));

const mod = await import("../debug-log");
const { debugLog, debugLogDebug, debugLogWarn, debugLogError, flushLog, rotateFiles, resetLogForTests, setLogLevel, MAX_LOG_BYTES } = mod;

function logText(): string {
  const file = join(userData, "pipi-debug.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "pipi-log-"));
  resetLogForTests();
});

afterEach(() => {
  resetLogForTests();
  rmSync(userData, { recursive: true, force: true });
});

describe("debug-log levels", () => {
  it("batches info lines and writes them on flush (no sync write per line)", () => {
    debugLog("t", "one");
    expect(logText()).toBe(""); // still in memory — the whole point
    flushLog();
    expect(logText()).toContain("[t] one");
  });

  it("hides debug lines at the default level and shows them when asked", () => {
    debugLogDebug("poll", "noise");
    flushLog();
    expect(logText()).toBe("");

    setLogLevel("debug");
    debugLogDebug("poll", "noise");
    flushLog();
    expect(logText()).toContain("[poll] noise");
  });

  it("writes warn/error immediately so a crash right after keeps the evidence", () => {
    debugLogWarn("rpc", "UNRESPONSIVE 90s");
    expect(logText()).toContain("[rpc] UNRESPONSIVE 90s");

    debugLogError("renderer", "boom");
    expect(logText()).toContain("[renderer] boom");
  });

  it("honours PIPI_LOG=warn by dropping info", () => {
    setLogLevel("warn");
    debugLog("t", "info-line");
    debugLogWarn("t", "warn-line");
    flushLog();
    expect(logText()).not.toContain("info-line");
    expect(logText()).toContain("warn-line");
  });

  it("drops the OLDEST lines when the buffer overflows, and says so", () => {
    for (let i = 0; i < 4100; i++) debugLog("burst", `line-${i}`);
    flushLog();
    const text = logText();
    expect(text).toContain("行因写入滞后被丢弃");
    expect(text).not.toContain("line-0\n");
    expect(text).toContain("line-4099");
  });
});

describe("debug-log rotation", () => {
  it("shifts generations and keeps the newest file", () => {
    const base = join(userData, "pipi-debug.log");
    writeFileSync(base, "current");
    writeFileSync(`${base}.1`, "prev1");
    writeFileSync(`${base}.2`, "prev2");

    rotateFiles(base, 3);

    expect(readFileSync(`${base}.1`, "utf8")).toBe("current");
    expect(readFileSync(`${base}.2`, "utf8")).toBe("prev1");
    expect(readFileSync(`${base}.3`, "utf8")).toBe("prev2");
    expect(existsSync(base)).toBe(false);
  });

  it("rotates on open when the existing log is already over the cap", () => {
    const base = join(userData, "pipi-debug.log");
    writeFileSync(base, "x".repeat(MAX_LOG_BYTES + 1));

    debugLog("t", "after-rotation");
    flushLog();

    expect(readFileSync(`${base}.1`, "utf8").length).toBe(MAX_LOG_BYTES + 1);
    expect(readFileSync(base, "utf8")).toContain("after-rotation");
  });
});
