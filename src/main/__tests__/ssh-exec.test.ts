// ssh-exec — the ssh argv shape and its defaults.
//
// The spawn contract (never throws, stdin split, timeout, clamp, ENOENT label)
// is covered once in runner.test.ts, where its implementation lives. What is
// left to check here is the ssh half: the argv it builds, the binary it picks,
// and that the label wired in is ssh's own.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { runSshCommand, sshArgv, SSH_OPTS, DEFAULT_SSH_BIN } = await import("../ssh-exec");

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  stdoutText = "";
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type SpawnCall = [string, string[], { stdio: string[] }];

const REMOTE = { host: "example.test", user: "deploy" };

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
  it("runs the ssh binary with sshArgv and the payload on stdin", async () => {
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
    expect(bin).toBe(DEFAULT_SSH_BIN);
    expect(argv).toEqual(sshArgv(REMOTE, "sh -s"));
    expect(options.stdio[0]).toBe("pipe");
  });

  it("lets the caller override the ssh binary (findSshBin resolves it once)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runSshCommand({ remote: REMOTE, command: "uptime", sshBin: "C:\\OpenSSH\\ssh.exe" });
    child.stdout.write("up\n");
    await tick();
    child.emit("close", 0);
    await promise;
    expect((spawnMock.mock.calls[0] as SpawnCall)[0]).toBe("C:\\OpenSSH\\ssh.exe");
  });

  it("reports a missing ssh binary rather than an unhandled error event", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runSshCommand({ remote: REMOTE, command: "uptime" });
    child.emit("error", Object.assign(new Error("spawn ssh.exe ENOENT"), { code: "ENOENT" }));
    await expect(promise).resolves.toMatchObject({ ok: false, error: "ssh not found" });
  });
});
