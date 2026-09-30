// The skills bundle, the ownership rules, and the two transports that can be
// tested without a server: local fs and an in-memory io.
//
// The rules are the product promise (只读订阅 + 偏离保留), so they are tested as
// decisions — what a plan says about a given disk + journal — rather than by
// inspecting files afterwards.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshApplyScript,
  buildSshProbeScript,
  buildSshSkillsCommand,
  EMPTY_JOURNAL,
  ensureShippedSkills,
  JOURNAL_FILE,
  nextJournal,
  nodeSkillsIo,
  parseJournal,
  parseSshProbe,
  planSkillSync,
  sha256,
  shippedSkillDirs,
  SHIPPED_SKILL_FILES,
  syncSkills,
  syncSkillsViaSsh,
  UNREADABLE,
  type ShippedSkillFile,
  type SkillIo,
  type SkillJournal,
  type SkillSyncPlan,
  type SshScriptRunner,
} from "../skill-sync";

const tmpDirs: string[] = [];
const tmpDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pipi-skills-"));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** In-memory transport: lets the sync loop be driven without any file system. */
function memoryIo(initial: Record<string, string> = {}): SkillIo & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async read(relPath) {
      return files.has(relPath) ? files.get(relPath)! : null;
    },
    async write(relPath, content) {
      files.set(relPath, content);
    },
    async remove(relPath) {
      files.delete(relPath);
    },
  };
}

const BUNDLE: ShippedSkillFile[] = [
  { relPath: "engineering/wizard/SKILL.md", content: "wizard v1\n" },
  { relPath: "engineering/wizard/template.sh", content: "#!/bin/sh\necho hi\n" },
];

describe("the shipped bundle", () => {
  it("comes from the manifest's ship:true set, and only from it", () => {
    const dirs = shippedSkillDirs();
    expect(dirs).toContain("engineering/wizard");
    expect(dirs).not.toContain("productivity/grilling"); // ship:false
    expect(SHIPPED_SKILL_FILES.length).toBeGreaterThan(0);
    for (const file of SHIPPED_SKILL_FILES) {
      expect(dirs).toContain(file.relPath.split("/").slice(0, 2).join("/"));
      expect(file.content.length).toBeGreaterThan(0);
    }
  });

  it("never ships the manifest, the notice, or the license text", () => {
    const paths = SHIPPED_SKILL_FILES.map((f) => f.relPath);
    expect(paths.some((p) => p.includes("manifest.json") || p.startsWith("NOTICE") || p.includes("LICENSE"))).toBe(
      false,
    );
    // Every shipped skill has its SKILL.md — pi discovers a skill by that file.
    for (const dir of shippedSkillDirs()) {
      expect(paths).toContain(`${dir}/SKILL.md`);
    }
  });

  it("reads the ship flag from the manifest text, not from a hardcoded list", () => {
    const manifest = JSON.stringify({
      skills: [
        { name: "a", bucket: "b", ship: true },
        { name: "c", bucket: "b", ship: false },
      ],
    });
    expect(shippedSkillDirs(manifest)).toEqual(["b/a"]);
  });

  it("keeps paths posix-separated and sorted (the ssh script depends on both)", () => {
    const paths = SHIPPED_SKILL_FILES.map((f) => f.relPath);
    expect(paths).toEqual([...paths].sort());
    expect(paths.every((p) => !p.includes("\\"))).toBe(true);
  });
});

