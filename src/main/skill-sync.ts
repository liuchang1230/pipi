/// <reference types="vite/client" />
/**
 * Ship app-bundled skills to <agentHome>/skills/ so every pi spawned by a tab
 * discovers them (pi scans recursively for any dir containing SKILL.md — see
 * pi's docs/skills.md), on the local machine, in WSL, and on remote servers.
 *
 * Skills differ from extensions (extension-sync.ts) in one way that drives the
 * whole design: a skill is a user-facing directory tree the user is invited to
 * edit, so "always overwrite" is not an acceptable policy. The policy is
 * 只读订阅 + 偏离保留:
 *
 *   - the user never edited it → ours, upgrade in place
 *   - the user edited it       → keep their bytes, log it, never overwrite
 *   - we no longer ship it     → delete only if unedited, else keep
 *
 * "Did the user edit it" needs memory, which is what the journal (`.pipi.json`,
 * written next to the installed skills) provides: it records the hash of the
 * bytes we last put there. Without it, our own older version and a user edit
 * are indistinguishable.
 *
 * The split of concerns: planSkillSync/nextJournal are PURE — given what is on
 * disk, the journal, and the bundle, they say what to do. syncSkills executes
 * that plan through an injected SkillIo, and the transports are thin adapters:
 * node fs for local + the \\wsl$ UNC path, SFTP for password remotes, and
 * probe-then-apply shell scripts for key-auth ssh remotes.
 *
 * That last one is not a SkillIo, deliberately: reading a remote file over ssh
 * is one round trip per file, so instead of a per-file `read` it does ONE probe
 * trip that dumps every file we care about, runs the same pure rules here, and
 * sends back one apply trip. It costs one more round trip per changed digest
 * and buys the same "keep what the user edited" promise on passwordless
 * servers as everywhere else.
 *
 * Source of truth: repo-root skills/ (see skills/manifest.json + NOTICE.md),
 * embedded at build time via Vite `?raw` — the same packaging story as
 * extension-sync.ts, so this needs no electron-builder change.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type SftpClient from "ssh2-sftp-client";
import { remoteAgentDir } from "./pty";
import type { SshRunResult } from "./ssh-exec";
import manifestSource from "../../skills/manifest.json?raw";

const AGENT_HOME = join(homedir(), ".pi", "agent");
const SKILLS_DIR = join(AGENT_HOME, "skills");

/** Journal file name — inert to pi, which only discovers dirs holding SKILL.md. */
export const JOURNAL_FILE = ".pipi.json";

export interface ShippedSkillFile {
  /** Path inside the skills dir, e.g. "engineering/wizard/SKILL.md". Always /-separated. */
  relPath: string;
  content: string;
}

interface SkillManifest {
  skills: { name: string; bucket: string; ship: boolean }[];
}

/** The `ship: true` set from skills/manifest.json, parsed at build time. */
export function shippedSkillDirs(manifest: string = manifestSource): string[] {
  const parsed = JSON.parse(manifest) as SkillManifest;
  return parsed.skills.filter((s) => s.ship).map((s) => `${s.bucket}/${s.name}`);
}

/**
 * Every file of every shipped skill, from build-time globs. Keys arrive relative
 * to this module ("../../skills/<bucket>/<name>/<rest>").
 *
 * The patterns are literals because Vite resolves `import.meta.glob` at build
 * time — and they list only the SHIPPED directories, so the six dev-only skills
 * (35.6 KB, 42% of all skill bytes) do not ride along in the installer payload
 * of every release. Two consequences worth knowing:
 *
 * - This list cannot be derived from skills/manifest.json, so it is a second
 *   copy of the ship set; `skill-sync.test.ts` pins the two together by reading
 *   these literals back out of the source.
 * - The filter below stays anyway: it is what makes `ship: false` in the
 *   manifest authoritative if the patterns were ever widened back to `**`.
 */
