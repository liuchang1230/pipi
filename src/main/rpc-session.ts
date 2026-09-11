/**
 * RPC-backed pi sessions (ChatPane path).
 *
 * Each RPC tab spawns `pi --mode rpc` (headless, JSONL over stdin/stdout)
 * instead of the TUI in a pty. The tab record itself lives in pty.ts's
 * shared registry (registerExternalTab) so getTab/listTabs/active-tracking
 * and session title watchers work unchanged; this module owns the process
 * and the protocol.
 *
 * Transports:
 *  - local:  node <cli.js> --mode rpc (direct spawn, no cmd shim)
 *  - wsl:    wsl.exe -d <distro> -- bash -ic "pi --mode rpc …"
 *  - remote: ssh2 (password auth) or ssh.exe (key auth) pipes
 *
 * Event flow:
 *   pi stdout ──JSONL──> RpcSession ──(parsed event)──> tab:rpc-event:{id}
 *   renderer ──tab:rpc-send──> RpcSession.send(cmd) ──JSONL──> pi stdin
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { BrowserWindow } from "electron";
import { Client as SshClient } from "ssh2";
import { debugLog } from "./debug-log";
import { isSshAuthError } from "./sftp-failure";
import { subagentEnv, subagentShellPrefix } from "./subagent-model";
import {
  closeTab, createTab, getGlobalPiBin, getTab, linkTabSession, markTabRemoteDown, markTabRemoteReady, registerExternalTab, setTabTitle, unregisterExternalTab,
  type CreateTabOptions, type RemoteOpts, type TabInfo, type WslOpts,
} from "./pty";

// --- Transports -------------------------------------------------------------

export interface RpcTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  kill(): void;
  onExit(cb: (code: number) => void): void;
  onStderr(cb: (chunk: string) => void): void;
}

/** Plain child process with pipes (local node, wsl.exe, ssh.exe). */
class ChildProcessTransport implements RpcTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  private proc: ChildProcess;

  constructor(file: string, args: string[], cwd: string | undefined, label: string) {
    this.proc = spawn(file, args, {
      cwd,
      // subagentEnv(): the local `node cli.js --mode rpc` child must carry
      // PI_PROVIDER/PI_MODEL so delegated agents inherit the configured
      // subagent model. (wsl.exe/ssh.exe ignore them; their remote commands
      // get the env via subagentShellPrefix instead.)
      env: { ...process.env, ...subagentEnv() },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    console.log(`[rpc] ${label}: ${file} ${args.join(" ")}`);
    this.stdin = this.proc.stdin!;
    this.stdout = this.proc.stdout!;
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      if (chunk.trim()) console.log(`[rpc:${label}:err] ${chunk.trimEnd().slice(0, 500)}`);
    });
    this.proc.on("error", (err) => {
      console.error(`[rpc] ${label} spawn error:`, err.message);
    });
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
  }

  onExit(cb: (code: number) => void): void {
    this.proc.on("exit", (code) => cb(code ?? -1));
  }

  onStderr(cb: (chunk: string) => void): void {
    this.proc.stderr?.on("data", (chunk: Buffer) => cb(chunk.toString("utf8")));
  }
}