describe("planSkillSync", () => {
  it("writes a file that is not there yet", () => {
    const plan = planSkillSync({}, EMPTY_JOURNAL, BUNDLE);
    expect(plan.writes.map((f) => f.relPath)).toEqual(BUNDLE.map((f) => f.relPath));
    expect(plan.diverged).toEqual([]);
  });

  it("re-writes its own older version — the journal is what proves it is ours", () => {
    const journal: SkillJournal = { version: 1, shipped: { "engineering/wizard/SKILL.md": sha256("wizard v0\n") }, diverged: {} };
    const plan = planSkillSync({ "engineering/wizard/SKILL.md": "wizard v0\n" }, journal, BUNDLE);
    expect(plan.writes.map((f) => f.relPath)).toContain("engineering/wizard/SKILL.md");
    expect(plan.diverged).toEqual([]);
  });

  it("keeps a file the user edited, even when the journal has no entry for it", () => {
    const plan = planSkillSync({ "engineering/wizard/SKILL.md": "my own wizard\n" }, EMPTY_JOURNAL, BUNDLE);
    expect(plan.diverged).toEqual(["engineering/wizard/SKILL.md"]);
    expect(plan.writes.map((f) => f.relPath)).not.toContain("engineering/wizard/SKILL.md");
    // The untouched sibling file is still ours to write.
    expect(plan.writes.map((f) => f.relPath)).toEqual(["engineering/wizard/template.sh"]);
  });

  it("adopts a diverged file again once the user's bytes match ours", () => {
    const journal: SkillJournal = {
      version: 1,
      shipped: {},
      diverged: { "engineering/wizard/SKILL.md": sha256("wizard v1\n") },
    };
    const plan = planSkillSync({ "engineering/wizard/SKILL.md": "wizard v1\n" }, journal, BUNDLE);
    expect(plan.diverged).toEqual([]);
    expect(plan.writes.map((f) => f.relPath)).toContain("engineering/wizard/SKILL.md");
  });

  it("retires a file we shipped and no longer ship — but only while it is untouched", () => {
    const gone = { relPath: "engineering/retro/SKILL.md", content: "retro\n" };
    const journal: SkillJournal = { version: 1, shipped: { [gone.relPath]: sha256(gone.content) }, diverged: {} };
    expect(planSkillSync({ [gone.relPath]: gone.content }, journal, BUNDLE).retired).toEqual([gone.relPath]);
    // Edited by the user → not ours to delete.
    expect(planSkillSync({ [gone.relPath]: "mine\n" }, journal, BUNDLE).retired).toEqual([]);
    // Already gone → nothing to do.
    expect(planSkillSync({}, journal, BUNDLE).retired).toEqual([]);
  });

  it("never retires a file that was never ours", () => {
    const plan = planSkillSync({ "engineering/notes.md": "user notes\n" }, EMPTY_JOURNAL, BUNDLE);
    expect(plan.retired).toEqual([]);
    expect(plan.diverged).toEqual([]);
  });

  it("does nothing on a run where everything already matches", () => {
    const current = Object.fromEntries(BUNDLE.map((f) => [f.relPath, f.content]));
    const journal: SkillJournal = {
      version: 1,
      shipped: Object.fromEntries(BUNDLE.map((f) => [f.relPath, sha256(f.content)])),
      diverged: {},
    };
    const plan = planSkillSync(current, journal, BUNDLE);
    expect(plan.diverged).toEqual([]);
    expect(plan.retired).toEqual([]);
    // "writes" still names them, but the applier skips identical content.
    expect(plan.writes).toHaveLength(BUNDLE.length);
  });
});

describe("nextJournal", () => {
  it("records our intent for a diverged file WITHOUT claiming the bytes as ours", () => {
    const plan = planSkillSync({ "engineering/wizard/SKILL.md": "user wrote this\n" }, EMPTY_JOURNAL, BUNDLE);
    const journal = nextJournal(plan, EMPTY_JOURNAL, BUNDLE);
    expect(journal.shipped["engineering/wizard/SKILL.md"]).toBeUndefined();
    expect(journal.diverged["engineering/wizard/SKILL.md"]).toBe(sha256("wizard v1\n"));
  });

  it("keeps tracking a divergence that is still on disk but no longer in the bundle", () => {
    const previous: SkillJournal = {
      version: 1,
      shipped: {},
      diverged: { "engineering/retro/SKILL.md": sha256("retro v1\n") },
    };
    const journal = nextJournal({ writes: [], diverged: [], retired: [] }, previous, BUNDLE);
    expect(journal.diverged["engineering/retro/SKILL.md"]).toBe(sha256("retro v1\n"));
  });

  it("drops a divergence once the file is retired", () => {
    const previous: SkillJournal = {
      version: 1,
      shipped: {},
      diverged: { "engineering/retro/SKILL.md": sha256("retro v1\n") },
    };
    const journal = nextJournal({ writes: [], diverged: [], retired: ["engineering/retro/SKILL.md"] }, previous, BUNDLE);
    expect(journal.diverged).toEqual({});
  });
});

describe("parseJournal", () => {
  it("treats a missing or corrupt journal as empty rather than throwing", () => {
    expect(parseJournal(null)).toEqual(EMPTY_JOURNAL);
    expect(parseJournal("{not json")).toEqual(EMPTY_JOURNAL);
    expect(parseJournal('{"version":1,"shipped":{"a":"b"}}')).toEqual({ version: 1, shipped: { a: "b" }, diverged: {} });
  });
});

