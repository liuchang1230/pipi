// Pure-function tests for the slash-command helpers (commands.ts) plus the
// fetch/cache contract: `window.api` is stubbed in the fetchCommands suite.
import { describe, it, expect, afterEach } from "vitest";
import {
  commandTokenAt,
  fetchCommands,
  filterCommands,
  invalidateCommands,
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

// --- fetchCommands: the "a failed read is not an answer" contract --------------
//
// Regression these lock in: `window.api.tab.rpcRequest` NEVER rejects — on
// timeout it RESOLVES `{success:false, error:"timeout"}` and drops the late
// frame. `fetchCommands` used to hand back the mirrored built-ins regardless of
// `res.success`, so a timed-out probe was indistinguishable from "this session
// has no extension commands". The TreeDialog probe read exactly that as "the
// pipi-tree-nav extension is missing" and refused branch jumps on a remote host
// whose extension was present and synced (get_commands there takes 10-21s
// against a 20s budget).

interface StubResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

type RpcRequest = (id: string, cmd: Record<string, unknown>, timeoutMs?: number) => Promise<StubResponse>;

/** commands.ts only reaches into `window.api.tab.rpcRequest`; vitest runs this
 *  suite in the node environment, which has no `window` at all. */
function installCommandsApi(rpcRequest: RpcRequest): void {
  (globalThis as unknown as { window: unknown }).window = {
    api: { tab: { rpcRequest }, debug: { log: () => {} } },
  };
}

describe("fetchCommands", () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("reports a failed read as an error instead of a built-ins-only list", async () => {
    installCommandsApi(async () => ({ success: false, error: "timeout" }));
    const r = await fetchCommands("t-fail", true);
    expect(r.error).toBe("timeout");
    // Built-ins are still there (the menu stays usable) — but nothing may read
    // this as the session's real command list.
    expect(r.commands.length).toBeGreaterThan(0);
    expect(r.commands.every((c) => c.source === "builtin")).toBe(true);
  });

  it("returns the session's real commands and merges the built-in mirror", async () => {
    installCommandsApi(async () => ({
      success: true,
      data: { commands: [{ name: "pipi-tree-nav", source: "extension" }, { name: "fix-tests", source: "prompt" }] },
    }));
    const r = await fetchCommands("t-ok", true);
    expect(r.error).toBeUndefined();
    expect(r.commands.some((c) => c.name === "pipi-tree-nav" && c.source === "extension")).toBe(true);
    expect(r.commands.some((c) => c.name === "fix-tests" && c.source === "prompt")).toBe(true);
    expect(r.commands.some((c) => c.name === "session" && c.source === "builtin")).toBe(true);
  });

  it("serves a second read from the cache without another round trip", async () => {
    let calls = 0;
    installCommandsApi(async () => {
      calls++;
      return { success: true, data: { commands: [{ name: "pipi-tree-nav", source: "extension" }] } };
    });
    await fetchCommands("t-cache", true);
    const cached = await fetchCommands("t-cache");
    expect(cached.error).toBeUndefined();
    expect(cached.commands.some((c) => c.name === "pipi-tree-nav")).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not cache a failure, so the next caller re-probes", async () => {
    let calls = 0;
    installCommandsApi(async () => {
      calls++;
      return calls === 1
        ? { success: false, error: "timeout" }
        : { success: true, data: { commands: [{ name: "pipi-tree-nav", source: "extension" }] } };
    });
    invalidateCommands("t-retry");
    expect((await fetchCommands("t-retry")).error).toBe("timeout");
    const second = await fetchCommands("t-retry");
    expect(second.error).toBeUndefined();
    expect(second.commands.some((c) => c.name === "pipi-tree-nav")).toBe(true);
    expect(calls).toBe(2);
  });

  it("treats a success with no command array as a failure, not as \"no commands\"", async () => {
    installCommandsApi(async () => ({ success: true, data: {} }));
    const r = await fetchCommands("t-shape", true);
    expect(r.error).toBeTruthy();
    expect(r.commands.every((c) => c.source === "builtin")).toBe(true);
  });
});
