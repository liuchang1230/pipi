#!/usr/bin/env node
/**
 * Vendor the upstream skills we adopt into skills/, applying the documented
 * pipi overlay (skills/manifest.json).
 *
 * Why a script: the alternative is hand-copied snapshots, and those drift
 * silently — the six skills copied into ~/.pi/agent/skills by hand in July were
 * already three upstream conventions out of date (CONTEXT.md → GLOSSARY.md, the
 * "Call the Skill tool" convention, the repo-wide em-dash removal) without
 * anyone noticing. Re-running this script is the whole upgrade procedure; a
 * patch whose `find` no longer matches FAILS LOUDLY, which is the signal that
 * upstream changed the sentence we had rewritten.
 *
 * Usage:
 *   node scripts/vendor-skills.mjs --from <path-to-upstream-clone>   # write
 *   node scripts/vendor-skills.mjs --from <...> --check              # verify only
 *
 * `--check` is the drift detector: it re-derives every vendored file from the
 * upstream clone + the manifest patches and diffs the result against the
 * working tree, without writing anything.
 *
 * Upstream is a git clone at the pinned commit in the manifest; the script
 * verifies the clone's HEAD matches that commit before touching anything.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(REPO, "skills");
const SKIP_DIRS = new Set(["agents", "node_modules", ".git"]);

function parseArgs(argv) {
  const out = { from: "", check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") out.from = argv[++i];
    else if (argv[i] === "--check") out.check = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.from) throw new Error("--from <path-to-upstream-clone> is required");
  return out;
}

/** Every file under `dir`, as paths relative to `dir`, skipping SKIP_DIRS. */
function walk(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
    } else if (entry.isFile()) {
      files.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  }
  return files;
}

/**
 * Upstream content with this skill's patches applied. A patch that matches
 * nothing, or matches more than once, throws: both mean the manifest and
 * upstream have diverged and a human has to look.
 *
 * Patches are single-line by rule. The vendored files are CRLF, so a find or
 * replace containing a newline would have to commit to one line ending (baking
 * it into the bytes we ship) and would also break the generated NOTICE, which
 * renders each patch as one bullet. A patch that seems to need two lines is
 * usually one sentence too many — append to an existing line instead.
 */
function applyPatches(relPath, text, patches, seen) {
  for (const patch of patches) {
    if (/[\r\n]/.test(patch.find) || /[\r\n]/.test(patch.replace)) {
      throw new Error(
        `${relPath}: patch ${JSON.stringify(patch.find.slice(0, 60))}… spans lines.\n` +
          `  Patches must be single-line (the vendored files are CRLF, and NOTICE.md renders each patch as one bullet).\n` +
          `  Fold the new text into an existing line, or register the added sentence as its own single-line patch.`,
      );
    }
    const count = text.split(patch.find).length - 1;
    if (count !== 1) {
      throw new Error(
        `${relPath}: patch ${JSON.stringify(patch.find.slice(0, 60))}… matched ${count} times, expected exactly 1.\n` +
          `  Upstream changed this sentence. Re-read it, update skills/manifest.json, then re-run.`,
      );
    }
    text = text.replace(patch.find, patch.replace);
    seen.add(patch.file);
  }
  return text;
}

/**
 * Content equality that ignores line endings.
 *
 * Upstream stores LF; this machine's `core.autocrlf=true` turns the worktree
 * into CRLF, and a Linux checkout would be LF again — so exact-byte comparison
 * would report all 20 files as drift on one of the two machines, which is the
 * kind of check people learn to ignore. What we *write* is still whatever
 * upstream has: see ADR 0005, the shipped newline is never normalised, because
 * normalising it would change bytes already installed on users' machines and
 * the ownership journal would then classify every one of them as hand-edited.
 */
const sameContent = (a, b) => typeof a === "string" && a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/**
 * NOTICE.md is generated, not written by hand: attribution that drifts from the
 * vendored set is worse than no attribution. `--check` diffs it too.
 */