/** SSH channel via ssh2 (password auth — ssh.exe cannot prompt in pipes). */
class Ssh2Transport implements RpcTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  private input = new PassThrough();
  private output = new PassThrough();
  private conn: SshClient;
  private ready = false;
  private exitCb: ((code: number) => void) | null = null;
  private stderrCb: ((chunk: string) => void) | null = null;
  private exitReported = false;

  private reportExit(code: number | undefined): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.exitCb?.(code ?? -1);
  }

  constructor(remote: RemoteOpts, cmd: string, label: string, onAuthFailure?: (message: string) => void) {
    this.stdin = this.input;
    this.stdout = this.output;
    this.conn = new SshClient();
    this.conn.on("ready", () => {
      this.ready = true;
      this.conn.exec(cmd, (err, stream) => {
        if (err) {
          console.error(`[rpc] ${label} exec error:`, err.message);
          this.reportExit(-1);
          return;
        }
        this.input.pipe(stream);
        stream.pipe(this.output);
        stream.stderr.setEncoding("utf8");
        stream.stderr.on("data", (d: string) => {
          if (d.trim()) console.log(`[rpc:${label}:err] ${d.trimEnd().slice(0, 500)}`);
          this.stderrCb?.(d);
        });
        // ssh2 reports the actual remote process status on `exit`; `close`
        // is only a fallback for channels that disappear before an exit event.
        stream.once("exit", (code: number | undefined) => this.reportExit(code));
        stream.once("close", () => this.reportExit(-1));
      });
    });
    // Many servers (PAM configs) authenticate via keyboard-interactive
    // rather than plain "password". OpenSSH clients fall back automatically;
    // the ssh2 lib only tries "password" unless tryKeyboard is set — without
    // it the handshake hangs with ZERO output (the exact "password is right
    // but RPC never connects" symptom). Answer the prompts with the stored
    // password so both auth paths work.
    this.conn.on("keyboard-interactive", (_name, _instructions, _lang, _prompts, finish) => {
      debugLog("rpc", `${label} keyboard-interactive (${_prompts.length} prompts) -> answering with stored password`);
      finish((remote.password ? [remote.password] : []) as string[]);
    });
    this.conn.on("error", (err) => {
      console.error(`[rpc] ${label} ssh error:`, err.message);
      if (isSshAuthError(err)) onAuthFailure?.(err.message);
      this.stderrCb?.(`SSH 连接错误：${err.message}\n`);
      this.reportExit(-1);
    });
    // Transport death must reach the renderer as an exit. ssh2 emits `close`
    // (and often `end`) when the flow dies — a dropped WiFi link, a server-side
    // timeout, keepalive exhaustion — without emitting `error`, so without
    // these two handlers the tab kept reporting itself alive and every later
    // prompt vanished into the void.
    const reportDropped = (why: string) => {
      if (this.exitReported) return;
      console.error(`[rpc] ${label} ssh ${why}`);
      this.stderrCb?.(`SSH 连接已断开（${why}）\n`);
      this.reportExit(-1);
    };
    this.conn.on("end", () => reportDropped("对端关闭"));
    this.conn.on("close", () => reportDropped("网络中断或 keepalive 超时"));
    this.conn.connect({
      host: remote.host,
      port: remote.port ?? 22,
      username: remote.user,
      password: remote.password,
      tryKeyboard: true,
      // Matches the app's ssh.exe StrictHostKeyChecking=accept-new stance.
      hostVerifier: () => true,
      readyTimeout: 20000,
      // Liveness for a long-lived chat session. Without keepalive a NAT /
      // firewall that silently drops the idle TCP flow leaves ssh2 believing
      // the channel is healthy: stdin stays writable, writes land in the local
      // buffer, and NOTHING ever comes back — the renderer sat on
      // "已发送，等待 Pi 开始处理…" for as long as the user waited. 15s × 3
      // unacknowledged probes ≈ 45s to a definitive "connection is gone".
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    });
  }

  kill(): void {
    this.input.end();
    try {
      this.conn.end();
    } catch {
      /* already closed */
    }
  }

  onExit(cb: (code: number) => void): void {
    this.exitCb = cb;
  }

  onStderr(cb: (chunk: string) => void): void {
    this.stderrCb = cb;
  }
}

// --- Process resolution (local pi) -----------------------------------------

