import { describe, expect, it } from "vitest";
import {
  clampLine,
  diffStat,
  fmtDuration,
  parseBashResult,
  prettyPath,
  summarizeTool,
} from "../tool-summary";

describe("clampLine", () => {
  it("collapses whitespace and truncates with ellipsis", () => {
    expect(clampLine("  a\n\nb\tc  ", 10)).toBe("a b c");
    const long = clampLine("x".repeat(100), 10);
    expect(long.length).toBe(10);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("prettyPath", () => {
  it("splits win/posix paths and handles bare names", () => {
    expect(prettyPath("src/renderer/panes/ChatPane.tsx")).toEqual({
      dir: "src/renderer/panes/",
      base: "ChatPane.tsx",
    });
    expect(prettyPath("D:\\proj\\src\\a.ts")).toEqual({ dir: "D:\\proj\\src\\", base: "a.ts" });
    expect(prettyPath("file.ts")).toEqual({ base: "file.ts" });
    expect(prettyPath(undefined)).toBeNull();
  });
});

describe("diffStat", () => {
  it("counts +/- lines ignoring headers", () => {
    const diff = ["--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-old", "+new", "+new2", " ctx"].join("\n");
    expect(diffStat(diff)).toEqual({ adds: 2, dels: 1 });
  });
  it("returns null for empty diff", () => {
    expect(diffStat("")).toBeNull();
  });
});

describe("parseBashResult (pi real output formats)", () => {
  it("success output: no exit code, no duration, just line count", () => {
    const r = parseBashResult("file1.ts\nfile2.ts\nfile3.ts");
    expect(r.exitCode).toBeUndefined();
    expect(r.durationMs).toBeUndefined();
    expect(r.lines).toBe(3);
  });

  it("failure: pi appends 'Command exited with code N'", () => {
    const r = parseBashResult("some output\n\nCommand exited with code 1");
    expect(r.exitCode).toBe(1);
    expect(r.lines).toBe(2);
  });

  it("timeout: pi appends 'Command timed out after N seconds'", () => {
    const r = parseBashResult("partial output\n\nCommand timed out after 120 seconds");
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBe(120_000);
  });

  it("does not scrape durations from arbitrary command output", () => {
    const r = parseBashResult("done in 2.5s\nall good");
    expect(r.durationMs).toBeUndefined();
    expect(r.exitCode).toBeUndefined();
  });
});

/** pi's bash tool throws on failure; the renderer marks isError — but also
 * cover the case where only the text carries the failure (older sessions). */
const BASH_FAIL_TEXT = "npm ERR!Test failed\n\nCommand exited with code 1";

describe("fmtDuration", () => {
  it("formats ms/s/m", () => {
    expect(fmtDuration(850)).toBe("850ms");
    expect(fmtDuration(3200)).toBe("3.2s");
    expect(fmtDuration(65_000)).toBe("1m 5s");
  });
});

describe("summarizeTool", () => {
  it("bash success: command + line count, no exit/duration chips", () => {
    const s = summarizeTool("bash", JSON.stringify({ command: "npm run build" }), "vite v5 building\ndone in 3.2s", false);
    expect(s).toMatchObject({ object: "npm run build", exitCode: undefined, durationMs: undefined, alert: false });
    expect(s?.lines).toBe(2);
  });

  it("bash failure via text: exit chip + alert", () => {
    const s = summarizeTool("bash", JSON.stringify({ command: "npm test" }), BASH_FAIL_TEXT, false);
    expect(s?.alert).toBe(true);
    expect(s?.exitCode).toBe(1);
  });

  it("bash failure via isError (tool threw, text may lack status)", () => {
    const s = summarizeTool("bash", JSON.stringify({ command: "npm test" }), "npm ERR!boom", true);
    expect(s?.alert).toBe(true);
  });

  it("bash timeout sets alert even without isError", () => {
    const s = summarizeTool("bash", JSON.stringify({ command: "sleep 999" }), "\n\nCommand timed out after 60 seconds", false);
    expect(s?.alert).toBe(true);
    expect(s?.durationMs).toBe(60_000);
  });

  it("edit: path split + diffstat from args", () => {
    const args = JSON.stringify({
      path: "src/a.ts",
      edits: [{ oldText: "const x = 1", newText: "const x = 2\nconst y = 3" }],
    });
    const s = summarizeTool("edit", args, "", false);
    expect(s?.object).toBe("a.ts");
    expect(s?.objectDir).toBe("src/");
    expect(s?.stat).toEqual({ adds: 2, dels: 1 });
  });

  it("read: shows line count from result", () => {
    const s = summarizeTool("read", JSON.stringify({ path: "src/store.ts" }), "l1\nl2\nl3", false);
    expect(s?.object).toBe("store.ts");
    expect(s?.size).toBe("3 行");
  });

  it("write: shows content lines", () => {
    const s = summarizeTool("write", JSON.stringify({ path: "out.txt", content: "a\nb" }), "", false);
    expect(s?.object).toBe("out.txt");
    expect(s?.size).toBe("2 行");
  });

  it("generic tools: first matching intent arg", () => {
    const s = summarizeTool("scout", JSON.stringify({ task: "find auth code" }), "ok", false);
    expect(s?.object).toBe("find auth code");
  });

  it("errors set alert for non-bash tools", () => {
    const s = summarizeTool("read", JSON.stringify({ path: "missing.ts" }), "Error: not found", true);
    expect(s?.alert).toBe(true);
  });

  it("partial streaming args JSON does not throw", () => {
    expect(() => summarizeTool("edit", '{"path":"a.ts","edits":[{"oldText":"x"', "", false)).not.toThrow();
    expect(summarizeTool("edit", '{"path":"a.ts","edits":[{"oldText":"x"', "", false)?.stat).toBeUndefined();
  });

  it("write_file alias with file_path arg", () => {
    const s = summarizeTool("write_file", JSON.stringify({ file_path: "out.txt", content: "a\nb\n" }), "", false);
    expect(s?.object).toBe("out.txt");
    expect(s?.size).toBe("2 行");
  });

  it("apply_patch shows 补丁 + diffstat", () => {
    const patch = ["--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-x", "+y"].join("\n");
    const s = summarizeTool("apply_patch", JSON.stringify({ patch }), "", false);
    expect(s?.object).toBe("补丁");
    expect(s?.stat).toEqual({ adds: 1, dels: 1 });
  });

  it("unknown-outcome historical block (no isError, no result) still renders", () => {
    const s = summarizeTool("read", JSON.stringify({ path: "a.ts" }), "", false);
    expect(s?.alert).toBe(false);
  });
});
