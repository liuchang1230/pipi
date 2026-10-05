// ssh2-exec — the password-authenticated binding of CommandRunner.
//
// The point of these tests is that the SSH transport details the hand-rolled
// version used to own (auth, keyboard-interactive, channel lifecycle, timeout)
// are now behind the SAME contract as ssh-exec/wsl-exec, so a caller's command
// bytes cannot depend on which credential the target happens to use.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The mock registry has to be reachable from both the factory and the test, so
// it lives in the mocked module itself and is read back after import.
vi.mock("ssh2", async () => {
  const { EventEmitter: Emitter } = await import("node:events");

  class FakeStream extends Emitter {
    stderr = new Emitter();
    endedWith: string | undefined;
    end(payload?: string): void {
      this.endedWith = payload;
    }
  }

  class FakeClient extends Emitter {
    options: Record<string, unknown> | undefined;
    commands: string[] = [];
    streams: FakeStream[] = [];
    execError: Error | undefined;
    ended = false;
    constructor(public registry: FakeClient[] = []) {
      super();
    }
    connect(options: Record<string, unknown>): void {
      this.options = options;
    }
    exec(command: string, callback: (error: Error | undefined, stream: FakeStream) => void): void {
      this.commands.push(command);
      const stream = new FakeStream();
      this.streams.push(stream);
      callback(this.execError, stream);
    }
    end(): void {
      this.ended = true;
    }
  }

  const clients: FakeClient[] = [];
  class TrackingClient extends FakeClient {
    constructor() {
      super();
      clients.push(this);
    }
  }
  return { Client: TrackingClient, __clients: clients };
});

const { runSsh2Command } = await import("../ssh2-exec");
const ssh2 = (await import("ssh2")) as unknown as { __clients: FakeSshClient[] };

interface FakeStream {
  stderr: EventEmitter;
  emit(event: string, ...args: unknown[]): boolean;
  endedWith: string | undefined;
}

interface FakeSshClient {
  options: Record<string, unknown> | undefined;
  commands: string[];
  streams: FakeStream[];
  execError: Error | undefined;
  ended: boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

const REMOTE = { host: "example.test", user: "deploy", password: "s3cret" };

/** The command text pi-version actually hands the binding (one login-shell
 *  wrap), so the assertion is about the bytes a password remote receives. */
const PROBE = `bash -ic 'cd /srv/app && pi --version'`;

const client = (): FakeSshClient => ssh2.__clients[ssh2.__clients.length - 1];

beforeEach(() => {
  ssh2.__clients.length = 0;
});

describe("runSsh2Command", () => {
  it("connects with the stored password, keyboard-interactive enabled, TOFU host key", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE });
    const c = client();
    expect(c.options).toMatchObject({
      host: "example.test",
      port: 22,
      username: "deploy",
      password: "s3cret",
      tryKeyboard: true,
      readyTimeout: 15_000,
    });
    expect((c.options!.hostVerifier as () => boolean)()).toBe(true);
    c.emit("ready");
    c.streams[0].emit("close", 0);
    await promise;
  });

  it("answers every keyboard-interactive prompt with the password", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE });
    const c = client();
    const answers: string[][] = [];
    c.emit("keyboard-interactive", "name", "instructions", "lang", [{}, {}], (a: string[]) => answers.push(a));
    expect(answers).toEqual([["s3cret", "s3cret"]]);
    c.emit("ready");
    c.streams[0].emit("close", 0);
    await promise;
  });

  it("runs the caller's command verbatim and returns its output", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE });
    const c = client();
    c.emit("ready");
    expect(c.commands).toEqual([PROBE]);
    const stream = c.streams[0];
    stream.emit("data", Buffer.from("0.85.1\n"));
    stream.stderr.emit("data", Buffer.from("npm warn\n"));
    stream.emit("close", 0);

    await expect(promise).resolves.toMatchObject({ ok: true, code: 0, stdout: "0.85.1\n", stderr: "npm warn\n" });
    expect(c.ended).toBe(true);
  });

  it("honours an explicit port", async () => {
    const promise = runSsh2Command({ remote: { ...REMOTE, port: 2222 }, command: PROBE });
    expect(client().options).toMatchObject({ port: 2222 });
    client().emit("ready");
    client().streams[0].emit("close", 0);
    await promise;
  });

  it("surfaces a non-zero exit with its stderr (pi missing on the server)", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE });
    const c = client();
    c.emit("ready");
    c.streams[0].stderr.emit("data", Buffer.from("bash: pi: command not found\n"));
    c.streams[0].emit("close", 127);

    const result = await promise;
    expect(result).toMatchObject({ ok: false, code: 127, error: "exit 127" });
    expect(result.stderr).toContain("command not found");
    expect(c.ended).toBe(true);
  });

  it("reports a channel closed by a signal without an exit code", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE });
    const c = client();
    c.emit("ready");
    c.streams[0].emit("close", undefined);
    await expect(promise).resolves.toMatchObject({ ok: false, code: null, error: "exit signal" });
  });

  it("reports an auth/connect failure instead of throwing", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE });
    const c = client();
    c.emit("error", new Error("All configured authentication methods failed"));
    await expect(promise).resolves.toMatchObject({ ok: false, code: null, error: "All configured authentication methods failed" });
    expect(c.ended).toBe(true);
  });

  it("reports an exec failure (channel refused) instead of throwing", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE });
    const c = client();
    c.execError = new Error("open failed");
    c.emit("ready");
    await expect(promise).resolves.toMatchObject({ ok: false, error: "open failed" });
  });

  it("kills the connection on timeout, keeping what was captured", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE, timeoutMs: 20 });
    const c = client();
    c.emit("ready");
    c.streams[0].emit("data", Buffer.from("partial"));
    const result = await promise;
    expect(result).toMatchObject({ ok: false, code: null, error: "timeout", stdout: "partial" });
    expect(c.ended).toBe(true);
  });

  it("feeds stdin on the channel and closes it", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: "sh -s", stdin: "#!/bin/sh\necho hi\n" });
    const c = client();
    c.emit("ready");
    expect(c.streams[0].endedWith).toBe("#!/bin/sh\necho hi\n");
    c.streams[0].emit("close", 0);
    await promise;
  });

  it("truncates runaway output", async () => {
    const promise = runSsh2Command({ remote: REMOTE, command: PROBE, maxOutputBytes: 8 });
    const c = client();
    c.emit("ready");
    c.streams[0].emit("data", Buffer.from("y".repeat(500)));
    c.streams[0].emit("close", 0);
    expect((await promise).stdout).toHaveLength(8);
  });
});
