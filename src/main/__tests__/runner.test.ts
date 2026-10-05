// runner — the spawn contract every transport binding delegates to.
//
// The contract that matters: runCommand NEVER throws and never rejects. Its
// callers are provisioning steps sitting inside the tab:create IPC handler, so a
// throw there aborts tab creation before the UI is told about the new tab. The
// mocked spawn is what lets us assert the synchronous-throw path (ENAMETOOLONG)
// without needing a 32KB command line or a real host.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { runCommand, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } = await import("../runner");

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

const spec = (extra: Partial<Parameters<typeof runCommand>[0]> = {}) => ({
  bin: "some-bin",
  argv: ["-x", "sh -s"],
  notFound: "some-bin not found",
  ...extra,
});

/** Streams deliver 'data' on a later tick than the write, so a synchronous
 *  `emit("close")` would race the output we are asserting on. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  spawnMock.mockReset();
});

describe("runCommand", () => {
  it("spawns the given bin and argv and reports stdout/stderr", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runCommand(spec());
    child.stdout.write("out\n");
    child.stderr.write("warn\n");
    await tick();
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ ok: true, code: 0, stdout: "out\n", stderr: "warn\n" });
    const [bin, argv, options] = spawnMock.mock.calls[0] as SpawnCall;
    expect(bin).toBe("some-bin");
    expect(argv).toEqual(["-x", "sh -s"]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("feeds the payload to stdin byte-for-byte, never through argv", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const received: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => received.push(chunk));
    child.stdin.on("end", () => {
      child.stdout.write("installed\n");
      void tick().then(() => child.emit("close", 0));
    });

    const payload = `#!/bin/sh\necho ${"QUJD".repeat(50_000)} | base64 -d > f\n`;
    const result = await runCommand(spec({ stdin: payload }));

    expect(result).toMatchObject({ ok: true, code: 0, stdout: "installed\n" });
    expect(Buffer.concat(received).toString("utf8")).toBe(payload);
    const [, argv, options] = spawnMock.mock.calls[0] as SpawnCall;
    // stdio[0] must be a pipe — that is the whole point of the split.
    expect(options.stdio[0]).toBe("pipe");
    expect(argv.join(" ")).not.toContain("QUJDQUJD");
  });

  it("leaves stdin closed when no payload is given", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runCommand(spec());
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

    const result = await runCommand(spec({ stdin: "x".repeat(400_000) }));

    expect(result.ok).toBe(false);
    expect(result.code).toBeNull();
    expect(result.error).toContain("ENAMETOOLONG");
  });

  it("reports a missing binary with the label the binding supplied", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runCommand(spec({ argv: ["--version"], notFound: "wsl not found" }));
    child.emit("error", Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" }));
    await expect(promise).resolves.toMatchObject({ ok: false, error: "wsl not found" });
  });

  it("kills the process and reports a timeout, keeping what was captured", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child); // never closes
    const promise = runCommand(spec({ timeoutMs: 20 }));
    child.stdout.write("partial");
    await tick();
    const result = await promise;
    expect(child.killed).toBe(true);
    expect(result).toMatchObject({ ok: false, code: null, error: "timeout", stdout: "partial" });
  });

  it("surfaces a non-zero exit with its stderr", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runCommand(spec({ stdin: "x" }));
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
    const promise = runCommand(spec({ maxOutputBytes: 10 }));
    child.stdout.write("y".repeat(1000));
    await tick();
    child.emit("close", 0);
    expect((await promise).stdout).toHaveLength(10);
  });

  it("ignores a stdin EPIPE from a remote that already exited", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runCommand(spec({ stdin: "x".repeat(1000) }));
    child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    child.emit("close", 1);
    await expect(promise).resolves.toMatchObject({ ok: false, code: 1 });
  });

  it("defaults the timeout and the output clamp to bounded values", () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });
});
