import { describe, expect, it } from "vitest";
import { sanitizeRemoteAgentDir, remoteAgentDir, buildRemoteKey } from "../pty";

describe("sanitizeRemoteAgentDir", () => {
  it("accepts ~-prefixed paths", () => {
    expect(sanitizeRemoteAgentDir("~/pi-zhangsan/agent")).toBe("~/pi-zhangsan/agent");
    expect(sanitizeRemoteAgentDir("~")).toBe("~");
    expect(sanitizeRemoteAgentDir("~/a_b-c.d/e")).toBe("~/a_b-c.d/e");
  });

  it("accepts absolute POSIX paths", () => {
    expect(sanitizeRemoteAgentDir("/opt/pipi/agents/zhangsan")).toBe("/opt/pipi/agents/zhangsan");
    expect(sanitizeRemoteAgentDir("/")).toBe("/");
  });

  it("rejects tilde-prefix forms whose expansion differs from SFTP-side", () => {
    expect(sanitizeRemoteAgentDir("~bob/agent")).toBeNull(); // ~user
    expect(sanitizeRemoteAgentDir("~-")).toBeNull(); // $OLDPWD
    expect(sanitizeRemoteAgentDir("~+")).toBeNull(); // $PWD
    expect(sanitizeRemoteAgentDir("~-1")).toBeNull();
    expect(sanitizeRemoteAgentDir("~+1")).toBeNull();
  });

  it("rejects shell-unsafe input", () => {
    expect(sanitizeRemoteAgentDir("~/a b")).toBeNull(); // space
    expect(sanitizeRemoteAgentDir("~/a;rm -rf /")).toBeNull(); // ; injection
    expect(sanitizeRemoteAgentDir("~/$(whoami)")).toBeNull(); // $()
    expect(sanitizeRemoteAgentDir("~/a'b")).toBeNull(); // quote
    expect(sanitizeRemoteAgentDir("~/a`b")).toBeNull(); // backtick
    expect(sanitizeRemoteAgentDir("~/a\\b")).toBeNull(); // backslash
    expect(sanitizeRemoteAgentDir("foo/bar")).toBeNull(); // relative
    expect(sanitizeRemoteAgentDir("~/../etc")).toBeNull(); // traversal
    expect(sanitizeRemoteAgentDir("../x")).toBeNull();
  });

  it("rejects empty / whitespace / undefined", () => {
    expect(sanitizeRemoteAgentDir(undefined)).toBeNull();
    expect(sanitizeRemoteAgentDir("")).toBeNull();
    expect(sanitizeRemoteAgentDir("   ")).toBeNull();
  });
});

describe("remoteAgentDir", () => {
  const home = "/home/lc";

  it("defaults to ~/.pi/agent", () => {
    expect(remoteAgentDir({}, home)).toBe("/home/lc/.pi/agent");
  });

  it("expands ~/ against the remote home", () => {
    expect(remoteAgentDir({ agentDir: "~/pipi-zhangsan/agent" }, home)).toBe("/home/lc/pipi-zhangsan/agent");
  });

  it("maps bare ~ to the home dir", () => {
    expect(remoteAgentDir({ agentDir: "~" }, home)).toBe("/home/lc");
  });

  it("keeps absolute paths verbatim", () => {
    expect(remoteAgentDir({ agentDir: "/opt/pipi/agent" }, home)).toBe("/opt/pipi/agent");
  });

  it("matches the shell-side expansion used in spawn commands", () => {
    // The export uses `export PI_CODING_AGENT_DIR=~/pipi-x/agent;` — bash
    // expands ~ at assignment time to $HOME, identical to remoteAgentDir.
    const agentDir = "~/pipi-x/agent";
    const shellExpanded = "/home/lc/pipi-x/agent";
    expect(remoteAgentDir({ agentDir }, home)).toBe(shellExpanded);
  });
});

describe("buildRemoteKey distinguishes agentDir", () => {
  const base = { host: "srv", user: "root", port: 22 };
  it("produces different keys when only agentDir differs", () => {
    expect(buildRemoteKey({ ...base, agentDir: "~/pi-a/agent" })).not.toBe(buildRemoteKey({ ...base, agentDir: "~/pi-b/agent" }));
    expect(buildRemoteKey({ ...base, agentDir: "~/pi-a/agent" })).not.toBe(buildRemoteKey(base));
  });
  it("keeps same key for same agentDir", () => {
    expect(buildRemoteKey({ ...base, agentDir: "~/pi-a/agent" })).toBe(buildRemoteKey({ ...base, agentDir: "~/pi-a/agent" }));
    expect(buildRemoteKey(base)).toBe(buildRemoteKey(base));
  });
});
