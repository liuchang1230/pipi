/**
 * Deliver app-internal content into a pi agent directory — one engine for
 * every kind of content the app ships (skills/, extensions/, agents/).
 *
 * The policy is 只读订阅 + 偏离保留:
 *
 *   - the user never edited it → ours, upgrade in place
 *   - the user edited it       → keep their bytes, log it, never overwrite
 *   - we no longer ship it     → delete only if unedited, else keep
 *
 * "Did the user edit it" needs memory, which is what the journal (`.pipi.json`,
 * written next to the installed content) provides: it records the hash of the
 * bytes we last put there. Without it, our own older version and a user edit
 * are indistinguishable.
 *
 * The split of concerns: planSync/nextJournal are PURE — given what is on disk,
 * the journal, and the bundle, they say what to do. syncContent executes that
 * plan through an injected ContentIo, and the transports are thin adapters:
 * node fs for local + the \\wsl$ UNC path, SFTP for password remotes, and
 * probe-then-apply shell scripts for key-auth ssh remotes.
 *
 * That last one is not a ContentIo, deliberately: reading a remote file over
 * ssh is one round trip per file, so instead of a per-file `read` it does ONE
 * probe trip that dumps every file we care about, runs the same pure rules
 * here, and sends back one apply trip. It costs one more round trip per changed
 * digest and buys the same "keep what the user edited" promise on passwordless
 * servers as everywhere else.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type SftpClient from "ssh2-sftp-client";
import type { SshRunResult } from "./ssh-exec";

/** Journal file name — inert to pi everywhere we install (it discovers skills
 *  by SKILL.md, extensions by *.ts, agents by *.md). */
export const JOURNAL_FILE = ".pipi.json";