function collectBundle(): ShippedSkillFile[] {
  const wanted = new Set(shippedSkillDirs());
  const all = import.meta.glob(
    [
      "../../skills/engineering/{code-review,wizard,retro,diagnosing-bugs}/**/*",
      "../../skills/productivity/{handoff,writing-for-agents}/**/*",
    ],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;
  const files: ShippedSkillFile[] = [];
  for (const [key, content] of Object.entries(all)) {
    const relPath = key.replace(/^\.\.\/\.\.\/skills\//, "");
    const dir = relPath.split("/").slice(0, 2).join("/");
    if (!wanted.has(dir)) continue;
    files.push({ relPath, content });
  }
  // Stable order: the generated shell script and the tests both depend on it.
  return files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

export const SHIPPED_SKILL_FILES: ShippedSkillFile[] = collectBundle();

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface SkillJournal {
  version: 1;
  /** relPath → sha256 of the bytes WE wrote there. */
  shipped: Record<string, string>;
  /** relPath → sha256 of what we WANTED to write; the file itself is the user's. */
  diverged: Record<string, string>;
}

export const EMPTY_JOURNAL: SkillJournal = { version: 1, shipped: {}, diverged: {} };

export function parseJournal(text: string | null | undefined): SkillJournal {
  if (!text) return EMPTY_JOURNAL;
  try {
    const parsed = JSON.parse(text) as Partial<SkillJournal>;
    return { version: 1, shipped: parsed.shipped ?? {}, diverged: parsed.diverged ?? {} };
  } catch {
    // A corrupted journal must not stop skills from installing; the worst case
    // is that we treat everything as "not ours" and keep it.
    return EMPTY_JOURNAL;
  }
}

export interface SkillSyncPlan {
  /** Our files to install: absent, already ours, or an upgrade of ours. */
  writes: ShippedSkillFile[];
  /** The user edited these — their bytes stay, we only record the intent. */
  diverged: string[];
  /** We no longer ship these and the user never touched them → delete. */
  retired: string[];
}

/**
 * Decide, for one bundle, what to do with a skills dir — touching nothing.
 * `current` is `relPath → file text` for every path we care about (absent: null).
 *
 *   1. absent, or already identical to ours → write ours
 *   2. differs, but matches the journal → our own older version → write ours
 *   3. differs from both → the user's → keep, do not write
 *
 * Retirement uses the same test: only a file still holding the bytes we
 * recorded may be deleted.
 */
export function planSkillSync(
  current: Record<string, string | null>,
  journal: SkillJournal,
  files: ShippedSkillFile[] = SHIPPED_SKILL_FILES,
): SkillSyncPlan {
  const wanted = new Set(files.map((f) => f.relPath));
  const plan: SkillSyncPlan = { writes: [], diverged: [], retired: [] };

  for (const file of files) {
    const actual = current[file.relPath];
    if (actual == null || actual === file.content || sha256(actual) === journal.shipped[file.relPath]) {
      plan.writes.push(file);
    } else {
      plan.diverged.push(file.relPath);
    }
  }

  for (const relPath of Object.keys(journal.shipped)) {
    if (wanted.has(relPath)) continue;
    const actual = current[relPath];
    if (actual != null && sha256(actual) === journal.shipped[relPath]) plan.retired.push(relPath);
  }
  return plan;
}

/** Fold a plan back into a journal: what we wrote is ours; what we kept is not. */
export function nextJournal(
  plan: SkillSyncPlan,
  previous: SkillJournal,
  files: ShippedSkillFile[] = SHIPPED_SKILL_FILES,
): SkillJournal {
  const shipped: Record<string, string> = {};
  for (const file of files) {
    // A diverged file must NOT be recorded with the new hash: the next launch
    // would then mistake the user's file for our own untouched version.
    if (plan.diverged.includes(file.relPath)) continue;
    shipped[file.relPath] = sha256(file.content);
  }
  const diverged: Record<string, string> = {};
  for (const relPath of plan.diverged) {
    const file = files.find((f) => f.relPath === relPath);
    if (file) diverged[relPath] = sha256(file.content);
  }
  // Remember a divergence that is still on disk but no longer in the bundle
  // (a diverged file under a retired skill), so we never adopt it later.
  for (const [relPath, hash] of Object.entries(previous.diverged)) {
    if (!(relPath in shipped) && !(relPath in diverged) && !plan.retired.includes(relPath)) diverged[relPath] = hash;
  }
  return { version: 1, shipped, diverged };
}

/** Log divergences that are NEWS. A divergence is state, not an event: the full
 *  set is returned every run (a UI lists what it will never upgrade), but a
 *  startup log should not repeat yesterday's line. */
function logDivergences(
  diverged: string[],
  previous: SkillJournal,
  files: ShippedSkillFile[],
  abs: (relPath: string) => string,
): void {
  for (const relPath of diverged) {
    const intent = sha256(files.find((f) => f.relPath === relPath)?.content ?? "");
    if (previous.diverged[relPath] !== intent) console.log(`[skills] keeping ${abs(relPath)}: edited by the user`);
  }
}

/**
 * The only thing a transport has to provide. A missing file is `null`, never a
 * throw — "not there yet" is the normal first-sync state everywhere.
 */
export interface SkillIo {
  read(relPath: string): Promise<string | null>;
  write(relPath: string, content: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

export interface SkillSyncResult {
  written: string[];
  diverged: string[];
  retired: string[];
}

/** Serialized journal, in the one format every writer uses (`+ "\n"`, 2-space). */
const journalText = (journal: SkillJournal): string => `${JSON.stringify(journal, null, 2)}\n`;

/** Read the journal, classify every file, apply the plan, write the journal. */
export async function syncSkills(io: SkillIo, files: ShippedSkillFile[] = SHIPPED_SKILL_FILES): Promise<SkillSyncResult> {
  const previousText = await io.read(JOURNAL_FILE);
  const previous = parseJournal(previousText);
  const relPaths = new Set([
    ...files.map((f) => f.relPath),
    ...Object.keys(previous.shipped),
    ...Object.keys(previous.diverged),
  ]);
  const current: Record<string, string | null> = {};
  for (const relPath of relPaths) current[relPath] = await io.read(relPath);

  const plan = planSkillSync(current, previous, files);
  const written: string[] = [];
  for (const { relPath, content } of plan.writes) {
    if (current[relPath] === content) continue;
    await io.write(relPath, content);
    written.push(relPath);
  }
  for (const relPath of plan.retired) await io.remove(relPath);
  // Write only when the text changed: an unchanged journal IS the steady state,
  // and rewriting it every launch would touch a file for nothing.
  const nextText = journalText(nextJournal(plan, previous, files));
  if (previousText !== nextText) await io.write(JOURNAL_FILE, nextText);
  return { written, diverged: plan.diverged, retired: plan.retired };
}

/** Local file system (and the \\wsl$ UNC path, which is a file system too). */
export function nodeSkillsIo(skillsDir: string): SkillIo {
  const abs = (relPath: string): string => join(skillsDir, ...relPath.split("/"));
  return {
    async read(relPath) {
      try {
        return await readFile(abs(relPath), "utf8");
      } catch {
        return null;
      }
    },
    async write(relPath, content) {
      await mkdir(dirname(abs(relPath)), { recursive: true });
      await writeFile(abs(relPath), content, "utf8");
    },
    async remove(relPath) {
      await rm(abs(relPath), { force: true });
    },
  };
}

/** An already-connected SFTP session (the app's password-remote transport). */
export function sftpSkillsIo(client: SftpClient, skillsDir: string): SkillIo {
  const abs = (relPath: string): string => `${skillsDir}/${relPath}`;
  return {
    async read(relPath) {
      try {
        const data = (await client.get(abs(relPath))) as string | Buffer | undefined;
        if (data === undefined) return null;
        return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      } catch {
        return null; // absent, or unreadable → treat as not ours
      }
    },
    async write(relPath, content) {
      await client.mkdir(posix.dirname(abs(relPath)), true);
      // put() treats a string as a LOCAL path → always hand it a Buffer.
      await client.put(Buffer.from(content, "utf8"), abs(relPath));
    },
    async remove(relPath) {
      await client.delete(abs(relPath), true);
    },
  };
}

/**
 * Synchronous convenience for the local startup path, whose whole point is that
 * the skills exist BEFORE any tab can spawn pi (same contract as
 * ensureShippedExtensions). Uses the same pure plan/rules as syncSkills.
 * `skillsDir` is overridable for tests. Failures are logged, never fatal.
 */
export function ensureShippedSkills(skillsDir = SKILLS_DIR): SkillSyncResult {
  const abs = (relPath: string): string => join(skillsDir, ...relPath.split("/"));
  try {
    const journalPath = abs(JOURNAL_FILE);
    const previousText = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : null;
    const previous = parseJournal(previousText);
    const relPaths = new Set([
      ...SHIPPED_SKILL_FILES.map((f) => f.relPath),
      ...Object.keys(previous.shipped),
      ...Object.keys(previous.diverged),
    ]);
    const current: Record<string, string | null> = {};
    for (const relPath of relPaths) {
      const target = abs(relPath);
      current[relPath] = existsSync(target) ? readFileSync(target, "utf8") : null;
    }

    const plan = planSkillSync(current, previous);
    const written: string[] = [];
    for (const { relPath, content } of plan.writes) {
      if (current[relPath] === content) continue;
      const target = abs(relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      written.push(relPath);
      console.log(`[skills] wrote ${target}`);
    }
    logDivergences(plan.diverged, previous, SHIPPED_SKILL_FILES, abs);
    for (const relPath of plan.retired) {
      rmSync(abs(relPath), { force: true });
      console.log(`[skills] retired ${abs(relPath)}`);
    }
    if (plan.retired.length) pruneEmptyDirs(skillsDir, retireDirCandidates(plan.retired));
    // Same text-only-when-changed rule as the async path: the steady state is a
    // no-op, which is what makes "nothing to report" honest.
    const next = nextJournal(plan, previous);
    const nextText = journalText(next);
    if (previousText !== nextText) writeFileSync(journalPath, nextText, "utf8");
    return { written, diverged: plan.diverged, retired: plan.retired };
  } catch (error) {
    console.error("[skills] sync failed:", error instanceof Error ? error.message : String(error));
    return { written: [], diverged: [], retired: [] };
  }
}

/** Remove directories left empty by a retire, deepest first, never skillsDir itself. */
function pruneEmptyDirs(root: string, relDirs: string[]): void {
  for (const relDir of relDirs) {
    let current = relDir;
    while (current && current !== "." && current !== "/") {
      const abs = join(root, ...current.split("/"));
      try {
        if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs);
        else break;
      } catch {
        break;
      }
      current = posix.dirname(current);
    }
  }
}

/** Every directory a retired file may leave empty, parents included, deepest
 *  first — one shared derivation for the local `rmdir` loop and the remote
 *  `rmdir` lines, so both prune exactly the same set. */
export function retireDirCandidates(relPaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const relPath of relPaths) {
    let current = posix.dirname(relPath);
    while (current && current !== "." && current !== "/") {
      dirs.add(current);
      current = posix.dirname(current);
    }
  }
  return [...dirs].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/**
 * The ARGV half of every key-auth remote skills call — content-free for the
 * same reason as the extensions one (see extension-sync.ts + ssh-exec.ts: a
 * command line that grows with shipped content throws ENAMETOOLONG).
 */
export function buildSshSkillsCommand(): string {
  return "sh -s";
}

/** Marker lines of the probe protocol. Base64 never contains `@`, so a line
 *  starting with `@@` is unambiguous even inside a payload. */
const FILE_MARK = "@@f";
/** Present on the remote but unreadable (no base64, permissions). Its content
 *  is UNKNOWN, which must not be mistaken for "absent" — absent gets written.
 *  The sentinel is a value no file can hold (and no hash of it can match). */
const UNREADABLE_MARK = "@@x";
const JOURNAL_MARK = "@@j";
export const UNREADABLE = "\u0000pipi-unreadable";

/**
 * Round trip 1: print the remote journal and the current bytes of every path we
 * care about, base64ed, with marker lines. `sh -s`, POSIX only, `base64` is
 * already required by the extensions install script.
 */
export function buildSshProbeScript(relPaths: string[]): string {
  const skills = "$HOME/.pi/agent/skills";
  const lines: string[] = [];
  if (relPaths.length > 0) {
    lines.push(
      `for p in ${relPaths.join(" ")}; do`,
      `  f="${skills}/$p"`,
      `  if [ -f "$f" ]; then`,
      `    printf '${FILE_MARK} %s\\n' "$p"`,
      `    base64 "$f" 2>/dev/null || printf '${UNREADABLE_MARK} %s\\n' "$p"`,
      `  fi`,
      `done`,
    );
  }
  lines.push(
    `if [ -f ${skills}/${JOURNAL_FILE} ]; then`,
    `  printf '${JOURNAL_MARK}\\n'`,
    `  base64 ${skills}/${JOURNAL_FILE} 2>/dev/null || true`,
    `fi`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Parse the probe's stdout. A path that is absent from the result was absent on
 * the remote; a path mapped to UNREADABLE exists but could not be read.
 * Unparseable base64 decodes to whatever it decodes to, which is not our
 * content, which is the safe direction (keep it).
 */
export function parseSshProbe(stdout: string): { journal: SkillJournal; files: Record<string, string | null> } {
  const files: Record<string, string | null> = {};
  let journal = EMPTY_JOURNAL;
  let target: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (target === null) return;
    const text = Buffer.from(buffer.join(""), "base64").toString("utf8");
    if (target === JOURNAL_MARK) journal = parseJournal(text);
    else files[target] = text;
    buffer = [];
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(`${FILE_MARK} `)) {
      flush();
      target = line.slice(FILE_MARK.length + 1);
      continue;
    }
    if (line.startsWith(`${UNREADABLE_MARK} `)) {
      flush();
      target = null;
      files[line.slice(UNREADABLE_MARK.length + 1)] = UNREADABLE;
      continue;
    }
    if (line === JOURNAL_MARK) {
      flush();
      target = JOURNAL_MARK;
      continue;
    }
    if (target !== null) buffer.push(line.trim());
  }
  flush();
  return { journal, files };
}

/**
 * Round trip 2: write what the plan says to write, delete what it says to
 * delete, and leave the journal that makes the next run's classification
 * possible. Nothing is written that is already identical, so a steady state
 * costs zero writes.
 */
export function buildSshApplyScript(args: {
  plan: SkillSyncPlan;
  /** What the probe found, so identical files are not rewritten. */
  current: Record<string, string | null>;
  journal: SkillJournal;
  files?: ShippedSkillFile[];
}): string {
  const skills = "$HOME/.pi/agent/skills";
  const writes = args.plan.writes.filter((f) => args.current[f.relPath] !== f.content);
  const dirs = [...new Set(writes.map((f) => posix.dirname(f.relPath)))].sort();
  const lines: string[] = [];
  if (dirs.length > 0) lines.push(`mkdir -p ${dirs.map((d) => `${skills}/${d}`).join(" ")}`);
  for (const { relPath, content } of writes) {
    lines.push(`echo ${Buffer.from(content, "utf8").toString("base64")} | base64 -d > ${skills}/${relPath}`);
  }
  for (const relPath of args.plan.retired) lines.push(`rm -f ${skills}/${relPath}`);
  for (const dir of retireDirCandidates(args.plan.retired)) lines.push(`rmdir ${skills}/${dir} 2>/dev/null || true`);
  // The journal is the whole point of the probe: it is what makes "ours" and
  // "the user's edit" distinguishable on the next connect.
  const journalBlob = Buffer.from(`${JSON.stringify(args.journal, null, 2)}\n`, "utf8").toString("base64");
  lines.push(`mkdir -p ${skills}`, `echo ${journalBlob} | base64 -d > ${skills}/${JOURNAL_FILE}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The key-auth (passwordless) ssh transport: probe, classify with the same pure
 * rules as everywhere else, apply. `run` is injected so the module never
 * depends on ssh-exec at runtime and the tests can drive it with a fake; the
 * caller has already bound the remote and the ssh binary.
 *
 * Retirement needs one extra probe: a path in our journal that is no longer in
 * the bundle has to be READ before it may be deleted, and its content only
 * arrives with a probe that asks for it. That trip happens only in the release
 * where we stop shipping a skill, and a failure there aborts the whole sync —
 * an unreadable retirement candidate is not something to guess about.
 */
export type SshScriptRunner = (options: {
  command: string;
  stdin?: string;
  timeoutMs?: number;
}) => Promise<SshRunResult>;

export async function syncSkillsViaSsh(
  run: SshScriptRunner,
  timeoutMs = 20000,
  files: ShippedSkillFile[] = SHIPPED_SKILL_FILES,
): Promise<SkillSyncResult & { ok: boolean; error?: string }> {
  const fail = (error: string) => ({ ok: false, error, written: [], diverged: [], retired: [] });
  try {
    const probe = await run({
      command: buildSshSkillsCommand(),
      stdin: buildSshProbeScript(files.map((f) => f.relPath)),
      timeoutMs,
    });
    if (!probe.ok) return fail(probe.error ?? `probe failed${probe.stderr.trim() ? `: ${probe.stderr.trim()}` : ""}`);

    const found = parseSshProbe(probe.stdout);
    const previous = found.journal;
    // Every bundle path was asked about explicitly, so absent-from-the-probe
    // means absent-on-the-remote (→ write it). A path the probe answered for but
    // could not read arrives as UNREADABLE, and is never overwritten.
    const current: Record<string, string | null> = {};
    for (const file of files) current[file.relPath] = found.files[file.relPath] ?? null;

    const inBundle = new Set(files.map((f) => f.relPath));
    const candidates = Object.keys(previous.shipped).filter((rel) => !inBundle.has(rel));
    if (candidates.length > 0) {
      const second = await run({
        command: buildSshSkillsCommand(),
        stdin: buildSshProbeScript(candidates),
        timeoutMs,
      });
      // Abort rather than apply: without these bytes the plan cannot tell "our
      // old copy, delete it" from "the user's edit, keep it", and the journal we
      // would then write drops the entry — leaving the stale skill live on that
      // server forever. Sending nothing keeps the remote journal intact, so the
      // next connect retries the retirement.
      if (!second.ok) {
        return fail(second.error ?? `retirement probe failed${second.stderr.trim() ? `: ${second.stderr.trim()}` : ""}`);
      }
      const probe2 = parseSshProbe(second.stdout).files;
      for (const rel of candidates) current[rel] = probe2[rel] ?? null;
    }

    const plan = planSkillSync(current, previous, files);
    const journal = nextJournal(plan, previous, files);
    const apply = await run({
      command: buildSshSkillsCommand(),
      stdin: buildSshApplyScript({ plan, current, journal, files }),
      timeoutMs,
    });
    if (!apply.ok) return fail(apply.error ?? `install failed${apply.stderr.trim() ? `: ${apply.stderr.trim()}` : ""}`);

    logDivergences(plan.diverged, previous, files, (rel) => `~/.pi/agent/skills/${rel}`);
    return {
      ok: true,
      written: plan.writes.filter((f) => current[f.relPath] !== f.content).map((f) => f.relPath),
      diverged: plan.diverged,
      retired: plan.retired,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** The SFTP transport, for password-authed remotes the app already has a session with. */
export async function syncSkillsViaSftp(
  client: SftpClient,
  homeDir: string,
  agentDirRemote?: string,
): Promise<SkillSyncResult & { ok: boolean; error?: string }> {
  const skillsDir = `${remoteAgentDir({ agentDir: agentDirRemote }, homeDir)}/skills`;
  try {
    const result = await syncSkills(sftpSkillsIo(client, skillsDir));
    for (const relPath of result.diverged) {
      console.log(`[skills] keeping ${skillsDir}/${relPath}: edited on the server`);
    }
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      written: [],
      diverged: [],
      retired: [],
    };
  }
}
