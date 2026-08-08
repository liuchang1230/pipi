/**
 * File-changes view: git working-tree diff over the same three channels as
 * RPC sessions (local node / wsl.exe / ssh2+ssh.exe).
 *
 * - listFileChanges: `git diff HEAD` (tracked) + `git ls-files --others` (untracked)
 * - getFileDiff:     unified diff for one file; untracked files get a full-file
 *                    synthetic diff so they render green in the same viewer.
 * Non-git cwd → `isGit: false` and the renderer falls back to aggregating
 * tool-result diffs from the session event stream.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client as SshClient } from "ssh2";
import { findWslBin } from "./pty";
import { getTab, type RemoteOpts } from "./pty";

export interface DiffFileEntry {
  status: string; // M A D R C … (git) or "U" (untracked)
  path: string;
  additions: number;
  deletions: number;
}
export interface FileChangesList {
  isGit: boolean;
  files: DiffFileEntry[];
  error?: string;
}
export interface FileDiffResult {
  diff: string;
  isUntracked: boolean;
  error?: string;
}

const TIMEOUT_MS = 20000;

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function execLocal(file: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* */
      }
    }, TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** bash single-quote escaping (used to build remote/wsl shell command strings). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sshBin(): string {
  const sys = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
  return existsSync(sys) ? sys : "ssh.exe";
}

function execSsh2(remote: RemoteOpts, cmd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const conn = new SshClient();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        conn.end();
      } catch {
        /* */
      }
    }, TIMEOUT_MS);
    const done = (code: number | null, err?: string) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: err !== undefined ? err : stderr });
    };
    conn.on("ready", () => {
      conn.exec(cmd, (e, stream) => {
        if (e) {
          done(null, e.message);
          return;
        }
        stream.setEncoding("utf8");
        stream.on("data", (d: string) => (stdout += d));
        stream.stderr?.setEncoding("utf8");
        stream.stderr?.on("data", (d: string) => (stderr += d));
        stream.on("close", (code: number | undefined) => done(code ?? 0));
      });
    });
    conn.on("error", (e) => done(null, e.message));
    conn.connect({
      host: remote.host,
      port: remote.port ?? 22,
      username: remote.user,
      password: remote.password,
      readyTimeout: 10000,
    });
  });
}

function execRemote(remote: RemoteOpts, cmd: string): Promise<ExecResult> {
  if (remote.password) return execSsh2(remote, cmd);
  // Key auth: system ssh.exe handles ~/.ssh keys + agent (BatchMode → no prompt).
  return execLocal(sshBin(), [
    "-p", String(remote.port ?? 22),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    `${remote.user}@${remote.host}`,
    cmd,
  ]);
}

interface GitCtx {
  kind: "local" | "wsl" | "remote";
  /** git -C dir (undefined → default cwd / home) */
  dir?: string;
  remote?: RemoteOpts;
  wslDistro?: string;
}

function gitCtxFor(tabId: string): GitCtx | null {
  const tab = getTab(tabId);
  if (!tab) return null;
  if (tab.wsl) return { kind: "wsl", dir: tab.wsl.path && tab.wsl.path !== "~" ? tab.wsl.path : undefined, wslDistro: tab.wsl.distro };
  if (tab.remote) return { kind: "remote", dir: tab.remote.path && tab.remote.path !== "~" ? tab.remote.path : undefined, remote: tab.remote };
  return { kind: "local", dir: tab.cwd };
}

async function runGit(ctx: GitCtx, args: string[]): Promise<ExecResult> {
  if (ctx.kind === "local") {
    return execLocal("git", ctx.dir ? ["-C", ctx.dir, ...args] : args);
  }
  if (ctx.kind === "wsl") {
    // wsl.exe passes argv straight through (no shell) → no quoting needed.
    return execLocal(findWslBin(), ["-d", ctx.wslDistro!, ...(ctx.dir ? ["--cd", ctx.dir] : []), "--", "git", ...args]);
  }
  const cmdArgs = ctx.dir ? ["-C", ctx.dir, ...args] : args;
  return execRemote(ctx.remote!, `git ${cmdArgs.map(sq).join(" ")}`);
}

/** List changed files (tracked via `git diff HEAD`, plus untracked). */
export async function listFileChanges(tabId: string): Promise<FileChangesList> {
  const ctx = gitCtxFor(tabId);
  if (!ctx) return { isGit: false, files: [], error: "tab not found" };
  const repo = await runGit(ctx, ["rev-parse", "--git-dir"]);
  if (repo.code !== 0) return { isGit: false, files: [] };

  const [ns, num, untracked] = await Promise.all([
    runGit(ctx, ["-c", "core.quotepath=false", "diff", "HEAD", "--name-status"]),
    runGit(ctx, ["-c", "core.quotepath=false", "diff", "HEAD", "--numstat"]),
    runGit(ctx, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const numMap = new Map<string, { adds: number; dels: number }>();
  for (const line of num.stdout.split(/\r?\n/)) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) {
      numMap.set(m[3]!, {
        adds: m[1] === "-" ? -1 : parseInt(m[1]!, 10),
        dels: m[2] === "-" ? -1 : parseInt(m[2]!, 10),
      });
    }
  }
  const files: DiffFileEntry[] = [];
  for (const line of ns.stdout.split(/\r?\n/)) {
    const m = line.match(/^([MADRCU])\t(.+)$/);
    if (!m) continue;
    const n = numMap.get(m[2]!);
    files.push({ status: m[1]!, path: m[2]!, additions: n?.adds ?? 0, deletions: n?.dels ?? 0 });
  }
  for (const p of untracked.stdout.split(/\r?\n/)) {
    if (p.trim()) files.push({ status: "U", path: p, additions: 0, deletions: 0 });
  }
  return { isGit: true, files };
}

async function readFileContent(ctx: GitCtx, path: string): Promise<string> {
  if (ctx.kind === "local") {
    return readFileSync(join(ctx.dir ?? "", path), "utf8");
  }
  if (ctx.kind === "wsl") {
    const r = await execLocal(findWslBin(), ["-d", ctx.wslDistro!, ...(ctx.dir ? ["--cd", ctx.dir] : []), "--", "cat", path]);
    return r.stdout;
  }
  const r = await execRemote(ctx.remote!, `cat ${sq(path)}`);
  return r.stdout;
}

/** Unified diff for one file; untracked files get a synthetic full-file diff. */
export async function getFileDiff(tabId: string, path: string): Promise<FileDiffResult> {
  const ctx = gitCtxFor(tabId);
  if (!ctx) return { diff: "", isUntracked: false, error: "tab not found" };
  const r = await runGit(ctx, ["-c", "core.quotepath=false", "diff", "HEAD", "--", path]);
  if (r.stdout.trim()) return { diff: r.stdout, isUntracked: false };
  // No tracked diff → untracked?
  const u = await runGit(ctx, ["ls-files", "--others", "--exclude-standard", "--", path]);
  if (!u.stdout.trim()) return { diff: "", isUntracked: false };
  try {
    const content = await readFileContent(ctx, path);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const diff =
      `diff --git a/${path} b/${path}\n` +
      "new file mode 100644\n" +
      `--- /dev/null\n+++ b/${path}\n` +
      `@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((l) => `+${l}`).join("\n") +
      (lines.length ? "\n" : "");
    return { diff, isUntracked: true };
  } catch (e) {
    return { diff: "", isUntracked: true, error: e instanceof Error ? e.message : String(e) };
  }
}
