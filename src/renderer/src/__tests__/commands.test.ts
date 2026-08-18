// Pure-function tests for the slash-command helpers (commands.ts). The
// fetch+cache half needs window.api and is covered manually / in the app.
import { describe, it, expect } from "vitest";
import {
  commandTokenAt,
  filterCommands,
  replaceCommandToken,
  type SessionCommand,
} from "../commands";

const COMMANDS: SessionCommand[] = [
  { name: "session-name", description: "设置会话名称", source: "extension" },
  { name: "fix-tests", description: "修复失败的测试", source: "prompt" },
  { name: "skill:brave-search", description: "通过 Brave 搜索", source: "skill" },
  { name: "checkpoint", source: "extension" },
];

describe("filterCommands", () => {
  it("returns all commands for an empty query", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(4);
  });

  it("ranks prefix matches before contains matches", () => {
    const out = filterCommands(COMMANDS, "fix");
    expect(out.map((c) => c.name)).toEqual(["fix-tests"]);
    const out2 = filterCommands(COMMANDS, "test");
    expect(out2.map((c) => c.name)).toEqual(["fix-tests"]);
  });

  it("matches descriptions too", () => {
    const out = filterCommands(COMMANDS, "brave");
    expect(out.map((c) => c.name)).toEqual(["skill:brave-search"]);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(COMMANDS, "CHECK").map((c) => c.name)).toEqual(["checkpoint"]);
  });

  it("returns nothing on no match", () => {
    expect(filterCommands(COMMANDS, "zzz")).toEqual([]);
  });
});

describe("commandTokenAt", () => {
  it("detects a leading /query token", () => {
    expect(commandTokenAt("/fix", 4)).toEqual({ start: 0, query: "fix" });
  });

  it("detects a bare slash", () => {
    expect(commandTokenAt("/", 1)).toEqual({ start: 0, query: "" });
  });

  it("detects a token mid-line after whitespace", () => {
    expect(commandTokenAt("check /fix here", 10)).toEqual({ start: 6, query: "fix" });
  });

  it("ignores non-slash text and slash inside a word", () => {
    expect(commandTokenAt("hello world", 5)).toBeNull();
    expect(commandTokenAt("a/b", 3)).toBeNull();
  });

  it("ignores a completed token (trailing space)", () => {
    expect(commandTokenAt("/fix ", 5)).toBeNull();
  });
});

describe("replaceCommandToken", () => {
  it("replaces the token and appends a space", () => {
    expect(replaceCommandToken("check /fix here", 6, 3, "fix-tests")).toBe("check /fix-tests  here");
  });

  it("replaces a leading token", () => {
    expect(replaceCommandToken("/fix", 0, 3, "fix-tests")).toBe("/fix-tests ");
  });
});

describe("commandTokenAt boundaries", () => {
  it("detects a token after a newline", () => {
    expect(commandTokenAt("line1\n/fix", 10)).toEqual({ start: 6, query: "fix" });
  });

  it("detects a bare slash after a newline", () => {
    expect(commandTokenAt("abc\n/", 5)).toEqual({ start: 4, query: "" });
  });

  it("handles tabs as whitespace separators", () => {
    expect(commandTokenAt("a\t/fix", 6)).toEqual({ start: 2, query: "fix" });
  });

  it("detects the token at end-of-string without trailing space", () => {
    expect(commandTokenAt("go /list", 8)).toEqual({ start: 3, query: "list" });
  });

  it("does not treat a slash as a token when the caret is elsewhere", () => {
    expect(commandTokenAt("a / b", 1)).toBeNull();
    expect(commandTokenAt("a / b", 5)).toBeNull(); // after the 'b'
  });
});
