// ssh-exec against REAL processes — the parts a mock cannot prove: that the
// synchronous ENAMETOOLONG throw really becomes a result, and that a real
// non-zero exit's stderr reaches the caller.
//
// `process.execPath` stands in for ssh: it accepts the same argv shape and fails
// deterministically (node exits 9 on "bad option: -o"), which is exactly what we
// want to observe. No network, no host.
import { describe, expect, it } from "vitest";
import { runSshCommand } from "../ssh-exec";

const REMOTE = { host: "127.0.0.1", user: "nobody" };

describe("runSshCommand (real process)", () => {
  it("returns a result instead of throwing when the command line exceeds the OS limit", async () => {
    const result = await runSshCommand({
      remote: REMOTE,
      sshBin: process.execPath,
      command: "x".repeat(40_000),
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENAMETOOLONG/);
  });

  it("reports a missing binary as 'ssh not found'", async () => {
    const result = await runSshCommand({ remote: REMOTE, sshBin: "pipi-no-such-ssh-binary", command: "sh -s", timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ssh not found");
  });

  it("captures a real exit code and its stderr", async () => {
    const result = await runSshCommand({ remote: REMOTE, sshBin: process.execPath, command: "sh -s", timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(9);
    expect(result.stderr).toContain("bad option");
  });
});