describe("syncSkills over an in-memory transport", () => {
  it("installs the bundle and writes a journal, then is idempotent", async () => {
    const io = memoryIo();
    const first = await syncSkills(io, BUNDLE);
    expect(first.written).toEqual(BUNDLE.map((f) => f.relPath));
    expect(io.files.get("engineering/wizard/SKILL.md")).toBe("wizard v1\n");
    expect(JSON.parse(io.files.get(JOURNAL_FILE)!)).toMatchObject({ version: 1 });

    const second = await syncSkills(io, BUNDLE);
    expect(second).toEqual({ written: [], diverged: [], retired: [] });
  });

  it("does not rewrite the journal when nothing changed", async () => {
    const io = memoryIo();
    const writes: string[] = [];
    const counting: SkillIo = {
      read: (relPath) => io.read(relPath),
      write: async (relPath, content) => {
        writes.push(relPath);
        await io.write(relPath, content);
      },
      remove: (relPath) => io.remove(relPath),
    };
    await syncSkills(counting, BUNDLE);
    expect(writes).toEqual([...BUNDLE.map((f) => f.relPath), JOURNAL_FILE]);
    writes.length = 0;
    await syncSkills(counting, BUNDLE);
    // The steady state is zero writes, not "wrote the same bytes again".
    expect(writes).toEqual([]);
  });

  it("upgrades our own file and preserves a user's edit in the same pass", async () => {
    const io = memoryIo({ "engineering/wizard/SKILL.md": "wizard v1\n", "engineering/wizard/template.sh": "user!\n" });
    await syncSkills(io, BUNDLE); // v1 becomes ours
    const files = BUNDLE.map((f) => (f.relPath.endsWith("SKILL.md") ? { ...f, content: "wizard v2\n" } : f));
    const result = await syncSkills(io, files);
    expect(result.written).toEqual(["engineering/wizard/SKILL.md"]);
    expect(result.diverged).toEqual(["engineering/wizard/template.sh"]);
    expect(io.files.get("engineering/wizard/template.sh")).toBe("user!\n");
    // ...and the journal must still know the user's file is not ours.
    const journal = parseJournal(io.files.get(JOURNAL_FILE));
    expect(journal.shipped["engineering/wizard/template.sh"]).toBeUndefined();
    expect(journal.diverged["engineering/wizard/template.sh"]).toBe(sha256("#!/bin/sh\necho hi\n"));
  });
});