function renderNotice(manifest) {
  const shipped = manifest.skills.filter((s) => s.ship);
  const dev = manifest.skills.filter((s) => !s.ship);
  const lines = [
    "<!-- Generated by scripts/vendor-skills.mjs from skills/manifest.json. Do not edit by hand. -->",
    "",
    "# 第三方技能",
    "",
    `本目录下的技能来自 [${manifest.upstream.repo}](${manifest.upstream.url})（${manifest.upstream.copyright}，${manifest.upstream.license} 许可），`,
    `固定在上游 commit \`${manifest.upstream.commit}\`（${manifest.upstream.commitDate}）。完整许可文本见 \`LICENSE-mattpocock-skills.txt\`。`,
    "",
    "## 不要手改这里的文件",
    "",
    "上游升级的流程是：克隆上游 → 确认 commit → 改 `skills/manifest.json`（只改 overlay 与 pin）→ 跑 `node scripts/vendor-skills.mjs --from <clone>`。",
    "手改会让下一次升级变成一次无人敢做的三方合并；`--check` 会把任何手改报成 drift。",
    "",
    `## 随 app 分发给用户（${shipped.length} 个）`,
    "",
    ...shipped.map((s) => `- \`${s.bucket}/${s.name}\` — \`${s.upstreamPath}\``),
    "",
    `## 仅本机开发使用，不随 app 分发（${dev.length} 个）`,
    "",
    ...dev.map((s) => `- \`${s.bucket}/${s.name}\` — \`${s.upstreamPath}\``),
    "",
    "## pipi overlay（对上游原文的全部改写）",
    "",
    ...manifest.overlay.rules.map((r) => `- ${r}`),
    "",
  ];
  const patched = manifest.skills.filter((s) => s.patches.length);
  lines.push("机械改写（对每个技能文件都生效）：", "");
  for (const rw of manifest.overlay.rewrites ?? []) {
    lines.push(`- \`/${rw.pattern}/${rw.flags ?? "g"}\` → \`${rw.replace.replace(/\$/g, "\\$")}\`（${rw.why}）`);
  }
  lines.push("");
  if (patched.length) {
    lines.push("逐条改动：", "");
    for (const s of patched) {
      for (const p of s.patches) {
        lines.push(`- \`${s.bucket}/${s.name}/${p.file}\`（${p.why}）`);
        lines.push(`  - 上游：${p.find}`);
        lines.push(`  - 我们：${p.replace}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Mechanical overlay rewrites: applying them by rule rather than by literal
 * patch means a sentence upstream adds tomorrow gets the same treatment, and it
 * keeps the per-skill patch list down to the genuinely semantic changes.
 * `preserveCase` keeps a replacement that opens a sentence capitalised while a
 * mid-sentence one stays lower-case — the pattern's group 1 is the matched
 * letter, which the replacement drops.
 */
function applyRewrites(text, rewrites, relPath) {
  for (const rw of rewrites ?? []) {
    const re = new RegExp(rw.pattern, rw.flags ?? "g");
    text = text.replace(re, (...args) => {
      const groups = args.slice(0, -2);
      let out = rw.replace.replace(/\$(\d)/g, (_, i) => groups[Number(i)] ?? "");
      if (rw.preserveCase) {
        const marker = groups[1];
        if (typeof marker === "string" && marker) {
          // The replacement template is written lower-case; the matched letter
          // decides which way it has to go.
          out = marker === marker.toLowerCase() ? out[0].toLowerCase() + out.slice(1) : out[0].toUpperCase() + out.slice(1);
        }
      }
      return out;
    });
  }
  // Post-condition: a leftover mention means upstream added a convention we
  // don't handle yet. Fail loudly rather than ship a dangling instruction the
  // model cannot follow.
  if (/Skill tool/.test(text)) {
    const line = text.split("\n").findIndex((l) => l.includes("Skill tool")) + 1;
    throw new Error(`${relPath}:${line} still mentions "Skill tool" after the overlay. Upstream added a convention we don't rewrite — decide how it should read in pi, then add a rule to skills/manifest.json.`);
  }
  return text;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(SKILLS_DIR, "manifest.json"), "utf8"));
  const upstream = resolve(args.from);
  const upstreamSkills = join(upstream, "skills");

  if (!existsSync(upstreamSkills)) throw new Error(`no skills/ directory under ${upstream} — is --from a clone of ${manifest.upstream.repo}?`);
  const head = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== manifest.upstream.commit) {
    throw new Error(`clone HEAD is ${head}, manifest pins ${manifest.upstream.commit}. Check out the pinned commit (or update the manifest and review the diff).`);
  }

  const written = [];
  const drifted = [];
  const shipped = [];

  for (const skill of manifest.skills) {
    const src = join(upstream, skill.upstreamPath);
    if (!existsSync(src)) throw new Error(`${skill.name}: upstream path missing: ${skill.upstreamPath}`);
    const dest = join(SKILLS_DIR, skill.bucket, skill.name);
    const rel = relative(REPO, dest).replace(/\\/g, "/");
    const byFile = new Map(skill.patches.map((p) => [p.file, []]));
    for (const patch of skill.patches) byFile.get(patch.file).push(patch);

    if (skill.ship) shipped.push(rel);

    for (const file of walk(src)) {
      const original = readFileSync(join(src, file), "utf8");
      const patches = byFile.get(file) ?? [];
      const text = applyPatches(`${rel}/${file}`, applyRewrites(original, manifest.overlay.rewrites, `${rel}/${file}`), patches, new Set());
      const target = join(dest, file);
      const current = existsSync(target) && statSync(target).isFile() ? readFileSync(target, "utf8") : null;
      if (!sameContent(current, text)) {
        drifted.push(rel + "/" + file);
        if (!args.check) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, text, "utf8");
        }
      }
      written.push(rel + "/" + file);
    }
  }

  // A file we vendored in an earlier sync that upstream no longer has (or that
  // we stopped vendoring) would otherwise stay behind forever.
  const expected = new Set(written);
  const stale = [];
  for (const bucket of ["engineering", "productivity"]) {
    const bucketDir = join(SKILLS_DIR, bucket);
    if (!existsSync(bucketDir)) continue;
    for (const name of readdirSync(bucketDir)) {
      const dir = join(bucketDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const known = manifest.skills.some((s) => s.bucket === bucket && s.name === name);
      if (!known) {
        stale.push(relative(REPO, dir).replace(/\\/g, "/"));
        continue;
      }
      for (const file of walk(dir)) {
        const rel = `${relative(REPO, dir).replace(/\\/g, "/")}/${file}`;
        if (!expected.has(rel)) stale.push(rel);
      }
    }
  }

  // Attribution and the upstream license travel with the tree, and are checked
  // like any other generated file.
  const generated = join(SKILLS_DIR, "NOTICE.md");
  const notice = renderNotice(manifest);
  const noticeCurrent = existsSync(generated) ? readFileSync(generated, "utf8") : null;
  if (!sameContent(noticeCurrent, notice)) {
    drifted.push("skills/NOTICE.md");
    if (!args.check) writeFileSync(generated, notice, "utf8");
  }
  const licenseDest = join(SKILLS_DIR, "LICENSE-mattpocock-skills.txt");
  const license = readFileSync(join(upstream, "LICENSE"), "utf8");
  const licenseCurrent = existsSync(licenseDest) ? readFileSync(licenseDest, "utf8") : null;
  if (!sameContent(licenseCurrent, license)) {
    drifted.push("skills/LICENSE-mattpocock-skills.txt");
    if (!args.check) writeFileSync(licenseDest, license, "utf8");
  }

  const mode = args.check ? "check" : "vendor";
  console.log(`[skills] ${mode}: ${manifest.skills.length} skills, ${written.length} files, upstream ${manifest.upstream.commit.slice(0, 7)}`);
  console.log(`[skills] shipped to users: ${shipped.length} skills`);
  if (drifted.length) {
    console.log(`[skills] ${args.check ? "DRIFT" : "wrote"} ${drifted.length} file(s):${args.check ? "" : ""}`);
    for (const f of drifted) console.log(`  ${args.check ? "!" : "+"} ${f}`);
  } else {
    console.log(`[skills] no drift`);
  }
  if (stale.length) {
    console.log(`[skills] stale (in the tree, not from this manifest): ${stale.length}`);
    for (const f of stale) console.log(`  ? ${f}`);
    if (!args.check) {
      for (const f of stale) {
        const abs = join(REPO, f);
        const isDir = statSync(abs).isDirectory();
        rmSync(abs, { recursive: isDir, force: true });
        console.log(`[skills] removed ${f}`);
      }
    }
  }

  if (args.check && drifted.length) process.exitCode = 1;

  // Sanity: the vendored set is what the app will bundle, so the digest is the
  // value an app version pins. Line endings are normalised (see sameContent),
  // so the same revision has the same digest on Windows and on Linux.
  const digest = createHash("sha256")
    .update([...expected].sort().map((f) => f + "\u0000" + readFileSync(join(REPO, f), "utf8").replace(/\r\n/g, "\n")).join("\u0000"))
    .digest("hex");
  console.log(`[skills] content digest ${digest}`);
}

main();
