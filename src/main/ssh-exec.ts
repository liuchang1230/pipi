/**
 * ssh-exec.ts — run ONE remote shell command through the system ssh client,
 * with the payload on stdin.
 *
 * **argv carries only the tiny, content-free command (`sh -s`); anything that
 * scales with content travels on stdin.** Enforcing that split is why this
 * module exists at all: the day the payload went into the ssh command line,
 * the 35,367-char argv made `spawn()` throw ENAMETOOLONG synchronously inside
 * the `tab:create` handler. The full story lives with the implementation
 * (runner.ts, module header).
 *
 * This is the key-auth ssh binding of `CommandRunner` (runner.ts, ADR 0007):
 * it says nothing about *what* it runs — content-sync's `sh -s` scripts and
 * pi's `bash -ic` probes both come through here. What is left here is the ssh
 * argv shape and its defaults; spawn, timeout, output clamp and the failure
 * contract belong to `runCommand()`.
 */
import { runCommand, type RunOptions, type RunResult } from "./runner";

export interface SshTarget {
  host: string;
  user: string;
  /** Default 22. */
  port?: number | null;
}

/** One remote command through the system ssh client. `command` / `stdin` /
 *  `timeoutMs` are the shared runner contract (runner.ts); ssh adds the
 *  destination, the binary and the output clamp. */
export interface SshRunOptions extends RunOptions {
  remote: SshTarget;
  /** Override the ssh binary (the app resolves it once via findSshBin()). */
  sshBin?: string;
  /** Captured output is truncated past this — a remote can stream forever. */
  maxOutputBytes?: number;
}

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

/**
 * Run `command` on `remote`, feeding `stdin` to it. Never rejects and never
 * throws: every failure (missing ssh, unreachable host, timeout, non-zero exit)
 * comes back as `ok: false` plus a reason, because the callers here are
 * background provisioning steps that must not take a tab down with them.
 */
export function runSshCommand(opts: SshRunOptions): Promise<RunResult> {
  return runCommand({
    bin: opts.sshBin ?? DEFAULT_SSH_BIN,
    argv: sshArgv(opts.remote, opts.command),
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    notFound: "ssh not found",
  });
}