export interface ShippedFile {
  /** Path inside the target root, e.g. "engineering/wizard/SKILL.md" or
   *  "delegation/index.ts". Always /-separated. */
  relPath: string;
  content: string;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface ContentJournal {
  version: 1;
  /** relPath → sha256 of the bytes WE wrote there. */
  shipped: Record<string, string>;
  /** relPath → sha256 of what we WANTED to write; the file itself is the user's. */
  diverged: Record<string, string>;
}

export const EMPTY_JOURNAL: ContentJournal = { version: 1, shipped: {}, diverged: {} };

export function parseJournal(text: string | null | undefined): ContentJournal {
  if (!text) return EMPTY_JOURNAL;
  try {
    const parsed = JSON.parse(text) as Partial<ContentJournal>;
    return { version: 1, shipped: parsed.shipped ?? {}, diverged: parsed.diverged ?? {} };
  } catch {
    // A corrupted journal must not stop content from installing; the worst case
    // is that we treat everything as "not ours" and keep it.
    return EMPTY_JOURNAL;
  }
}

export interface ContentPlan {
  /** Our files to install: absent, already ours, or an upgrade of ours. */
  writes: ShippedFile[];
  /** The user edited these — their bytes stay, we only record the intent. */
  diverged: string[];
  /** We no longer ship these and the user never touched them → delete. */
  retired: string[];
}

/**
 * Decide, for one bundle, what to do with a target dir — touching nothing.
 * `current` is `relPath → file text` for every path we care about (absent: null).
 *
 *   1. absent, or already identical to ours → write ours
 *   2. differs, but matches the journal → our own older version → write ours
 *   3. differs from both → the user's → keep, do not write
 *
 * Retirement uses the same test: only a file still holding the bytes we
 * recorded may be deleted.
 */
export function planSync(
  current: Record<string, string | null>,
  journal: ContentJournal,
  files: ShippedFile[],
): ContentPlan {
  const wanted = new Set(files.map((f) => f.relPath));
  const plan: ContentPlan = { writes: [], diverged: [], retired: [] };

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
  plan: ContentPlan,
  previous: ContentJournal,
  files: ShippedFile[],
): ContentJournal {
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
  // Remember a divergence that is still on disk but no longer in the bundle,
  // so we never adopt it later.
  for (const [relPath, hash] of Object.entries(previous.diverged)) {
    if (!(relPath in shipped) && !(relPath in diverged) && !plan.retired.includes(relPath)) diverged[relPath] = hash;
  }
  return { version: 1, shipped, diverged };
}

/** Log divergences that are NEWS. A divergence is state, not an event: the full
 *  set is returned every run (a UI lists what it will never upgrade), but a
 *  startup log should not repeat yesterday's line. */
export function logDivergences(
  diverged: string[],
  previous: ContentJournal,
  files: ShippedFile[],
  label: string,
  abs: (relPath: string) => string,
): void {
  for (const relPath of diverged) {
    const intent = sha256(files.find((f) => f.relPath === relPath)?.content ?? "");
    if (previous.diverged[relPath] !== intent) console.log(`[${label}] keeping ${abs(relPath)}: edited by the user`);
  }
}

/**
 * The only thing a transport has to provide. A missing file is `null`, never a
 * throw — "not there yet" is the normal first-sync state everywhere.
 */
export interface ContentIo {
  read(relPath: string): Promise<string | null>;
  write(relPath: string, content: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

export interface ContentSyncResult {
  written: string[];
  diverged: string[];
  retired: string[];
}

/** Serialized journal, in the one format every writer uses (`+ "\n"`, 2-space). */
export const journalText = (journal: ContentJournal): string => `${JSON.stringify(journal, null, 2)}\n`;

/** Read the journal, classify every file, apply the plan, write the journal. */
export async function syncContent(io: ContentIo, files: ShippedFile[]): Promise<ContentSyncResult> {
  const previousText = await io.read(JOURNAL_FILE);
  const previous = parseJournal(previousText);
  const relPaths = new Set([
    ...files.map((f) => f.relPath),
    ...Object.keys(previous.shipped),
    ...Object.keys(previous.diverged),
  ]);
  const current: Record<string, string | null> = {};
  for (const relPath of relPaths) current[relPath] = await io.read(relPath);

  const plan = planSync(current, previous, files);
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
export function nodeContentIo(root: string): ContentIo {
  const abs = (relPath: string): string => join(root, ...relPath.split("/"));
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
export function sftpContentIo(client: SftpClient, root: string): ContentIo {
  const abs = (relPath: string): string => `${root}/${relPath}`;
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
 * the content exists BEFORE any tab can spawn pi. Uses the same pure plan/rules
 * as syncContent. `root` is overridable for tests. Failures are logged, never
 * fatal (the app must still start).
 */
export function ensureContent(root: string, files: ShippedFile[], label = "content"): ContentSyncResult {
  const abs = (relPath: string): string => join(root, ...relPath.split("/"));
  try {
    const journalPath = abs(JOURNAL_FILE);
    const previousText = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : null;
    const previous = parseJournal(previousText);
    const relPaths = new Set([
      ...files.map((f) => f.relPath),
      ...Object.keys(previous.shipped),
      ...Object.keys(previous.diverged),
    ]);
    const current: Record<string, string | null> = {};
    for (const relPath of relPaths) {
      const target = abs(relPath);
      current[relPath] = existsSync(target) ? readFileSync(target, "utf8") : null;
    }
    const plan = planSync(current, previous, files);
    const written: string[] = [];
    for (const { relPath, content } of plan.writes) {
      if (current[relPath] === content) continue;
      const target = abs(relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      written.push(relPath);
      console.log(`[${label}] wrote ${target}`);
    }
    logDivergences(plan.diverged, previous, files, label, abs);
    for (const relPath of plan.retired) {
      rmSync(abs(relPath), { force: true });
      console.log(`[${label}] retired ${abs(relPath)}`);
    }
    if (plan.retired.length) pruneEmptyDirs(root, retireDirCandidates(plan.retired));
    // Same text-only-when-changed rule as the async path: the steady state is a
    // no-op, which is what makes "nothing to report" honest.
    const nextText = journalText(nextJournal(plan, previous, files));
    if (previousText !== nextText) writeFileSync(journalPath, nextText, "utf8");
    return { written, diverged: plan.diverged, retired: plan.retired };
  } catch (error) {
    console.error(`[${label}] sync failed:`, error instanceof Error ? error.message : String(error));
    return { written: [], diverged: [], retired: [] };
  }
}

/** Remove directories left empty by a retire, deepest first, never the root itself. */
export function pruneEmptyDirs(root: string, relDirs: string[]): void {
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
 * The ARGV half of every key-auth remote content call — content-free for the
 * same reason as the extensions one (see extension-sync.ts + ssh-exec.ts: a
 * command line that grows with shipped content throws ENAMETOOLONG).
 */
export function buildSshContentCommand(): string {
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
 * already required by the extensions install script. `remoteRoot` is a POSIX
 * expression the REMOTE shell expands (e.g. `$HOME/.pi/agent/skills`).
 */
export function buildProbeScript(relPaths: string[], remoteRoot: string): string {
  const lines: string[] = [];
  if (relPaths.length > 0) {
    lines.push(
      `for p in ${relPaths.join(" ")}; do`,
      `  f="${remoteRoot}/$p"`,
      `  if [ -f "$f" ]; then`,
      `    printf '${FILE_MARK} %s\\n' "$p"`,
      `    base64 "$f" 2>/dev/null || printf '${UNREADABLE_MARK} %s\\n' "$p"`,
      `  fi`,
      `done`,
    );
  }
  lines.push(
    `if [ -f ${remoteRoot}/${JOURNAL_FILE} ]; then`,
    `  printf '${JOURNAL_MARK}\\n'`,
    `  base64 ${remoteRoot}/${JOURNAL_FILE} 2>/dev/null || true`,
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
export function parseProbe(stdout: string): { journal: ContentJournal; files: Record<string, string | null> } {
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
 * costs zero writes. `trailer` appends transport-specific shell (the
 * marker-guarded legacy retire, which predates the journal).
 */
export function buildApplyScript(args: {
  plan: ContentPlan;
  /** What the probe found, so identical files are not rewritten. */
  current: Record<string, string | null>;
  journal: ContentJournal;
  remoteRoot: string;
  trailer?: string;
}): string {
  const root = args.remoteRoot;
  const writes = args.plan.writes.filter((f) => args.current[f.relPath] !== f.content);
  const dirs = [...new Set(writes.map((f) => posix.dirname(f.relPath)))].sort();
  const lines: string[] = [];
  if (dirs.length > 0) lines.push(`mkdir -p ${dirs.map((d) => `${root}/${d}`).join(" ")}`);
  for (const { relPath, content } of writes) {
    lines.push(`echo ${Buffer.from(content, "utf8").toString("base64")} | base64 -d > ${root}/${relPath}`);
  }
  for (const relPath of args.plan.retired) lines.push(`rm -f ${root}/${relPath}`);
  for (const dir of retireDirCandidates(args.plan.retired)) lines.push(`rmdir ${root}/${dir} 2>/dev/null || true`);
  // The journal is the whole point of the probe: it is what makes "ours" and
  // "the user's edit" distinguishable on the next connect.
  const journalBlob = Buffer.from(journalText(args.journal), "utf8").toString("base64");
  lines.push(`mkdir -p ${root}`, `echo ${journalBlob} | base64 -d > ${root}/${JOURNAL_FILE}`);
  if (args.trailer) lines.push(args.trailer.replace(/\n+$/, ""));
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
 * where we stop shipping something, and a failure there aborts the whole sync —
 * an unreadable retirement candidate is not something to guess about.
 */
export type SshScriptRunner = (options: {
  command: string;
  stdin?: string;
  timeoutMs?: number;
}) => Promise<SshRunResult>;

/** Everything one key-auth remote call needs to know about its destination. */
export interface SshContentTarget {
  /** POSIX expression the REMOTE shell expands, e.g. `$HOME/.pi/agent/skills`. */
  remoteRoot: string;
  /** Log prefix, e.g. `[skills]`. */
  label: string;
  /** Where the logs pretend the root is (`~/.pi/agent/skills`); the shell
   *  expression above is correct for the remote but ugly in a log line. */
  displayRoot?: string;
  /** Extra shell appended to the apply trip (the marker-guarded legacy retire,
   *  which predates the journal and so is not part of any plan). */
  trailer?: string;
}

export async function syncContentViaSsh(
  run: SshScriptRunner,
  target: SshContentTarget,
  files: ShippedFile[],
  timeoutMs = 20000,
): Promise<ContentSyncResult & { ok: boolean; error?: string }> {
  const { remoteRoot, label, displayRoot = remoteRoot } = target;
  const fail = (error: string) => ({ ok: false, error, written: [], diverged: [], retired: [] });
  try {
    const command = buildSshContentCommand();
    const probe = await run({
      command,
      stdin: buildProbeScript(files.map((f) => f.relPath), remoteRoot),
      timeoutMs,
    });
    if (!probe.ok) return fail(probe.error ?? `probe failed${probe.stderr.trim() ? `: ${probe.stderr.trim()}` : ""}`);

    const found = parseProbe(probe.stdout);
    const previous = found.journal;
    // Every bundle path was asked about explicitly, so absent-from-the-probe
    // means absent-on-the-remote (→ write it). A path the probe answered for but
    // could not read arrives as UNREADABLE, and is never overwritten.
    const current: Record<string, string | null> = {};
    for (const file of files) current[file.relPath] = found.files[file.relPath] ?? null;

    const inBundle = new Set(files.map((f) => f.relPath));
    const candidates = Object.keys(previous.shipped).filter((rel) => !inBundle.has(rel));
    if (candidates.length > 0) {
      const second = await run({ command, stdin: buildProbeScript(candidates, remoteRoot), timeoutMs });
      // Abort rather than apply: without these bytes the plan cannot tell "our
      // old copy, delete it" from "the user's edit, keep it", and the journal we
      // would then write drops the entry — leaving the stale file live on that
      // server forever. Sending nothing keeps the remote journal intact, so the
      // next connect retries the retirement.
      if (!second.ok) {
        return fail(second.error ?? `retirement probe failed${second.stderr.trim() ? `: ${second.stderr.trim()}` : ""}`);
      }
      const probe2 = parseProbe(second.stdout).files;
      for (const rel of candidates) current[rel] = probe2[rel] ?? null;
    }

    const plan = planSync(current, previous, files);
    const journal = nextJournal(plan, previous, files);
    const apply = await run({
      command,
      stdin: buildApplyScript({ plan, current, journal, remoteRoot, trailer: target.trailer }),
      timeoutMs,
    });
    if (!apply.ok) return fail(apply.error ?? `install failed${apply.stderr.trim() ? `: ${apply.stderr.trim()}` : ""}`);

    logDivergences(plan.diverged, previous, files, label, (rel) => `${displayRoot}/${rel}`);
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