describe("ensureShippedSkills (local startup path, sync)", () => {
  it("leaves skills we never shipped completely alone (they are not ours)", () => {
    const dir = tmpDir();
    // A user's own skill (this machine has `office-cli`): not in the bundle, not
    // in the journal, so it must be neither rewritten, deleted, nor claimed.
    mkdirSync(join(dir, "office-cli"), { recursive: true });
    writeFileSync(join(dir, "office-cli", "SKILL.md"), "my own skill\n", "utf8");
    ensureShippedSkills(dir);
    expect(readFileSync(join(dir, "office-cli", "SKILL.md"), "utf8")).toBe("my own skill\n");
    const journal = parseJournal(readFileSync(join(dir, JOURNAL_FILE), "utf8"));
    expect(Object.keys(journal.shipped).some((rel) => rel.startsWith("office-cli/"))).toBe(false);
    // Still there after a second run, i.e. nothing accumulates against it.
    ensureShippedSkills(dir);
    expect(readFileSync(join(dir, "office-cli", "SKILL.md"), "utf8")).toBe("my own skill\n");
  });

  it("installs every file plus the journal into a fresh dir", () => {
    const dir = tmpDir();
    const result = ensureShippedSkills(dir);
    expect(result.written).toEqual(SHIPPED_SKILL_FILES.map((f) => f.relPath));
    for (const file of SHIPPED_SKILL_FILES) {
      expect(readFileSync(join(dir, ...file.relPath.split("/")), "utf8")).toBe(file.content);
    }
    expect(existsSync(join(dir, JOURNAL_FILE))).toBe(true);
  });

  it("is a no-op on the second run apart from reporting the divergence it kept", () => {
    const dir = tmpDir();
    ensureShippedSkills(dir);
    const edited = join(dir, "engineering", "wizard", "SKILL.md");
    writeFileSync(edited, "my own wizard\n", "utf8");

    expect(ensureShippedSkills(dir)).toEqual({
      written: [],
      diverged: ["engineering/wizard/SKILL.md"],
      retired: [],
    });
    expect(readFileSync(edited, "utf8")).toBe("my own wizard\n");
    // Still theirs after a third run, i.e. the journal never adopted it.
    ensureShippedSkills(dir);
    expect(readFileSync(edited, "utf8")).toBe("my own wizard\n");
  });

  it("agrees with the dev installer (scripts/install-skills.mjs) about what is ours", () => {
    // Two implementations of the same ownership claim: the app writes the
    // journal on install, and the script writes it when a developer copies all
    // twelve skills onto their machine. They must not disagree — a journal that
    // claims our own files as the user's would freeze them at the pinned
    // revision forever, and one that claims a dev-only skill would make the app
    // DELETE it on the next launch.
    const appDir = tmpDir();
    ensureShippedSkills(appDir);
    const appJournal = parseJournal(readFileSync(join(appDir, JOURNAL_FILE), "utf8"));

    // Spawn the real entry point rather than importing it: `import()` sends the
    // script through the transform pipeline, where its `#!` shebang only
    // survives an LF checkout — a fresh Windows clone (core.autocrlf=true, no
    // .gitattributes) is CRLF, and there the import dies with "Invalid or
    // unexpected token". Spawning is also the more honest test, because it runs
    // what a developer actually runs. `--dir` keeps it off the real
    // ~/.pi/agent/skills.
    const devDir = tmpDir();
    const script = join(process.cwd(), "scripts", "install-skills.mjs");
    const run = spawnSync(process.execPath, [script, "--dir", devDir, "--shipped"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const devJournal = parseJournal(readFileSync(join(devDir, JOURNAL_FILE), "utf8"));

    expect(devJournal.shipped).toEqual(appJournal.shipped);
    expect(Object.keys(devJournal.shipped)).toHaveLength(SHIPPED_SKILL_FILES.length);
  });

  it("retires a dropped file and prunes the directory it leaves behind", () => {
    const dir = tmpDir();
    // A skill we used to ship, recorded as ours, and absent from the bundle
    // ("gone" is in no manifest bucket — retro would be a bad example: it ships).
    const relPath = "engineering/gone/SKILL.md";
    mkdirSync(join(dir, "engineering", "gone"), { recursive: true });
    writeFileSync(join(dir, ...relPath.split("/")), "gone v1\n", "utf8");
    writeFileSync(
      join(dir, JOURNAL_FILE),
      JSON.stringify({ version: 1, shipped: { [relPath]: sha256("gone v1\n") }, diverged: {} }),
      "utf8",
    );

    const result = ensureShippedSkills(dir);
    expect(result.retired).toEqual([relPath]);
    expect(existsSync(join(dir, "engineering", "gone"))).toBe(false);
    expect(parseJournal(readFileSync(join(dir, JOURNAL_FILE), "utf8")).shipped[relPath]).toBeUndefined();
  });

  it("leaves a user-edited file alone even when we want it gone", () => {
    const dir = tmpDir();
    const relPath = "engineering/gone/SKILL.md";
    mkdirSync(join(dir, "engineering", "gone"), { recursive: true });
    writeFileSync(join(dir, ...relPath.split("/")), "my notes\n", "utf8");
    writeFileSync(
      join(dir, JOURNAL_FILE),
      JSON.stringify({ version: 1, shipped: { [relPath]: sha256("gone v1\n") }, diverged: {} }),
      "utf8",
    );
    expect(ensureShippedSkills(dir).retired).toEqual([]);
    expect(readFileSync(join(dir, ...relPath.split("/")), "utf8")).toBe("my notes\n");
  });

  it("survives a directory it cannot use instead of failing the app start", () => {
    const result = ensureShippedSkills(join(tmpDir(), "a", "\u0000b"));
    expect(result).toEqual({ written: [], diverged: [], retired: [] });
  });
});

describe("the key-auth ssh transport", () => {
  it("keeps the payload out of the argv", () => {
    expect(buildSshSkillsCommand()).toBe("sh -s");
    expect(buildSshSkillsCommand().length).toBeLessThan(64);
  });

  it("probes every path plus the journal, and nothing else", () => {
    const script = buildSshProbeScript(["engineering/wizard/SKILL.md", "productivity/handoff/SKILL.md"]);
    expect(script).toContain("for p in engineering/wizard/SKILL.md productivity/handoff/SKILL.md; do");
    expect(script).toContain('printf \'@@f %s\\n\' "$p"');
    expect(script).toContain(`if [ -f $HOME/.pi/agent/skills/${JOURNAL_FILE} ]; then`);
    expect(script).toContain("printf '@@j\\n'");
    // A missing file prints no marker line at all: absence is the absence of data.
    expect(script).toContain('[ -f "$f" ]');
    expect(script.endsWith("\n")).toBe(true);
  });

  it("probes only the journal when there is nothing else to ask about", () => {
    const script = buildSshProbeScript([]);
    expect(script).not.toContain("for p in");
    expect(script).toContain("@@j");
  });

  it("round-trips a probe: our files, the user's file, an absent file, the journal", () => {
    const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
    const ours = "ours\n";
    const journal = { version: 1, shipped: { "a/SKILL.md": sha256(ours) }, diverged: {} };
    // base64 wraps at 76 columns, so a real probe emits multi-line payloads.
    const wrapped = b64(ours).replace(/(.{4})/g, "$1\n");
    const stdout = [
      "@@f a/SKILL.md",
      wrapped,
      "@@f b/SKILL.md",
      b64("mine\n"),
      "@@x c/SKILL.md",
      "@@j",
      b64(JSON.stringify(journal)),
      "",
    ].join("\n");

    const { journal: parsed, files } = parseSshProbe(stdout);
    expect(parsed).toEqual(journal);
    expect(files["a/SKILL.md"]).toBe(ours);
    expect(files["b/SKILL.md"]).toBe("mine\n");
    // Present but unreadable is NOT absent: absent gets overwritten.
    expect(files["c/SKILL.md"]).toBe(UNREADABLE);
    expect(files["d/SKILL.md"]).toBeUndefined();
  });

  it("treats an empty or garbage probe as \"nothing of ours is there\"", () => {
    expect(parseSshProbe("")).toEqual({ journal: EMPTY_JOURNAL, files: {} });
    expect(parseSshProbe("@@f a\n!!!not base64!!!\n").files["a"]).not.toBe("");
    expect(parseSshProbe("@@j\nnot json\n").journal).toEqual(EMPTY_JOURNAL);
  });

  it("writes only what changed, and always leaves a journal behind", () => {
    const { plan, current } = planFor({ "engineering/wizard/SKILL.md": "mine\n" });
    const journal = nextJournal(plan, EMPTY_JOURNAL);
    const script = buildSshApplyScript({ plan, current, journal });

    for (const file of plan.writes) {
      if (current[file.relPath] === file.content) continue;
      expect(script).toContain(`base64 -d > $HOME/.pi/agent/skills/${file.relPath}`);
    }
    // The user's file is not written, and not deleted either.
    expect(script).not.toContain("base64 -d > $HOME/.pi/agent/skills/engineering/wizard/SKILL.md");
    expect(script).not.toContain("rm -f $HOME/.pi/agent/skills/engineering/wizard/SKILL.md");
    expect(script).toContain(`base64 -d > $HOME/.pi/agent/skills/${JOURNAL_FILE}`);
    expect(script).toContain("mkdir -p $HOME/.pi/agent/skills\n");
    expect(script.endsWith("\n")).toBe(true);
  });

  it("does not touch anything when the remote is already up to date", () => {
    const files = SHIPPED_SKILL_FILES;
    const current: Record<string, string | null> = {};
    for (const f of files) current[f.relPath] = f.content;
    const plan = planSkillSync(current, EMPTY_JOURNAL, files);
    const script = buildSshApplyScript({ plan, current, journal: nextJournal(plan, EMPTY_JOURNAL, files), files });
    expect(script).not.toContain("base64 -d > $HOME/.pi/agent/skills/engineering");
    expect(script).not.toContain("mkdir -p $HOME/.pi/agent/skills/engineering");
    // Only the journal line, so the next run can still classify.
    expect(script.trimEnd().split("\n")).toHaveLength(2);
  });

  it("retires by path and prunes deepest-first, never the skills dir itself", () => {
    const plan: SkillSyncPlan = { writes: [], diverged: [], retired: ["engineering/gone/SKILL.md"] };
    const script = buildSshApplyScript({ plan, current: {}, journal: EMPTY_JOURNAL });
    expect(script).toContain("rm -f $HOME/.pi/agent/skills/engineering/gone/SKILL.md");
    const rmdirs = script.split("\n").filter((l) => l.startsWith("rmdir "));
    expect(rmdirs).toEqual([
      "rmdir $HOME/.pi/agent/skills/engineering/gone 2>/dev/null || true",
      "rmdir $HOME/.pi/agent/skills/engineering 2>/dev/null || true",
    ]);
    expect(script).not.toContain("rmdir $HOME/.pi/agent/skills 2>/dev/null");
  });

  it("never embeds file content in the script (base64 only)", () => {
    const { plan, current } = planFor({});
    const script = [
      buildSshProbeScript(SHIPPED_SKILL_FILES.map((f) => f.relPath)),
      buildSshApplyScript({ plan, current, journal: nextJournal(plan, EMPTY_JOURNAL) }),
    ].join("");
    // The payloads travel as base64, so not one byte of a skill appears in the
    // script — which is what makes quoting and escaping a non-issue.
    for (const file of SHIPPED_SKILL_FILES) {
      const probeLine = file.content.split("\n").find((l) => l.trim().length > 30);
      if (probeLine) expect(script).not.toContain(probeLine.trim().slice(0, 30));
    }
    expect(script).toMatch(/^[\x20-\x7e\n]*$/);
    // Every directory it creates is one of ours, so it is safe for the script to
    // quote its own variables (paths are ours; content never is).
    expect(script).not.toContain("$(");
    expect(script).not.toContain("`");
  });
});

describe("the shipped bundle", () => {
  it("globs exactly the shipped skill directories, matching manifest.json", () => {
    // Vite needs literal patterns, so the ship set appears twice: in the manifest
    // and in the globs. Read the literals back out of the source — not a copy of
    // them — so adding a shipped skill to one place and not the other fails here.
    const source = readFileSync(new URL("../skill-sync.ts", import.meta.url), "utf8");
    const call = /import\.meta\.glob\(\s*\[([\s\S]*?)\]/.exec(source);
    expect(call, "import.meta.glob([...]) literal array").not.toBeNull();
    const globbed = new Set<string>();
    for (const [, pattern] of call![1]!.matchAll(/"([^"]+)"/g)) {
      // "../../skills/engineering/{a,b}/**/*" → engineering/a, engineering/b
      const brace = /\{([^}]*)\}/.exec(pattern!);
      expect(brace, `brace group in ${pattern}`).not.toBeNull();
      const prefix = pattern!.slice(0, brace!.index).replace("../../skills/", "");
      for (const name of brace![1]!.split(",")) globbed.add(prefix + name);
    }
    expect([...globbed].sort()).toEqual(shippedSkillDirs().sort());
  });

  it("carries no dev-only skill, and no manifest or NOTICE", () => {
    const shipped = SHIPPED_SKILL_FILES.map((f) => f.relPath);
    for (const devOnly of ["productivity/grilling", "engineering/codebase-design", "engineering/grill-with-docs"]) {
      expect(shipped.some((rel) => rel.startsWith(`${devOnly}/`))).toBe(false);
    }
    expect(shipped).not.toContain("manifest.json");
    expect(shipped).not.toContain("NOTICE.md");
    // 42% of the skill bytes in the repo are dev-only; this is the number that
    // decides whether the literal-glob split is still worth it.
    const bytes = SHIPPED_SKILL_FILES.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
    expect(bytes).toBeLessThan(60_000);
  });
});

/** A plan for a remote (or local) state described by `existing`, using only the
 *  real shipped bundle. `{}` means nothing is there yet. */
function planFor(existing: Record<string, string>): { plan: SkillSyncPlan; current: Record<string, string | null> } {
  const current: Record<string, string | null> = {};
  for (const file of SHIPPED_SKILL_FILES) current[file.relPath] = existing[file.relPath] ?? null;
  return { plan: planSkillSync(current, EMPTY_JOURNAL), current };
}

describe("the key-auth ssh transport", () => {
  /** A fake remote: an in-memory "disk" plus a `run` that speaks the probe and
   *  apply protocols, so the whole loop is exercised the way ssh would drive it
   *  — including that the SECOND run's classification depends on what the FIRST
   *  run wrote (the journal), which is exactly what used to be impossible. */
  function fakeRemote(initial: Record<string, string> = {}): {
    run: SshScriptRunner;
    disk: Map<string, string>;
    calls: { command: string; stdin: string }[];
  } {
    const disk = new Map(Object.entries(initial));
    const calls: { command: string; stdin: string }[] = [];
    const run: SshScriptRunner = async ({ command, stdin = "" }) => {
      calls.push({ command, stdin });
      if (command !== "sh -s") return { ok: false, code: 1, stdout: "", stderr: "bad option", error: "exit 1" };
      if (stdin.includes("@@j") && stdin.includes("printf")) {
        // Probe: answer for exactly the paths it asked about.
        const requested = [...stdin.matchAll(/for p in (.+?); do/g)].flatMap((m) => m[1]!.split(" "));
        const out: string[] = [];
        for (const rel of requested) {
          const content = disk.get(rel);
          if (content === undefined) continue;
          out.push(`@@f ${rel}`, Buffer.from(content, "utf8").toString("base64"));
        }
        const journal = disk.get(JOURNAL_FILE);
        if (journal !== undefined) out.push("@@j", Buffer.from(journal, "utf8").toString("base64"));
        return { ok: true, code: 0, stdout: `${out.join("\n")}\n`, stderr: "" };
      }
      // Apply: replay the writes and deletes it contains.
      for (const line of stdin.split("\n")) {
        const write = /^echo (\S+) \| base64 -d > (\S+)$/.exec(line);
        if (write) {
          const rel = write[2]!.replace(/^\$HOME\/\.pi\/agent\/skills\//, "");
          disk.set(rel, Buffer.from(write[1]!, "base64").toString("utf8"));
          continue;
        }
        const remove = /^rm -f \S+\/skills\/(\S+)$/.exec(line);
        if (remove) disk.delete(remove[1]!);
      }
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };
    return { run, disk, calls };
  }

  it("installs the bundle onto an empty server and writes a journal", async () => {
    const remote = fakeRemote();
    const result = await syncSkillsViaSsh(remote.run);
    expect(result.ok).toBe(true);
    expect(result.written).toHaveLength(SHIPPED_SKILL_FILES.length);
    expect(remote.disk.get(SHIPPED_SKILL_FILES[0]!.relPath)).toBe(SHIPPED_SKILL_FILES[0]!.content);
    const journal = parseJournal(remote.disk.get(JOURNAL_FILE) ?? null);
    expect(Object.keys(journal.shipped)).toHaveLength(SHIPPED_SKILL_FILES.length);
  });

  it("is a no-op on the second run", async () => {
    const remote = fakeRemote();
    await syncSkillsViaSsh(remote.run);
    const again = await syncSkillsViaSsh(remote.run);
    expect(again).toMatchObject({ ok: true, written: [], diverged: [], retired: [] });
  });

  it("KEEPS a skill the user edited on the server (the gap this closed)", async () => {
    const remote = fakeRemote();
    await syncSkillsViaSsh(remote.run);
    // The user edits one shipped skill ON THE SERVER. Nothing can read the
    // remote but a probe, so this is the case that used to be overwritten.
    const target = "engineering/wizard/SKILL.md";
    remote.disk.set(target, "my own wizard\n");
    const result = await syncSkillsViaSsh(remote.run);

    expect(result.diverged).toEqual([target]);
    expect(result.written).not.toContain(target);
    expect(remote.disk.get(target)).toBe("my own wizard\n");
    // Still theirs on the third run — a journal that adopted it would lose it
    // on the next app update.
    expect((await syncSkillsViaSsh(remote.run)).diverged).toEqual([target]);
    expect(remote.disk.get(target)).toBe("my own wizard\n");
  });

  it("upgrades our own older copy, and a server that only lost the journal keeps the copy", async () => {
    const remote = fakeRemote();
    await syncSkillsViaSsh(remote.run);
    const target = "engineering/wizard/SKILL.md";
    // Our older version: bytes nobody has any more, but the journal remembers.
    remote.disk.set(target, "wizard v1\n");
    const journal = parseJournal(remote.disk.get(JOURNAL_FILE) ?? null);
    journal.shipped[target] = sha256("wizard v1\n");
    remote.disk.set(JOURNAL_FILE, JSON.stringify(journal));
    expect((await syncSkillsViaSsh(remote.run)).written).toContain(target);
    expect(remote.disk.get(target)).toBe(SHIPPED_SKILL_FILES.find((f) => f.relPath === target)!.content);

    // A server whose journal was deleted: our bytes are now indistinguishable
    // from a user edit, so they are KEPT. Reported, never silently replaced.
    remote.disk.delete(JOURNAL_FILE);
    remote.disk.set(target, "wizard v0\n");
    const orphan = await syncSkillsViaSsh(remote.run);
    expect(orphan.diverged).toContain(target);
    expect(remote.disk.get(target)).toBe("wizard v0\n");
  });

  it("never overwrites a file it could not read", async () => {
    const target = "engineering/wizard/SKILL.md";
    const disk = new Map([[target, "unreadable"]]);
    let probeAnswers = 0;
    const run: SshScriptRunner = async ({ stdin = "" }) => {
      if (stdin.includes("for p in")) {
        probeAnswers++;
        return { ok: true, code: 0, stdout: `@@f ${target}\n@@x ${target}\n`, stderr: "" };
      }
      const write = /^echo (\S+) \| base64 -d > (\S+)$/.exec(stdin);
      if (write) disk.set(write[2]!.replace(/^\$HOME\/\.pi\/agent\/skills\//, ""), "OVERWRITTEN");
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };
    const result = await syncSkillsViaSsh(run);
    expect(probeAnswers).toBe(1);
    expect(result.diverged).toContain(target);
    expect(disk.get(target)).toBe("unreadable");
  });

  it("retires a dropped skill it still owns, after reading it back", async () => {
    const files: ShippedSkillFile[] = [{ relPath: "engineering/keep/SKILL.md", content: "keep\n" }];
    const remote = fakeRemote();
    await syncSkillsViaSsh(remote.run, 20_000, files);
    const dropped = "engineering/gone/SKILL.md";
    remote.disk.set(dropped, "gone v1\n");
    const journal = parseJournal(remote.disk.get(JOURNAL_FILE) ?? null);
    journal.shipped[dropped] = sha256("gone v1\n");
    remote.disk.set(JOURNAL_FILE, JSON.stringify(journal));

    const before = remote.calls.length;
    const result = await syncSkillsViaSsh(remote.run, 20_000, files);
    expect(result.retired).toEqual([dropped]);
    expect(remote.disk.has(dropped)).toBe(false);
    // Three trips: the bundle probe cannot know about a path it no longer ships,
    // so retirement pays for a second probe of its own.
    expect(remote.calls.length - before).toBe(3);
  });

  it("aborts without touching the server when the retirement probe fails", async () => {
    const files: ShippedSkillFile[] = [{ relPath: "engineering/keep/SKILL.md", content: "keep\n" }];
    const remote = fakeRemote();
    await syncSkillsViaSsh(remote.run, 20_000, files);
    const dropped = "engineering/gone/SKILL.md";
    remote.disk.set(dropped, "gone v1\n");
    const journal = parseJournal(remote.disk.get(JOURNAL_FILE) ?? null);
    journal.shipped[dropped] = sha256("gone v1\n");
    remote.disk.set(JOURNAL_FILE, JSON.stringify(journal));
    const journalBefore = remote.disk.get(JOURNAL_FILE);

    // Probe 1 (the bundle) answers; the retirement probe dies.
    let probes = 0;
    const flaky: SshScriptRunner = async (options) => {
      if (options.stdin?.includes("for p in") && ++probes === 2) {
        return { ok: false, code: 255, stdout: "", stderr: "connection reset", error: "exit 255" };
      }
      return remote.run(options);
    };
    const result = await syncSkillsViaSsh(flaky, 20_000, files);
    expect(result.ok).toBe(false);
    // Nothing applied: the file is still there AND still claimed by the journal,
    // so the next connect retries instead of forgetting it forever.
    expect(remote.disk.get(dropped)).toBe("gone v1\n");
    expect(remote.disk.get(JOURNAL_FILE)).toBe(journalBefore);
    expect(parseJournal(journalBefore ?? null).shipped[dropped]).toBe(sha256("gone v1\n"));
  });

  it("retires nothing on the first sync to a fresh server", async () => {
    const remote = fakeRemote();
    const result = await syncSkillsViaSsh(remote.run);
    expect(result.retired).toEqual([]);
    // No retire candidates means no second probe: probe + apply only.
    expect(remote.calls).toHaveLength(2);
  });

  it("reports a failed probe or apply instead of throwing", async () => {
    const dead: SshScriptRunner = async () => ({ ok: false, code: 255, stdout: "", stderr: "boom", error: "exit 255" });
    await expect(syncSkillsViaSsh(dead)).resolves.toMatchObject({ ok: false, error: "exit 255" });
    const throws: SshScriptRunner = async () => {
      throw new Error("spawn exploded");
    };
    await expect(syncSkillsViaSsh(throws)).resolves.toMatchObject({ ok: false, error: "spawn exploded" });
  });
});

describe("local io adapter", () => {
  it("returns null for a missing file instead of throwing", async () => {
    const io = nodeSkillsIo(tmpDir());
    await expect(io.read("nope/SKILL.md")).resolves.toBeNull();
  });
});
