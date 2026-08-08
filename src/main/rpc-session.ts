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
import {
  createTab, getGlobalPiBin, getTab, linkTabSession, registerExternalTab, setTabTitle, unregisterExternalTab,
  type CreateTabOptions, type RemoteOpts, type TabInfo, type WslOpts,
} from "./pty";

// --- Transports -------------------------------------------------------------

export interface RpcTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  kill(): void;
  onExit(cb: (code: number) => void): void;
}

/** Plain child process with pipes (local node, wsl.exe, ssh.exe). */
class ChildProcessTransport implements RpcTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  private proc: ChildProcess;

  constructor(file: string, args: string[], cwd: string | undefined, label: string) {
    this.proc = spawn(file, args, {
      cwd,
      env: process.env,
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

  constructor(remote: RemoteOpts, cmd: string, label: string) {
    this.stdin = this.input;
    this.stdout = this.output;
    this.conn = new SshClient();
    this.conn.on("ready", () => {
      this.ready = true;
      this.conn.exec(cmd, (err, stream) => {
        if (err) {
          console.error(`[rpc] ${label} exec error:`, err.message);
          this.exitCb?.(-1);
          return;
        }
        this.input.pipe(stream);
        stream.pipe(this.output);
        stream.stderr.setEncoding("utf8");
        stream.stderr.on("data", (d: string) => {
          if (d.trim()) console.log(`[rpc:${label}:err] ${d.trimEnd().slice(0, 500)}`);
        });
        stream.on("close", (code: number | undefined) => this.exitCb?.(code ?? 0));
      });
    });
    this.conn.on("error", (err) => {
      console.error(`[rpc] ${label} ssh error:`, err.message);
      this.exitCb?.(-1);
    });
    this.conn.connect({
      host: remote.host,
      port: remote.port ?? 22,
      username: remote.user,
      password: remote.password,
      // Matches the app's ssh.exe StrictHostKeyChecking=accept-new stance.
      hostVerifier: () => true,
      readyTimeout: 20000,
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
    ` export PIPI_S="$(printf %s '${b64}' | base64 -d 2>/dev/null || printf %s '${b64}' | base64 -D 2>/dev/null)";` +
    ` pi --mode rpc \${PIPI_S:+--session "$PIPI_S"}; true`
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

  constructor(id: string, opts: CreateTabOptions) {
    this.id = id;
    const label = `${opts.remote ? `${opts.remote.user}@${opts.remote.host}` : opts.wsl ? `wsl:${opts.wsl.distro}` : "local"} tab ${id}`;

    if (opts.wsl) {
      const inner = opts.sessionPath
        ? sessionArg(wslSessionToLinux(opts.wsl.distro, opts.sessionPath))
        : "pi --mode rpc";
      const wslBin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
      this.transport = new ChildProcessTransport(
        existsSync(wslBin) ? wslBin : "wsl.exe",
        ["-d", opts.wsl.distro, "--", "bash", "-ic", `cd ${cdArg(opts.wsl.path || "~")} && ${inner}`],
        process.cwd(),
        label
      );
    } else if (opts.remote) {
      const r = opts.remote;
      const inner = opts.sessionPath ? sessionArg(opts.sessionPath) : "pi --mode rpc";
      const remoteCmd = `cd ${cdArg(r.path || "~")} && bash -ic '${inner}'`;
      if (r.password) {
        this.transport = new Ssh2Transport(r, remoteCmd, label);
      } else {
        // Key auth: system ssh.exe handles ~/.ssh keys + agent, no TTY needed.
        const sshBin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
        this.transport = new ChildProcessTransport(
          existsSync(sshBin) ? sshBin : "ssh.exe",
          [
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
    this.transport.stdout.on("data", (chunk: string) => this.onChunk(chunk));
    this.transport.onExit((code) => {
      console.log(`[rpc] tab ${id} exited: ${code}`);
      this.emitExit(code);
    });
  }

  /** Send a command (JSONL to stdin). Returns false if the process is gone. */
  send(cmd: RpcCommand): boolean {
    if (this.exited || !this.transport.stdin.writable) return false;
    this.transport.stdin.write(JSON.stringify(cmd) + "\n");
    return true;
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
        console.error(`[rpc] tab ${this.id} bad JSONL line:`, e instanceof Error ? e.message : String(e), line.slice(0, 200));
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === "response") {
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
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(`tab:rpc-exit:${this.id}`, code);
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
  registerExternalTab(tab);

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
      return;
    }
    if (data.sessionFile && !tab.sessionPath && !remote && !wsl) {
      linkTabSession(id, data.sessionFile);
    }
    if (data.sessionName) setTabTitle(id, data.sessionName);
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
