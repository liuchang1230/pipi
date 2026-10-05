/**
 * ssh2-exec.ts — run ONE command on a **password-authenticated** server through
 * the `ssh2` library, instead of the system ssh client.
 *
 * Why a second ssh binding exists at all: ssh.exe can only do key auth without a
 * TTY (`BatchMode=yes` fails fast rather than prompting into a pipe), so the
 * password path has always gone through the library. Same `CommandRunner`
 * contract as `ssh-exec.ts` / `wsl-exec.ts` — the difference is only transport:
 *
 * - `conn.exec(command)` hands the text to the server's login shell, exactly like
 *   ssh.exe's trailing argv does, so a caller's command bytes are identical
 *   whichever binding it gets.
 * - `tryKeyboard: true` + a `keyboard-interactive` handler that answers every
 *   prompt with the stored password: servers configured for
 *   `KbdInteractiveAuthentication` never reach the `password` method.
 * - `hostVerifier: () => true` matches rpc-session.ts's ssh2 transport (the app
 *   connects to whatever host the user typed, TOFU-style).
 *
 * Never rejects and never throws: every failure (auth refused, unreachable host,
 * timeout, non-zero exit) comes back as `ok: false` plus a reason, because the
 * callers are background provisioning steps that must not take a tab down.
 * Decision record: `docs/adr/0007-pi-runtime-seam.md`.
 */
import { Client as SshClient } from "ssh2";
import { createOutputCollector, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, type RunOptions, type RunResult } from "./runner";

/** 密码认证所需的全部信息（与 `ssh-exec` 的 `SshTarget` 同形，多一个 password）。 */
export interface Ssh2Target {
  host: string;
  user: string;
  /** 默认 22。 */
  port?: number | null;
  password?: string | null;
}

export interface Ssh2RunOptions extends RunOptions {
  remote: Ssh2Target;
  /** 覆盖默认值 15s（连接 + 认证）。 */
  connectTimeoutMs?: number;
  /** 抓到的输出超过这个长度就截断。 */
  maxOutputBytes?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 在 `remote` 上跑 `command`。与另两个绑定同契约：永不 reject、永不抛。 */
export function runSsh2Command(opts: Ssh2RunOptions): Promise<RunResult> {
  const { remote, command } = opts;
  const password = remote.password ?? "";
  const out = createOutputCollector(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const err = createOutputCollector(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

  return new Promise<RunResult>((resolve) => {
    const conn = new SshClient();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const failed = (error: string): void =>
      settle({ ok: false, code: null, stdout: out.text(), stderr: err.text(), error });

    timer = setTimeout(() => failed("timeout"), opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

    conn.on("error", (error: Error) => failed(message(error)));

    conn.once("ready", () => {
      conn.exec(command, (error, stream) => {
        if (error) {
          failed(message(error));
          return;
        }
        stream.on("data", (chunk: Buffer) => out.add(chunk));
        stream.stderr.on("data", (chunk: Buffer) => err.add(chunk));
        // 既接住错误（被 settle 后重入也不会冒成未处理错误），也负责提前退出时
        // 重置管道产生的 EPIPE。
        stream.on("error", (streamError: Error) => failed(message(streamError)));
        stream.once("close", (code?: number) => {
          const exit = code ?? null;
          settle({
            ok: exit === 0,
            code: exit,
            stdout: out.text(),
            stderr: err.text(),
            ...(exit === 0 ? {} : { error: `exit ${exit ?? "signal"}` }),
          });
        });
        // 载荷走 channel stdin（长度不受 argv 限制），写完即关。
        if (opts.stdin !== undefined) stream.end(opts.stdin);
      });
    });

    conn.on("keyboard-interactive", (_name: string, _instructions: string, _lang: string, prompts: unknown[], finish: (answers: string[]) => void) => {
      finish(prompts.map(() => password));
    });

    try {
      conn.connect({
        host: remote.host,
        port: remote.port ?? 22,
        username: remote.user,
        password,
        tryKeyboard: true,
        hostVerifier: () => true,
        readyTimeout: opts.connectTimeoutMs ?? 15_000,
      });
    } catch (error) {
      failed(message(error));
    }
  });
}
