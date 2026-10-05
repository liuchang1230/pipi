/// <reference types="vite/client" />
/**
 * Ship app-bundled skills to <agentHome>/skills/ so every pi spawned by a tab
 * discovers them (pi scans recursively for any dir containing SKILL.md — see
 * pi's docs/skills.md), on the local machine, in WSL, and on remote servers.
 *
 * This module owns what is SKILLS-specific: the bundle (which skills ship, read
 * from the build-time globs over repo-root skills/) and the four transports'
 * skills bindings. The delivery policy itself — 只读订阅 + 偏离保留, the
 * journal, the pure plan rules, the probe/apply protocol — lives in
 * content-sync.ts, which extensions/ and agents/ use too: all three are
 * app-internal text trees installed into an agent dir, and they differ only in
 * their root and in whether the user is invited to edit them.
 *
 * Source of truth: repo-root skills/ (see skills/manifest.json + NOTICE.md),
 * embedded at build time via Vite `?raw` — the same packaging story as
 * extension-sync.ts, so this needs no electron-builder change.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type SftpClient from "ssh2-sftp-client";
import { remoteAgentDir } from "./pty";
import {
  buildApplyScript,
  buildProbeScript,
  buildSshContentCommand,
  ensureContent,
  logDivergences,
  nextJournal as nextJournalOfEngine,
  nodeContentIo,
  planSync,
  sftpContentIo,
  syncContent,
  syncContentViaSsh,
  type ContentIo,
  type ContentJournal,
  type ContentPlan,
  type ContentSyncResult,
  type ShippedFile,
} from "./content-sync";
import type { CommandRunner } from "./runner";
import manifestSource from "../../skills/manifest.json?raw";

const AGENT_HOME = join(homedir(), ".pi", "agent");
const SKILLS_DIR = join(AGENT_HOME, "skills");
/** Where a key-auth remote's skills live. A POSIX expression the REMOTE shell
 *  expands — key-auth sync is skipped when the remote uses an agentDir override
 *  (index.ts), so `$HOME` is always the right root there. */
const REMOTE_SKILLS_DIR = "$HOME/.pi/agent/skills";
const LABEL = "skills";

/** The generic content types, under the skills names this module has always used. */
export type ShippedSkillFile = ShippedFile;
export type SkillJournal = ContentJournal;
export type SkillSyncPlan = ContentPlan;
export type SkillIo = ContentIo;
export type SkillSyncResult = ContentSyncResult;
export type { CommandRunner };
export {
  EMPTY_JOURNAL,
  JOURNAL_FILE,
  parseJournal,
  retireDirCandidates,
  sha256,
  UNREADABLE,
} from "./content-sync";
/** Same parser, under the name the skills callers have always used. */
export { parseProbe as parseSshProbe } from "./content-sync";

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
 * time — and they list only the SHIPPED directories, so the five dev-only skills
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
      "../../skills/productivity/{handoff,writing-for-agents,grilling}/**/*",
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

/** The engine's pure rules, pre-bound to the shipped bundle (the default the
 *  skills callers and tests have always relied on). */
export function planSkillSync(
  current: Record<string, string | null>,
  journal: SkillJournal,
  files: ShippedSkillFile[] = SHIPPED_SKILL_FILES,
): SkillSyncPlan {
  return planSync(current, journal, files);
}

/** Fold a plan back into a journal, pre-bound to the shipped bundle. */
export function nextJournal(
  plan: SkillSyncPlan,
  previous: SkillJournal,
  files: ShippedSkillFile[] = SHIPPED_SKILL_FILES,
): SkillJournal {
  return nextJournalOfEngine(plan, previous, files);
}

/**
 * The ARGV half of every key-auth remote skills call — content-free for the
 * same reason as the extensions one (see extension-sync.ts + ssh-exec.ts: a
 * command line that grows with shipped content throws ENAMETOOLONG).
 */
export function buildSshSkillsCommand(): string {
  return buildSshContentCommand();
}

/**
 * Round trip 1: print the remote journal and the current bytes of every path we
 * care about, base64ed, with marker lines.
 */
export function buildSshProbeScript(relPaths: string[]): string {
  return buildProbeScript(relPaths, REMOTE_SKILLS_DIR);
}

/**
 * Round trip 2: write what the plan says to write, delete what it says to
 * delete, and leave the journal that makes the next run's classification
 * possible.
 */
export function buildSshApplyScript(args: {
  plan: SkillSyncPlan;
  /** What the probe found, so identical files are not rewritten. */
  current: Record<string, string | null>;
  journal: SkillJournal;
  files?: ShippedSkillFile[];
}): string {
  return buildApplyScript({
    plan: args.plan,
    current: args.current,
    journal: args.journal,
    remoteRoot: REMOTE_SKILLS_DIR,
  });
}

/** Read the journal, classify every file, apply the plan, write the journal. */
export function syncSkills(io: SkillIo, files: ShippedSkillFile[] = SHIPPED_SKILL_FILES): Promise<SkillSyncResult> {
  return syncContent(io, files);
}

/** Local file system (and the \\wsl$ UNC path, which is a file system too). */
export function nodeSkillsIo(skillsDir: string): SkillIo {
  return nodeContentIo(skillsDir);
}

/** An already-connected SFTP session (the app's password-remote transport). */
export function sftpSkillsIo(client: SftpClient, skillsDir: string): SkillIo {
  return sftpContentIo(client, skillsDir);
}

/**
 * Synchronous convenience for the local startup path, whose whole point is that
 * the skills exist BEFORE any tab can spawn pi (same contract as
 * ensureShippedExtensions). Uses the same pure plan/rules as syncSkills.
 * `skillsDir` is overridable for tests. Failures are logged, never fatal.
 */
export function ensureShippedSkills(skillsDir = SKILLS_DIR): SkillSyncResult {
  return ensureContent(skillsDir, SHIPPED_SKILL_FILES, LABEL);
}

/**
 * The key-auth (passwordless) ssh transport: probe, classify with the same pure
 * rules as everywhere else, apply. `run` is injected so the module never
 * depends on ssh-exec at runtime and the tests can drive it with a fake; the
 * caller has already bound the remote and the ssh binary.
 */
export function syncSkillsViaSsh(
  run: CommandRunner,
  timeoutMs = 20000,
  files: ShippedSkillFile[] = SHIPPED_SKILL_FILES,
): Promise<SkillSyncResult & { ok: boolean; error?: string }> {
  return syncContentViaSsh(
    run,
    { remoteRoot: REMOTE_SKILLS_DIR, label: LABEL, displayRoot: "~/.pi/agent/skills" },
    files,
    timeoutMs,
  );
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
