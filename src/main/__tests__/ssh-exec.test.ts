// ssh-exec — the argv/stdin split and the failure contract.
//
// The contract that matters: runSshCommand NEVER throws and never rejects.
// Provisioning is best-effort and its callers sit inside the tab:create IPC
// handler, so a throw there aborts tab creation before the UI is told about the
// new tab. The mocked spawn below is what lets us assert the synchronous-throw
// path (ENAMETOOLONG) without needing a 32KB command line or a real host.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { runSshCommand, sshArgv, SSH_OPTS, DEFAULT_SSH_TIMEOUT_MS } = await import("../ssh-exec");

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type SpawnCall = [string, string[], { stdio: string[] }];

const REMOTE = { host: "example.test", user: "deploy" };

/** Streams deliver 'data' on a later tick than the write, so a synchronous
 *  `emit("close")` would race the output we are asserting on. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  spawnMock.mockReset();
});

describe("sshArgv", () => {
  it("pins the interactive-hang guards and defaults the port to 22", () => {
    expect(sshArgv(REMOTE, "sh -s")).toEqual([...SSH_OPTS, "-p", "22", "deploy@example.test", "sh -s"]);
    expect(SSH_OPTS).toContain("BatchMode=yes");
    expect(SSH_OPTS).toContain("StrictHostKeyChecking=accept-new");
  });

  it("honours an explicit port and passes the command as the last argument", () => {
    const argv = sshArgv({ ...REMOTE, port: 2222 }, "uptime");
    expect(argv.at(-1)).toBe("uptime");
    expect(argv).toContain("2222");
  });

  it("does not grow with the payload — the payload is never in the argv", () => {
    const argv = sshArgv(REMOTE, "sh -s");
    expect(argv.join(" ").length).toBeLessThan(128);
    expect(argv.join(" ")).not.toContain("QUJDQUJD");
  });
});

describe("runSshCommand", () => {
  it("feeds the payload to stdin byte-for-byte and reports stdout", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const received: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => received.push(chunk));
    child.stdin.on("end", () => {
      child.stdout.write("installed\n");
      void tick().then(() => child.emit("close", 0));
    });

    const payload = `#!/bin/sh\necho ${"QUJD".repeat(50_000)} | base64 -d > f\n`;
    const result = await runSshCommand({ remote: REMOTE, command: "sh -s", stdin: payload });

    expect(result).toMatchObject({ ok: true, code: 0, stdout: "installed\n" });
    expect(Buffer.concat(received).toString("utf8")).toBe(payload);
    const [bin, argv, options] = spawnMock.mock.calls[0] as SpawnCall;
    expect(bin).toBe(process.platform === "win32" ? "ssh.exe" : "ssh");
    // stdio[0] must be a pipe — that is the whole point of the split.
    expect(options.stdio[0]).toBe("pipe");
    expect(argv.join(" ")).not.toContain("QUJDQUJD");
  });

  it("leaves stdin closed when no payload is given", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runSshCommand({ remote: REMOTE, command: "uptime" });
    child.stdout.write("up\n");
    await tick();
    child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ ok: true, stdout: "up\n" });
    expect((spawnMock.mock.calls[0] as SpawnCall)[2].stdio[0]).toBe("ignore");
  });

  // THE regression: spawn throws SYNCHRONOUSLY when the command line exceeds
  // Windows' 32,767-char CreateProcess limit. The old provisioning built exactly
  // such a command line (35,367 chars with pipi-approval-gate.ts included), and
  // because that call sat in the tab:create handler the throw escaped it.
  it("turns a synchronous spawn failure (ENAMETOOLONG) into ok:false", async () => {
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });
    });

    const result = await runSshCommand({ remote: REMOTE, command: "sh -s", stdin: "x".repeat(400_000) });

    expect(result.ok).toBe(false);
    expect(result.code).toBeNull();
    expect(result.error).toContain("ENAMETOOLONG");
  });

  it("reports a missing ssh binary rather than an unhandled error event", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runSshCommand({ remote: REMOTE, command: "uptime" });
    child.emit("error", Object.assign(new Error("spawn ssh.exe ENOENT"), { code: "ENOENT" }));
    await expect(promise).resolves.toMatchObject({ ok: false, error: "ssh not found" });
  });

  it("kills the process and reports a timeout", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child); // never closes
    const result = await runSshCommand({ remote: REMOTE, command: "uptime", timeoutMs: 20 });
    expect(child.killed).toBe(true);
    expect(result).toMatchObject({ ok: false, code: null, error: "timeout" });
  });

  it("surfaces a non-zero exit with its stderr", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runSshCommand({ remote: REMOTE, command: "sh -s", stdin: "x" });
    child.stderr.write("sh: base64: not found\n");
    await tick();
    child.emit("close", 127);
    const result = await promise;
    expect(result).toMatchObject({ ok: false, code: 127, error: "exit 127" });
    expect(result.stderr).toContain("base64: not found");
  });

  it("truncates runaway output instead of growing without bound", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runSshCommand({ remote: REMOTE, command: "uptime", maxOutputBytes: 10 });
    child.stdout.write("y".repeat(1000));
    await tick();
    child.emit("close", 0);
    expect((await promise).stdout).toHaveLength(10);
  });

  it("ignores a stdin EPIPE from a remote that already exited", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runSshCommand({ remote: REMOTE, command: "sh -s", stdin: "x".repeat(1000) });
    child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    child.emit("close", 1);
    await expect(promise).resolves.toMatchObject({ ok: false, code: 1 });
  });

  it("defaults the timeout to a bounded value", () => {
    expect(DEFAULT_SSH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
