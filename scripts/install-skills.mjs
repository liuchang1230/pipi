#!/usr/bin/env node
/**
 * Install the vendored skills into a pi skills directory (default
 * ~/.pi/agent/skills) so this machine stops running hand-copied snapshots.
 *
 * This is the dev-side counterpart to the app's own shipping path
 * (src/main/extension-sync.ts): the app ships the `ship: true` subset to every
 * user through four channels, while this script exists so the machine we
 * develop on has all twelve — including the ones we don't ship — and has them
 * at the pinned upstream revision.
 *
 * A skill directory we are about to change is backed up first, outside the
 * skills directory (a `.bak` inside it would be discovered by pi as a second
 * copy of the same skill). Nothing else in the target directory is touched:
 * skills we don't vendor are the user's.
 *
 * Usage:
 *   node scripts/install-skills.mjs            # all vendored skills
 *   node scripts/install-skills.mjs --shipped  # only the ones the app ships
 *   node scripts/install-skills.mjs --check    # report drift, write nothing
 *   node scripts/install-skills.mjs --dir <path>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(REPO, "skills");

function parseArgs(argv) {
  const out = { dir: join(homedir(), ".pi", "agent", "skills"), shipped: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = resolve(argv[++i]);
    else if (argv[i] === "--shipped") out.shipped = true;
    else if (argv[i] === "--check") out.check = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function walk(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
    else if (entry.isFile()) files.push(prefix ? `${prefix}/${entry.name}` : entry.name);
  }
  return files;
}

/** Skill directory names under `root`, at `bucket/name` or `name` depth. */
function discoverSkills(root) {
  const found = new Set();
  if (!existsSync(root)) return found;
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = join(root, bucket.name);
    if (existsSync(join(bucketPath, "SKILL.md"))) found.add(bucket.name);
    for (const inner of readdirSync(bucketPath, { withFileTypes: true })) {
      if (inner.isDirectory() && existsSync(join(bucketPath, inner.name, "SKILL.md"))) found.add(`${bucket.name}/${inner.name}`);
    }
  }
  return found;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The ownership journal (`.pipi.json`) for the files this script has installed
 * — the same file `src/main/skill-sync.ts` reads and writes, so the app does not
 * have to guess on its first launch. Without it the app finds nine files that
 * exist, differ from nothing it remembers, and (correctly, by its own rules)
 * classifies them as the user's: it would report our own copies as hand-edited
 * and never upgrade them again.
 *
 * Only two kinds of files are claimed:
 *  - `ship: true` skills, because those are the ones the app owns and may retire
 *    (`retire` = OUR journal entries the bundle no longer contains). Claiming a
 *    dev-only skill would make the app delete it on the next launch.
 *  - files whose bytes on disk already equal the vendored ones, so a hand-edited
 *    copy that was here BEFORE this script ran is never adopted as ours.
 */
export function journalEntries({ skillsDir, destDir, selected }) {
  const shipped = {};
  for (const skill of selected) {
    if (!skill.ship) continue;
    const src = join(skillsDir, skill.bucket, skill.name);
    for (const f of walk(src)) {
      const rel = `${skill.bucket}/${skill.name}/${f}`;
      const destPath = join(destDir, skill.bucket, skill.name, f);
      if (!existsSync(destPath)) continue;
      const text = readFileSync(destPath, "utf8");
      if (text === readFileSync(join(src, f), "utf8")) shipped[rel] = sha256(text);
    }
  }
  return { version: 1, shipped, diverged: {} };
}

/** Merge with whatever is already there: journals of other skills we installed
 *  earlier are not ours to forget. */
function mergeJournal(dir, entries) {
  const file = join(dir, ".pipi.json");
  let previous = { version: 1, shipped: {}, diverged: {} };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.shipped) previous = parsed;
    } catch {
      // A corrupt journal is not a reason to stop installing; it only means we
      // cannot honour "keep the user's edits" for the entries we lost.
    }
  }
  const merged = { version: 1, shipped: { ...previous.shipped, ...entries.shipped }, diverged: entries.diverged };
  if (Object.keys(merged.shipped).length === 0) return 0;
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return Object.keys(merged.shipped).length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(SKILLS_DIR, "manifest.json"), "utf8"));
  const selected = manifest.skills.filter((s) => !args.shipped || s.ship);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupRoot = `${args.dir}-backup-${stamp}`;

  const changed = [];
  const backedUp = [];
  const removed = [];

  for (const skill of selected) {
    const src = join(SKILLS_DIR, skill.bucket, skill.name);
    const dest = join(args.dir, skill.bucket, skill.name);
    const rel = `${skill.bucket}/${skill.name}`;

    const srcFiles = walk(src);
    const destFiles = existsSync(dest) ? walk(dest) : [];
    const dirty = srcFiles.filter((f) => {
      const srcText = readFileSync(join(src, f), "utf8");
      const destPath = join(dest, f);
      return !existsSync(destPath) || readFileSync(destPath, "utf8") !== srcText;
    });
    const extra = destFiles.filter((f) => !srcFiles.includes(f));
    if (!dirty.length && !extra.length) continue;

    changed.push(`${rel} (${dirty.length} changed, ${extra.length} removed)`);
    if (args.check) continue;

    // Backup before the first write to this skill, so a hand-edited copy is
    // recoverable — the whole point of the diverged-file rule is that the user's
    // version is not ours to throw away.
    if (existsSync(dest)) {
      const backup = join(backupRoot, rel);
      mkdirSync(dirname(backup), { recursive: true });
      cpSync(dest, backup, { recursive: true });
      backedUp.push(relative(dirname(args.dir), backup).replace(/\\/g, "/"));
    }
    for (const f of dirty) {
      const target = join(dest, f);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(src, f)));
    }
    for (const f of extra) {
      const target = join(dest, f);
      rmSync(target);
      removed.push(`${rel}/${f}`);
    }
  }

  if (args.check) {
    const wouldClaim = Object.keys(journalEntries({ skillsDir: SKILLS_DIR, destDir: args.dir, selected }).shipped).length;
    console.log(`[skills] journal: would claim ${wouldClaim} file(s) as ours`);
  } else {
    const claimed = mergeJournal(args.dir, journalEntries({ skillsDir: SKILLS_DIR, destDir: args.dir, selected }));
    console.log(`[skills] journal .pipi.json: ${claimed} file(s) recorded as ours`);
  }

  const ours = new Set(selected.map((s) => `${s.bucket}/${s.name}`));
  const foreign = [...discoverSkills(args.dir)].filter((name) => !ours.has(name));

  console.log(`[skills] ${args.check ? "check" : "install"}: ${selected.length} skills → ${args.dir}`);
  console.log(`[skills] upstream ${manifest.upstream.commit.slice(0, 7)} (${manifest.upstream.commitDate})`);
  if (changed.length) {
    for (const c of changed) console.log(`  ${args.check ? "!" : "+"} ${c}`);
  } else {
    console.log(`[skills] already up to date`);
  }
  if (backedUp.length) console.log(`[skills] backed up to ${backupRoot}: ${backedUp.length}`);
  if (foreign.length) console.log(`[skills] left alone (not ours): ${foreign.join(", ")}`);
  if (args.check && changed.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();