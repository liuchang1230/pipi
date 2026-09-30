/**
 * ssh-exec.ts — run ONE remote shell command through the system ssh client,
 * with the payload on stdin.
 *
 * ## Why the payload cannot travel in argv
 *
 * `child_process.spawn` on Windows funnels through CreateProcess, whose command
 * line is capped at 32,767 characters. Past that limit Node does **not** emit an
 * 'error' event — it throws ENAMETOOLONG **synchronously** from `spawn()`, so the
 * failure surfaces as an exception in whoever called it.
 *
 * That is not hypothetical: embedding every shipped extension as base64 in the
 * ssh command line produced a 35,367-character argv once pipi-approval-gate.ts
 * (17.6KB) joined the set (the other four together are only ~12KB of base64), so
 * `syncKeyAuthExtensions` threw inside the `tab:create` IPC handler on every
 * key-auth remote connect — *before* emitTabs()/emitActive() ran.
 *
 * Hence the rule these helpers exist to enforce: **argv carries only the tiny,
 * content-free command (`sh -s`); anything that scales with content travels on
 * stdin**, which has no such limit. One place builds the argv, one place feeds
 * stdin, one place owns the timeout, and no code path throws at the caller
 * (provisioning is best-effort by contract — it must never break a tab).
 */
import { spawn } from "node:child_process";

export interface SshTarget {
  host: string;
  user: string;
  /** Default 22. */
  port?: number | null;
}

export interface SshRunOptions {
  remote: SshTarget;
  /** Remote command line. Keep it SMALL and content-free — see the module header. */
  command: string;
  /** Payload for the remote command's stdin (a shell script, a tar, …). Omit for none. */
  stdin?: string;
  /** Default DEFAULT_SSH_TIMEOUT_MS; the process is killed when it expires. */
  timeoutMs?: number;
  /** Override the ssh binary (the app resolves it once via findSshBin()). */
  sshBin?: string;
  /** Captured output is truncated past this — a remote can stream forever. */
  maxOutputBytes?: number;
}

export interface SshRunResult {
  ok: boolean;
  /** Process exit code, or null when it never ran / was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it failed: "spawn failed: …", "timeout", "ssh not found", "exit 1". */
  error?: string;
}

export const DEFAULT_SSH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
export const DEFAULT_SSH_BIN = process.platform === "win32" ? "ssh.exe" : "ssh";

/**
 * BatchMode=yes: a server that genuinely needs a password fails fast instead of
 * hanging on an invisible prompt. accept-new trusts a first-seen host key (a
 * known_hosts prompt would also hang) without weakening later key changes.
 */
export const SSH_OPTS: readonly string[] = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "StrictHostKeyChecking=accept-new",
];

/** The argv an ssh invocation gets. Exported so tests can assert its SHAPE —
 *  in particular that it does not grow with the payload. */
export function sshArgv(remote: SshTarget, command: string): string[] {
  return [...SSH_OPTS, "-p", String(remote.port ?? 22), `${remote.user}@${remote.host}`, command];
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "ENOENT") return "ssh not found";
    const message = error instanceof Error ? error.message : "";
    return `${code}${message ? `: ${message}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Bounded stdout/stderr accumulation. */
function collector(max: number): { add(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let length = 0;
  return {
    add(chunk: Buffer): void {
      if (length >= max) return;
      const room = max - length;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      length += kept.length;
    },
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

/**
 * Run `command` on `remote`, feeding `stdin` to it. Never rejects and never
 * throws: every failure (missing ssh, unreachable host, timeout, non-zero exit)
 * comes back as `ok: false` plus a reason, because the callers here are
 * background provisioning steps that must not take a tab down with them.
 */
export function runSshCommand(opts: SshRunOptions): Promise<SshRunResult> {
  const { remote, command, stdin } = opts;
  const sshBin = opts.sshBin ?? DEFAULT_SSH_BIN;
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<SshRunResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: SshRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sshBin, sshArgv(remote, command), {
        windowsHide: true,
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // ENAMETOOLONG and friends land here, synchronously. See the module header.
      settle({ ok: false, code: null, stdout: "", stderr: "", error: describe(error) });
      return;
    }

    const out = collector(max);
    const err = collector(max);
    child.stdout?.on("data", (chunk: Buffer) => out.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.add(chunk));

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      settle({ ok: false, code: null, stdout: out.text(), stderr: err.text(), error: "timeout" });
    }, opts.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS);

    child.on("error", (error: unknown) => {
      settle({ ok: false, code: null, stdout: "", stderr: "", error: describe(error) });
    });

    child.on("close", (code: number | null) => {
      settle({
        ok: code === 0,
        code,
        stdout: out.text(),
        stderr: err.text(),
        ...(code === 0 ? {} : { error: `exit ${code}` }),
      });
    });

    if (stdin !== undefined && child.stdin) {
      // A remote that exits early (bad command, dead link) resets the pipe; that
      // EPIPE must not surface as an unhandled error in a best-effort write.
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin, "utf8");
    }
  });
}