function findNodeBin(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, "node.exe");
    if (existsSync(cand)) return cand;
  }
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveCliJs(): string | null {
  const piBin = getGlobalPiBin();
  if (/\.cmd$/i.test(piBin)) {
    try {
      const content = readFileSync(piBin, "utf8");
      const m = content.match(/"([^"]*cli\.js)"/i);
      if (m && existsSync(m[1]!)) return m[1];
    } catch {
      /* fall through */
    }
    const cand = join(dirname(piBin), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Local spawn: node <cli.js> --mode rpc [--session …] [-c] */
function localSpawnPlan(opts: CreateTabOptions): { file: string; args: string[] } {
  const nodeBin = findNodeBin();
  const cliJs = resolveCliJs();
  if (nodeBin && cliJs) {
    const args = [cliJs, "--mode", "rpc"];
    if (opts.sessionPath) args.push("--session", opts.sessionPath);
    else if (opts.continueRecent === true) args.push("-c");
    return { file: nodeBin, args };
  }
  // Fallback: cmd shim.
  const piBin = getGlobalPiBin().replace(/\//g, "\\");
  const args = ["--mode", "rpc"];
  if (opts.sessionPath) args.push("--session", opts.sessionPath);
  else if (opts.continueRecent === true) args.push("-c");
  return { file: "cmd.exe", args: ["/d", "/c", `"${piBin}"`, ...args] };
}

// --- Remote/WSL command builders -------------------------------------------

/** POSIX single-quote escape for ONE shell layer: `'` → `'\''`. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function cdArg(p: string): string {
  if (p === "~") return "~";
  if (p.startsWith("~/")) return `~/${sq(p.slice(2))}`;
  return sq(p);
}

/**
 * `pi --mode rpc [--session …]` for a REMOTE shell. The session path crosses
 * bash -ic layers, so it is base64-encoded (no quotes/metacharacters).
 */
function sessionArg(sessionPath: string): string {
  const b64 = Buffer.from(sessionPath, "utf8").toString("base64");
  return (
    // This string is nested in `bash -ic '…'` for SSH. Base64 has no shell
    // metacharacters, so leave it unquoted: inner single quotes would close
    // the outer command and make every resumed SSH session exit immediately.
    ` export PIPI_S="$(printf %s ${b64} | base64 -d 2>/dev/null || printf %s ${b64} | base64 -D 2>/dev/null)";` +
    // Subagent-model env directly in front of `pi`: the delegated-agent
    // extensions inherit the pi process env, and neither ssh exec nor WSL
    // forwards our Windows env.
    ` ${subagentShellPrefix()}pi --mode rpc \${PIPI_S:+--session "$PIPI_S"}`
  );
}

/** \\wsl$\<distro>\… → Linux path pi expects inside the distro. */
function wslSessionToLinux(distro: string, sessionPath: string): string {
  const prefix = `\\\\wsl$\\${distro}\\`;
  if (sessionPath.startsWith(prefix)) {
    return "/" + sessionPath.slice(prefix.length).replace(/\\/g, "/");
  }
  return sessionPath;
}

// --- Post-boot liveness -----------------------------------------------------

/**
 * A command written to a dead pipe reports success and is never answered: no
 * response frame, no exit event. 90s is far beyond any legitimate pi response
 * (a remote `get_state` answers in ~100ms and even a cold model turn emits
 * stream events continuously), so silence this long means the connection is
 * gone rather than busy.
 */
export const SEND_SILENCE_MS = 90000;

/**
 * "Wrote a command, nothing came back" clock. Pure state machine: the timer
 * only polls it, so the policy is unit-testable without a transport.
 * `take` disarms, so one silence window produces exactly ONE report — a dead
 * tab must not spam the renderer (or the log) every 90s.
 */
export class SilenceWatchdog {
  private since: number | null = null;

  /** Arm on the first write that has no answering byte yet. */
  arm(now: number): void {
    if (this.since === null) this.since = now;
  }

  /** Any byte from pi proves the pipe is alive. */
  noteBytes(): void {
    this.since = null;
  }

  /** Silent duration in ms when the window elapsed (and disarm), else null. */
  take(now: number, limit = SEND_SILENCE_MS): number | null {
    if (this.since === null) return null;
    const elapsed = now - this.since;
    if (elapsed < limit) return null;
    this.since = null;
    return elapsed;
  }
}

// --- Session ----------------------------------------------------------------

let nextRpcId = 1;

export type RpcCommand = Record<string, unknown>;

export interface RpcResponse {
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ExtensionUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  prefill?: string;
  [key: string]: unknown;
}

export type UiRequestHandler = (tabId: string, req: ExtensionUiRequest) => void;

export class RpcSession {
  readonly id: string;
  private transport: RpcTransport;
  private buffer = "";
  private exited = false;
  private pendingResponses = new Set<(r: RpcResponse) => void>();
  /** Zero-output watchdog state (see constructor). */
  private sawOutput = false;
  private noOutputTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last stderr from the remote pi (kept bounded for the exit banner). */
  private lastStderr = "";
  /** Non-JSONL bytes received (e.g. a .bashrc echo or "command not found")
   *  — kept for the stalled-connection diagnosis. */
  private junkLines: string[] = [];
  private responsesSeen = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private firstOutputLogged = false;
  /** "Wrote a command, nothing came back" clock (see SilenceWatchdog). */
  private readonly silence = new SilenceWatchdog();
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once the transport reported a hard authentication failure, so a
   *  later get_state timeout does not overwrite the more specific
   *  "需要登录" state with a generic "failed". */
  authFailed = false;

  private reportAuthFailure(remote: RemoteOpts | undefined, message: string): void {
    if (!remote || this.authFailed) return;
    this.authFailed = true;
    emitRemoteState(remote, "disconnected", true, message || "认证失败：需要密码或密钥未授权");
  }

  constructor(id: string, opts: CreateTabOptions) {
    this.id = id;
    const label = `${opts.remote ? `${opts.remote.user}@${opts.remote.host}` : opts.wsl ? `wsl:${opts.wsl.distro}` : "local"} tab ${id}`;

    if (opts.wsl) {
      const inner = opts.sessionPath
        ? sessionArg(wslSessionToLinux(opts.wsl.distro, opts.sessionPath))
        : `${subagentShellPrefix()}pi --mode rpc`;
      const wslBin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
      const wslCmd = `cd ${cdArg(opts.wsl.path || "~")} && ${inner}`;
      debugLog("rpc", `tab ${id} CMD wsl=${opts.wsl.distro} ${JSON.stringify(wslCmd)}`);
      this.transport = new ChildProcessTransport(
        existsSync(wslBin) ? wslBin : "wsl.exe",
        ["-d", opts.wsl.distro, "--", "bash", "-ic", wslCmd],
        process.cwd(),
        label
      );
    } else if (opts.remote) {
      const r = opts.remote;
      // Pi derives sessions from agentDir/sessions/<encoded-cwd>; do not pass
      // a flat session directory or the app's session index cannot find them.
      const agentDirEnv = r.agentDir ? `export PI_CODING_AGENT_DIR=${r.agentDir}; ` : "";
      const inner = opts.sessionPath ? sessionArg(opts.sessionPath) : `${subagentShellPrefix()}pi --mode rpc`;
      const remoteCmd = `cd ${cdArg(r.path || "~")} && bash -ic '${agentDirEnv}${inner}'`;
      debugLog("rpc", `tab ${id} CMD ssh=${r.user}@${r.host} ${JSON.stringify(remoteCmd)}`);
      if (r.password) {
        this.transport = new Ssh2Transport(r, remoteCmd, label, (msg) => this.reportAuthFailure(r, msg));
      } else {
        // Key auth: system ssh.exe handles ~/.ssh keys + agent, no TTY
        // needed. BatchMode=yes: if the server actually REQUIRES a password
        // (no key accepted), fail fast instead of hanging at an impossible
        // interactive prompt inside pipes (a stuck ssh.exe would make every
        // RPC command time out silently).
        const sshBin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
        this.transport = new ChildProcessTransport(
          existsSync(sshBin) ? sshBin : "ssh.exe",
          [
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=30",
            "-p", String(r.port ?? 22),
            `${r.user}@${r.host}`,
            remoteCmd,
          ],
          process.cwd(),
          label
        );
      }
    } else {
      const plan = localSpawnPlan(opts);
      this.transport = new ChildProcessTransport(plan.file, plan.args, opts.cwd, label);
    }

    this.transport.stdout.setEncoding("utf8");
    this.transport.stdout.on("data", (chunk: string) => {
      this.sawOutput = true;
      if (this.noOutputTimer) {
        clearTimeout(this.noOutputTimer);
        this.noOutputTimer = null;
      }
      if (this.firstOutputLogged === false) {
        this.firstOutputLogged = true;
        debugLog("rpc", `tab ${id} FIRST BYTES: ${JSON.stringify(chunk.slice(0, 80))}`);
      }
      this.noteBytes();
      this.onChunk(chunk);
    });
    this.transport.onExit((code) => {
      // The connection proved by get_state is gone: the tab's server must stop
      // reading "connected" in the sidebar immediately.
      if (opts.remote) {
        // Only announce a failure for a genuine drop. A user-initiated close
        // unregisters the tab first, so the sidebar re-derives "disconnected"
        // from the now-empty tab set — do not paint that server red.
        const stillRegistered = !!getTab(id);
        markTabRemoteDown(id);
        if (stillRegistered) {
          emitRemoteState(opts.remote, "failed", false, "连接已断开（远程会话结束或网络中断）");
        }
      }
      // A key-auth ssh.exe (BatchMode) that failed auth exits non-zero with no
      // stdout and "Permission denied" on stderr — surface it as "需要登录"
      // too, or the tab would just die while the sidebar stayed "连接中".
      if (opts.remote && !this.sawOutput && /permission denied|publickey|no supported authentication/i.test(this.lastStderr)) {
        this.reportAuthFailure(opts.remote, "认证失败：需要密码或密钥未授权");
      }
      console.log(`[rpc] tab ${id} exited: ${code}`);
      debugLog("rpc", `tab ${id} EXIT ${code} stderr=${JSON.stringify(this.lastStderr.trimEnd().slice(-600))}`);
      if (this.noOutputTimer) {
        clearTimeout(this.noOutputTimer);
        this.noOutputTimer = null;
      }
      this.emitExit(code);
    });
    this.transport.onStderr((chunk) => {
      if (!chunk.trim()) return;
      this.lastStderr = (this.lastStderr + chunk).slice(-4000);
    });
    // Zero-output watchdog: a password remote whose auth/exec stalls (wrong
    // password hangs in ssh2, bash -ic blocks on a slow .bashrc, pi missing)
    // produces NOT A SINGLE BYTE and never answers any command — the renderer
    // would otherwise spin forever. 40s is generous (remote pi boots 15-20s).
    this.noOutputTimer = setTimeout(() => {
      this.noOutputTimer = null;
      if (this.exited || this.sawOutput) return;
      console.error(`[rpc] tab ${id} produced no output in 40s — auth/exec stalled`);
      const stderrTail = this.lastStderr.trimEnd().slice(-400);
      debugLog("rpc", `tab ${id} NO-OUTPUT-40s stderr=${JSON.stringify(stderrTail)}`);
      forwardEvent(id, { type: "rpc_no_output", seconds: 40, stderr: stderrTail });
    }, 40000);
    // Stalled-connection diagnosis: bytes ARE flowing but pi never answers
    // (login shell stuck in .bashrc under pipes, or pi booted into an
    // unresponsive state). 60s, checked once; the junk lines tell us whether
    // it's the shell (non-JSONL echo) or pi itself.
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.exited || this.responsesSeen > 0) return;
      console.error(`[rpc] tab ${id} no JSONL response in 60s (sawOutput=${this.sawOutput}) junk=${JSON.stringify(this.junkLines)}`);
      debugLog("rpc", `tab ${id} STALLED-60s sawOutput=${this.sawOutput} junk=${JSON.stringify(this.junkLines)}`);
      forwardEvent(id, { type: "rpc_stalled", sawOutput: this.sawOutput, junkLines: this.junkLines });
    }, 60000);
    debugLog("rpc", `tab ${id} SPAWNED ${label} (password=${!!opts.remote?.password} wsl=${!!opts.wsl} sessionPath=${opts.sessionPath ?? "-"})`);
  }

  /** Send a command (JSONL to stdin). Returns false if the process is gone. */
  send(cmd: RpcCommand): boolean {
    if (this.exited || !this.transport.stdin.writable) {
      debugLog("rpc", `tab ${this.id} SEND ${String(cmd.type)} DROPPED (exited=${this.exited} writable=${this.transport.stdin.writable})`);
      return false;
    }
    debugLog("rpc", `tab ${this.id} SEND ${String(cmd.type)}${cmd.id ? ` id=${String(cmd.id)}` : ""}`);
    this.transport.stdin.write(JSON.stringify(cmd) + "\n");
    this.armSilenceWatchdog();
    return true;
  }

  /** Any byte from pi proves the pipe is alive: cancel the silence probe. */
  private noteBytes(): void {
    this.silence.noteBytes();
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /**
   * Post-boot liveness: a command written while the pipe is dead (silently
   * dropped TCP, wedged remote process) reports `writable === true` and then
   * NOTHING comes back — no response frame, no exit event. The boot-time
   * watchdogs above stop applying the moment pi speaks, so this one covers the
   * whole session; `SilenceWatchdog` owns the policy.
   */
  private armSilenceWatchdog(): void {
    this.silence.arm(Date.now());
    if (this.silenceTimer) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.exited) return;
      const silentMs = this.silence.take(Date.now());
      if (silentMs === null) return;
      console.error(`[rpc] tab ${this.id} no bytes for ${Math.round(silentMs / 1000)}s after a command — connection presumed dead`);
      debugLog("rpc", `tab ${this.id} UNRESPONSIVE ${Math.round(silentMs / 1000)}s stderr=${JSON.stringify(this.lastStderr.trimEnd().slice(-400))}`);
      forwardEvent(this.id, {
        type: "rpc_unresponsive",
        silentMs,
        stderr: this.lastStderr.trimEnd().slice(-400),
      });
    }, SEND_SILENCE_MS);
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.transport.kill();
  }

  /** One-shot awaiter for a response (keyed by id or command). */
  request<T = unknown>(cmd: RpcCommand, timeoutMs = 15000): Promise<RpcResponse & { data?: T }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(handler);
        const timedOut: RpcResponse = { id: cmd.id as string | undefined, command: cmd.type as string, success: false, error: "timeout" };
        resolve(timedOut as RpcResponse & { data?: T });
      }, timeoutMs);
      const handler = (r: RpcResponse) => {
        if (cmd.id !== undefined && r.id !== cmd.id) return;
        if (cmd.id === undefined && r.command !== cmd.type) return;
        clearTimeout(timer);
        this.pendingResponses.delete(handler);
        resolve(r as RpcResponse & { data?: T });
      };
      this.pendingResponses.add(handler);
      this.send(cmd);
    });
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.onMessage(msg);
      } catch (e) {
        // Non-JSONL bytes: a .bashrc echo, "command not found", MOTD, etc.
        // Remember a few — they diagnose a stalled connection (pi never
        // started because the login shell is stuck or pi is missing).
        if (this.junkLines.length < 5) this.junkLines.push(line.slice(0, 300));
        console.error(`[rpc] tab ${this.id} bad JSONL line:`, e instanceof Error ? e.message : String(e), line.slice(0, 200));
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === "response") {
      this.responsesSeen++;
      debugLog("rpc", `tab ${this.id} RESP ${String(msg.command)} success=${msg.success}${msg.id ? ` id=${String(msg.id)}` : ""}${msg.error ? ` err=${String(msg.error).slice(0, 120)}` : ""}`);
      this.pendingResponses.forEach((cb) => cb(msg as unknown as RpcResponse));
      forwardEvent(this.id, msg);
      return;
    }
    if (type === "extension_ui_request") {
      onUiRequest?.(this.id, msg as unknown as ExtensionUiRequest);
      return;
    }
    forwardEvent(this.id, msg);
  }

  private emitExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.noteBytes(); // a dead session must not also fire the silence report
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:rpc-exit:${this.id}`, { code, stderr: this.lastStderr.trimEnd().slice(-2000) });
    }
  }
}

// --- Registry ---------------------------------------------------------------

const sessions = new Map<string, RpcSession>();

function forwardEvent(tabId: string, msg: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(`tab:rpc-event:${tabId}`, msg);
  }
}

/** Push a remote connection state the sidebar + login dialog follow. Fired
 *  when the RPC transport CANNOT authenticate, and when pi never answers
 *  (get_state failed) — the "connected" claim must come from pi actually
 *  booting, never from a tab merely existing. */
function emitRemoteState(remote: RemoteOpts, status: "connected" | "failed" | "disconnected", needPassword?: boolean, error?: string): void {
  const remoteKey = `${remote.user}@${remote.host}:${remote.port ?? 22}${remote.agentDir ? `[${remote.agentDir}]` : ""}`;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("remote:status", {
      remoteKey,
      status,
      needPassword: needPassword ?? false,
      error,
      profile: { host: remote.host, user: remote.user, port: remote.port ?? 22, agentDir: remote.agentDir },
    });
  }
}

/** index.ts injects the renderer-forwarder for extension UI requests. */
export let onUiRequest: UiRequestHandler | null = null;
export function setUiRequestHandler(handler: UiRequestHandler): void {
  onUiRequest = handler;
}

export function getRpcSession(id: string): RpcSession | null {
  return sessions.get(id) ?? null;
}

export function listRpcSessions(): RpcSession[] {
  return [...sessions.values()];
}

/** Spawn `pi --mode rpc` (local / wsl / remote) and register the tab. */
export function createRpcTab(opts: CreateTabOptions): string {
  const id = opts.id ?? `rpc-${nextRpcId++}`;
  const remote = opts.remote;
  const wsl = opts.wsl;
  let base: string;
  let title: string;
  if (remote) {
    const remoteBase = (remote.path || "~").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || remote.user;
    base = remoteBase === "~" ? `${remote.user}@${remote.host}` : remoteBase;
  } else if (wsl) {
    base = wsl.distro;
  } else {
    base = opts.cwd.replace(/\\/g, "/").split("/").pop() || opts.cwd;
  }
  const sessionBase = opts.sessionPath?.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/i, "");
  title = opts.title || (opts.sessionPath ? sessionBase || `${base} ↻` : base);

  const tab: TabInfo = {
    id,
    kind: "agent",
    cwd: opts.cwd,
    sessionPath: opts.sessionPath,
    title,
    cols: 80,
    rows: 24,
    remote,
    remoteKey: remote ? `${remote.user}@${remote.host}:${remote.port ?? 22}` : undefined,
    wsl,
    createdAt: Date.now(),
  };
  if (remote) tab.remoteKey = `${remote.user}@${remote.host}:${remote.port ?? 22}${remote.agentDir ? `[${remote.agentDir}]` : ""}`;
  registerExternalTab(tab);
  // App-level boot stage: lets the chat UI show the actual connect phase
  // instead of an opaque spinner (remote pi can take 15-20s to boot).
  forwardEvent(id, { type: "app_phase", phase: "connecting" });

  const session = new RpcSession(id, opts);
  sessions.set(id, session);

  // Link the session file pi created/loaded so title/sidebar stay in sync.
  // Local only: remote session files live on the remote side (SFTP sync owns
  // the sidebar list there); the watcher is a no-op for remote/wsl tabs.
  session.request<{ sessionFile?: string; sessionName?: string; thinkingLevel?: string | null; model?: { id?: string; name?: string; provider?: string } | null }>(
    { type: "get_state" },
    // WSL/remote pi boots slowly (wsl.exe chain + pi startup can take 15-20s).
    remote || wsl ? 40000 : 15000
  ).then((res) => {
    const data = res.data;
    if (!res.success || !data) {
      console.warn(`[rpc] tab ${id} get_state failed:`, res.error ?? "no data");
      // The transport already reported auth failure when that was the cause;
      // otherwise the server is reachable but pi did not answer — red dot.
      if (remote && !session.authFailed) {
        emitRemoteState(remote, "failed", false, "pi 未响应（未安装、启动失败或命令超时）");
      }
      return;
    }
    if (data.sessionFile && !tab.sessionPath) {
      // Remote/WSL included: pi's reported session file lives on the SERVER
      // (or inside the distro) — that path is exactly what the SFTP / ssh /
      // UNC file-read paths need (tree:from-file). The local file watcher is
      // a no-op for remote/wsl tabs, so linking is safe there.
      linkTabSession(id, data.sessionFile);
    }
    if (data.sessionName) setTabTitle(id, data.sessionName);
    forwardEvent(id, { type: "app_phase", phase: "ready" });
    // Genuine connectivity proof: pi booted and answered. Flipping this tab
    // (and its server node) from "connecting" to "connected".
    if (remote) {
      markTabRemoteReady(id);
      emitRemoteState(remote, "connected");
    }
    forwardEvent(id, {
      type: "state_ready",
      model: data.model ?? null,
      sessionName: data.sessionName ?? null,
      thinkingLevel: data.thinkingLevel ?? null,
    });
  });

  return id;
}

/** Close an RPC tab: kill the transport and drop both registries. */
export function closeRpcTab(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.kill();
  sessions.delete(id);
  unregisterExternalTab(id);
  return true;
}

/**
 * RPC → pty fallback: kill the RPC session and respawn pi's TUI in a pty for
 * the SAME tab id, so the renderer keeps its tab identity.
 */
export function switchRpcToTerminal(id: string): string | null {
  const session = sessions.get(id);
  const tab = getTab(id);
  if (!session || !tab) return null;
  session.kill();
  sessions.delete(id);
  return createTab({
    id,
    cwd: tab.cwd,
    sessionPath: tab.sessionPath,
    continueRecent: tab.sessionPath ? undefined : true,
    title: tab.title,
    remote: tab.remote,
    wsl: tab.wsl,
  });
}

/** Close all RPC sessions (app quit). */
export function closeAllRpcSessions(): void {
  for (const id of [...sessions.keys()]) closeRpcTab(id);
}

/**
 * pty → RPC fallback (the reverse of switchRpcToTerminal): kill the pty pi
 * and respawn it headless for the SAME tab id, so the renderer keeps its tab
 * identity. Works for local / wsl / remote pi tabs.
 */
export function switchTerminalToRpc(id: string): string | null {
  const tab = getTab(id);
  if (!tab || !tab.pty) return null;
  if (!tab.sessionPath && !tab.remote && !tab.wsl) {
    // Blank tab: pi may already have created a session file lazily — ask
    // pi itself later; for now continue-recent is the best guess.
  }
  closeTab(id);
  return createRpcTab({
    id,
    cwd: tab.cwd,
    sessionPath: tab.sessionPath,
    continueRecent: tab.sessionPath ? undefined : true,
    title: tab.title,
    remote: tab.remote,
    wsl: tab.wsl,
  });
}
