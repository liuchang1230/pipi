// wsl-exec — the wsl.exe argv shape and its defaults.
//
// Same split as ssh-exec.test.ts: the spawn contract lives in runner.test.ts,
// so this file checks the WSL half — `-d <distro> -- bash -ic <cmd>`, the
// binary, and the wsl-specific "not found" label.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { runWslCommand, wslArgv, DEFAULT_WSL_BIN } = await import("../wsl-exec");

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

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  spawnMock.mockReset();
});

describe("wslArgv", () => {
  it("selects the distro, ends wsl's own options, and uses a login interactive shell", () => {
    expect(wslArgv("Debian", "pi --version")).toEqual(["-d", "Debian", "--", "bash", "-ic", "pi --version"]);
  });

  it("passes the command as the last argument and never grows with a payload", () => {
    const argv = wslArgv("Debian", `bash -ic '${"QUJD".repeat(50_000)}'`);
    expect(argv.slice(0, 5)).toEqual(["-d", "Debian", "--", "bash", "-ic"]);
    expect(argv).toHaveLength(6);
  });
});

describe("runWslCommand", () => {
  it("runs wsl.exe with wslArgv and returns the command's output", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runWslCommand({ distro: "Debian", command: "pi --version" });
    child.stdout.write("0.85.1\n");
    await tick();
    child.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ ok: true, code: 0, stdout: "0.85.1\n" });
    const [bin, argv, options] = spawnMock.mock.calls[0] as SpawnCall;
    expect(bin).toBe(DEFAULT_WSL_BIN);
    expect(argv).toEqual(wslArgv("Debian", "pi --version"));
    expect(options.stdio[0]).toBe("ignore");
  });

  it("lets the caller override the wsl.exe path (findWslBin resolves it once)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runWslCommand({ distro: "Ubuntu", command: "uptime", wslBin: "C:\\Windows\\System32\\wsl.exe" });
    await tick();
    child.emit("close", 0);
    await promise;
    expect((spawnMock.mock.calls[0] as SpawnCall)[0]).toBe("C:\\Windows\\System32\\wsl.exe");
  });

  it("reports a missing wsl.exe with its own label", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runWslCommand({ distro: "Debian", command: "uptime" });
    child.emit("error", Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" }));
    await expect(promise).resolves.toMatchObject({ ok: false, error: "wsl not found" });
  });

  it("surfaces a non-zero exit with its stderr (pi missing inside the distro)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = runWslCommand({ distro: "Debian", command: "pi --version" });
    child.stderr.write("bash: line 1: pi: command not found\n");
    await tick();
    child.emit("close", 127);
    const result = await promise;
    expect(result).toMatchObject({ ok: false, code: 127, error: "exit 127" });
    expect(result.stderr).toContain("command not found");
  });
});
