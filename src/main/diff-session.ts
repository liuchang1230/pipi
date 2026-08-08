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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  /** True when this call lazily ran `git init` + baseline commit. */
  initialized?: boolean;
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

function execLocal(file: string, args: string[], cwd?: string, input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    if (input !== undefined) {
      child.stdin?.on("error", () => {
        /* EPIPE when the remote closes early */
      });
      child.stdin?.write(input, () => child.stdin?.end());
    } else {
      child.stdin?.end();
    }
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

/**
 * Lazily turn a non-git directory into a git repo with a baseline commit,
 * so the changes view has a HEAD to diff against. Inline user config avoids
 * touching the user's global git identity. Best-effort: returns false when
 * git is unavailable (server without git) so the caller falls back.
 */
async function ensureGitBaseline(ctx: GitCtx): Promise<boolean> {
  try {
    const repo = await runGit(ctx, ["rev-parse", "--git-dir"]);
    if (repo.code !== 0) {
      const init = await runGit(ctx, ["init", "-q"]);
      if (init.code !== 0) return false;
    }
    // Baseline .gitignore so heavy junk (node_modules, dist…) stays out of
    // the baseline commit and the diff stays fast.
    if (ctx.kind === "local" && ctx.dir) {
      const giPath = join(ctx.dir, ".gitignore");
      if (!existsSync(giPath)) {
        try {
          writeFileSync(
            giPath,
            "node_modules/\ndist/\nout/\nbuild/\n*.log\n.DS_Store\n",
            "utf8",
          );
        } catch {
          /* best-effort */
        }
      }
    }
    const add = await runGit(ctx, ["add", "-A"]);
    if (add.code !== 0) return true; // repo exists even if staging failed
    const commit = await runGit(ctx, [
      "-c", "user.email=pipi@local",
      "-c", "user.name=pipi",
      "commit", "-qm", "init: pipi baseline",
    ]);
    return true;
  } catch {
    return false;
  }
}

/** List changed files (tracked via `git diff HEAD`, plus untracked). */
export async function listFileChanges(tabId: string): Promise<FileChangesList> {
  const ctx = gitCtxFor(tabId);
  if (!ctx) return { isGit: false, files: [], error: "tab not found" };
  let repo = await runGit(ctx, ["rev-parse", "--git-dir"]);
  let initialized = false;
  if (repo.code !== 0) {
    // Non-git directory: lazily create a baseline repo (only for local/wsl
    // project dirs; remote servers without git fall through).
    initialized = await ensureGitBaseline(ctx);
    if (initialized) repo = await runGit(ctx, ["rev-parse", "--git-dir"]);
  }
  if (repo.code !== 0) return { isGit: false, files: [] };

  // Scope diffs to the tab's cwd (a cwd inside a bigger repo must not list
  // the whole parent repository). `-C cwd` + pathspec "." = this directory.
  const scope = ["--", "."];
  const [ns, num, untracked] = await Promise.all([
    runGit(ctx, ["-c", "core.quotepath=false", "diff", "HEAD", "--name-status", ...scope]),
    runGit(ctx, ["-c", "core.quotepath=false", "diff", "HEAD", "--numstat", ...scope]),
    runGit(ctx, ["ls-files", "--others", "--exclude-standard", ...scope]),
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
  return { isGit: true, files, initialized };
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

/* ===== Version-chain reconstruction ===== */

export interface FileVersion {
  label: string;
  content: string;
}
export interface FileHistoryResult {
  versions: FileVersion[];
  error?: string;
}
export interface FileHistoryEvent {
  type: "edit";
  edits: Array<{ oldText: string; newText: string }>;
}

export interface FileWriteEvent {
  type: "write";
  content: string;
}

export interface FilePatchEvent {
  type: "patch";
  patch: string;
}

export type FileVersionEvent = FileHistoryEvent | FileWriteEvent | FilePatchEvent;
/**
 * Apply a unified patch (subset of git diff output) to content.
 * Hunk: @@ -oldStart[,oldCount] +newStart[,newCount] @@ followed by
 * context lines (leading space), '-' lines and '+' lines.
 */
function applyUnifiedPatch(content: string, patch: string): string | null {
  let lines = content.split("\n");
  const patchLines = patch.split("\n");
  let i = 0;
  while (i < patchLines.length) {
    const line = patchLines[i]!;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = parseInt(m[1]!, 10);
    const oldCount = m[2] ? parseInt(m[2]!, 10) : 1;
    i++;
    const body: string[] = [];
    while (i < patchLines.length && !patchLines[i]!.startsWith("@@")) {
      body.push(patchLines[i]!);
      i++;
    }
    const remove: string[] = [];
    const insert: string[] = [];
    for (const bl of body) {
      if (bl.startsWith("+")) insert.push(bl.slice(1));
      else if (bl.startsWith("-")) remove.push(bl.slice(1));
      else if (bl.startsWith(" ")) {
        remove.push(bl.slice(1));
        insert.push(bl.slice(1));
      }
      // "\ No newline at end of file" and headers are skipped
    }
    const start = oldStart - 1;
    const seg = lines.slice(start, start + oldCount);
    // Verify removed lines appear in order within the segment (tolerant: the
    // patch may contain context beyond the replaced block).
    let k = 0;
    for (const r of remove) {
      while (k < seg.length && seg[k] !== r) k++;
      if (k >= seg.length) return null;
      k++;
    }
    lines = [...lines.slice(0, start), ...insert, ...lines.slice(start + oldCount)];
  }
  return lines.join("\n");
}

/** Rebuild a file's version chain: HEAD (when available) + each session edit. */
export async function getFileHistory(
  tabId: string,
  path: string,
  events: FileVersionEvent[],
): Promise<FileHistoryResult> {
  const ctx = gitCtxFor(tabId);
  if (!ctx) return { versions: [], error: "tab not found" };
  let content: string | null = null;
  // Base: HEAD version (git repo only).
  const head = await runGit(ctx, ["show", `HEAD:${path}`]);
  if (head.code === 0 && head.stdout !== "") {
    content = head.stdout.replace(/\r?\n$/, "");
  }
  const versions: FileVersion[] = [];
  let failed = 0;
  if (content !== null) versions.push({ label: "初始（HEAD）", content });
  else versions.push({ label: "会话前（未知）", content: "" });
  let n = 0;
  for (const ev of events) {
    n++;
    if (content === null) {
      // No base (non-git, new file): a full write event can still anchor.
      if (ev.type === "write") {
        content = ev.content;
        versions.push({ label: `第 ${n} 次写入后`, content });
        continue;
      }
      failed++;
      continue;
    }
    if (ev.type === "edit" && Array.isArray(ev.edits)) {
      let cur = content;
      let ok = true;
      for (const e of ev.edits) {
        const idx = cur.indexOf(e.oldText);
        if (idx < 0) {
          ok = false;
          break;
        }
        cur = cur.slice(0, idx) + e.newText + cur.slice(idx + e.oldText.length);
      }
      if (!ok) {
        failed++;
        continue;
      }
      content = cur;
      versions.push({ label: `第 ${n} 次编辑后`, content });
    } else if (ev.type === "patch") {
      const next = applyUnifiedPatch(content, ev.patch);
      if (next === null) {
        failed++;
        continue;
      }
      content = next;
      versions.push({ label: `第 ${n} 次补丁后`, content });
    } else if (ev.type === "write") {
      content = ev.content;
      versions.push({ label: `第 ${n} 次写入后`, content });
    } else {
      failed++;
    }
  }
  if (failed > 0) console.log(`[diff] ${path}: ${failed}/${events.length} events not applied`);
  return { versions };
}

/** Write content to a file over the tab's channel (used for version rollback). */
export async function rollbackFileContent(
  tabId: string,
  path: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = gitCtxFor(tabId);
  if (!ctx) return { ok: false, error: "tab not found" };
  try {
    if (ctx.kind === "local") {
      writeFileSync(join(ctx.dir ?? "", path), content, "utf8");
      return { ok: true };
    }
    if (ctx.kind === "wsl") {
      const r = await execLocal(
        findWslBin(),
        ["-d", ctx.wslDistro!, ...(ctx.dir ? ["--cd", ctx.dir] : []), "--", "sh", "-c", `cat > ${sq(path)}`],
        undefined,
        content,
      );
      return { ok: r.code === 0, error: r.code === 0 ? undefined : r.stderr.slice(0, 300) };
    }
    if (ctx.kind === "remote" && ctx.remote) {
      const r = await execRemoteWithInput(ctx.remote, `cat > ${sq(path)}`, content);
      return { ok: r.code === 0, error: r.code === 0 ? undefined : r.stderr.slice(0, 300) };
    }
    return { ok: false, error: "unsupported channel" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remote exec with stdin payload (ssh2 or ssh.exe). */
function execRemoteWithInput(remote: RemoteOpts, cmd: string, input: string): Promise<ExecResult> {
  if (remote.password) {
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
          stream.stdin.write(input, () => stream.stdin.end());
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
  // Key auth via ssh.exe: `cat > file` reads stdin.
  return execLocal(
    sshBin(),
    [
      "-p", String(remote.port ?? 22),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      `${remote.user}@${remote.host}`,
      cmd,
    ],
    undefined,
    input,
  );
}

/** Row diff between two contents → unified diff text (simplified LCS). */
export function diffTextOf(a: string, b: string, path = "file"): string {
  const A = a === "" ? [] : a.split("\n");
  const B = b === "" ? [] : b.split("\n");
  // Common prefix/suffix of lines; the middle is replaced wholesale.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const oldMid = A.slice(pre, A.length - suf);
  const newMid = B.slice(pre, B.length - suf);
  if (!oldMid.length && !newMid.length) return "";
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const oldStart = pre + 1;
  const newStart = pre + 1;
  out.push(`@@ -${oldStart},${oldMid.length} +${newStart},${newMid.length} @@`);
  for (const l of oldMid) out.push(`-${l}`);
  for (const l of newMid) out.push(`+${l}`);
  return out.join("\n");
}
