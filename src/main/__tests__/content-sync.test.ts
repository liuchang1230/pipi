// The generic delivery engine: the ownership policy (只读订阅 + 偏离保留), the
// overwrite opt-out, and the fact that one root's journal says nothing about
// another root's files. Skills exercise the mechanics through skill-sync.ts;
// this file pins the parts that only show up once MORE THAN ONE kind of content
// ships (extensions/agents), which is what makes the engine generic.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildApplyScript,
  buildProbeScript,
  ensureContent,
  JOURNAL_FILE,
  nextJournal,
  nodeContentIo,
  parseJournal,
  parseProbe,
  planSync,
  sha256,
  syncContent,
  syncContentViaSsh,
  TMP_SUFFIX,
  type ShippedFile,
} from "../content-sync";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "content-sync-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const file = (relPath: string, content: string, policy?: ShippedFile["policy"]): ShippedFile => ({
  relPath,
  content,
  ...(policy ? { policy } : {}),
});

describe("ownership policy", () => {
  it("preserve (default): a divergent file is kept, overwrite: it is ours again", () => {
    const bundle = [file("kept.md", "ours v2\n"), file("ours.ts", "ours v2\n", "overwrite")];
    const current = { "kept.md": "the user's own text\n", "ours.ts": "the user's tweak\n" };
    // Both look "divergent" to a journal-less eye; only the policy separates them.
    const plan = planSync(current, { version: 1, shipped: {}, diverged: {} }, bundle);
    expect(plan.diverged).toEqual(["kept.md"]);
    expect(plan.writes.map((f) => f.relPath)).toEqual(["ours.ts"]);
  });

  it("an overwrite file is never recorded as a divergence, however it drifted", () => {
    const bundle = [file("ours.ts", "ours v2\n", "overwrite")];
    const previous = { version: 1 as const, shipped: { "ours.ts": sha256("ours v1\n") }, diverged: {} };
    const plan = planSync({ "ours.ts": "hand-edited\n" }, previous, bundle);
    expect(plan.diverged).toEqual([]);
    const journal = nextJournal(plan, previous, bundle);
    expect(journal.diverged).toEqual({});
    // …and it is recorded as ours at the NEW bytes, which is what makes the next
    // run a no-op instead of a rewrite.
    expect(journal.shipped["ours.ts"]).toBe(sha256("ours v2\n"));
  });

  it("a preserved file that diverges is recorded with the INTENT, not our hash", () => {
    const bundle = [file("kept.md", "ours v2\n")];
    const previous = { version: 1 as const, shipped: { "kept.md": sha256("ours v1\n") }, diverged: {} };
    const plan = planSync({ "kept.md": "the user's\n" }, previous, bundle);
    const journal = nextJournal(plan, previous, bundle);
    expect(journal.shipped["kept.md"]).toBeUndefined();
    expect(journal.diverged["kept.md"]).toBe(sha256("ours v2\n"));
  });
});

describe("ensureContent across two roots", () => {
  it("writes both roots on first run and reports what it wrote", () => {
    const home = tempDir();
    const ext = ensureContent(join(home, "extensions"), [file("a.ts", "A\n"), file("delegation/index.ts", "I\n")], "extensions");
    const agents = ensureContent(join(home, "agents"), [file("scout.md", "S\n")], "agents");
    expect(ext.written).toEqual(["a.ts", "delegation/index.ts"]);
    expect(agents.written).toEqual(["scout.md"]);
    expect(readFileSync(join(home, "extensions", "delegation", "index.ts"), "utf8")).toBe("I\n");
    // Each root owns its own journal: a file listed in one says nothing about
    // the other, so retiring it in extensions cannot delete agents' copy.
    expect(existsSync(join(home, "extensions", JOURNAL_FILE))).toBe(true);
    expect(existsSync(join(home, "agents", JOURNAL_FILE))).toBe(true);
    expect(parseJournal(readFileSync(join(home, "agents", JOURNAL_FILE), "utf8")).shipped).toEqual({
      "scout.md": sha256("S\n"),
    });
  });

  it("is a no-op on the second run (journal unchanged, nothing rewritten)", () => {
    const home = tempDir();
    const root = join(home, "extensions");
    ensureContent(root, [file("a.ts", "A\n")], "extensions");
    const before = readFileSync(join(root, JOURNAL_FILE), "utf8");
    const mtime = readFileSync(join(root, "a.ts"), "utf8");
    expect(ensureContent(root, [file("a.ts", "A\n")], "extensions").written).toEqual([]);
    expect(readFileSync(join(root, JOURNAL_FILE), "utf8")).toBe(before);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(mtime);
  });

  it("stops retiring a file the user replaced, even after we stop shipping it", () => {
    const home = tempDir();
    const root = join(home, "extensions");
    ensureContent(root, [file("gone.ts", "G\n"), file("kept.ts", "K\n", "overwrite")], "extensions");
    // The user replaces the file we shipped with their own…
    writeFileSync(join(root, "gone.ts"), "mine\n", "utf8");
    // …and we stop shipping both, so only the one still holding OUR bytes goes.
    const result = ensureContent(root, [file("kept.ts", "K2\n", "overwrite")], "extensions");
    expect(result.retired).toEqual([]);
    expect(readFileSync(join(root, "gone.ts"), "utf8")).toBe("mine\n");
  });

  it("deletes a retired file and the directory it leaves empty", () => {
    const home = tempDir();
    const root = join(home, "extensions");
    ensureContent(root, [file("delegation/a.ts", "A\n"), file("delegation/b.ts", "B\n")], "extensions");
    const result = ensureContent(root, [file("delegation/a.ts", "A\n")], "extensions");
    expect(result.retired).toEqual(["delegation/b.ts"]);
    expect(existsSync(join(root, "delegation", "b.ts"))).toBe(false);
    expect(existsSync(join(root, "delegation"))).toBe(true); // a.ts still there
  });

  it("survives a corrupt journal: everything looks like the user's, so nothing is touched", () => {
    const home = tempDir();
    const root = join(home, "extensions");
    mkdirSync(join(root, "delegation"), { recursive: true });
    writeFileSync(join(root, JOURNAL_FILE), "{ not json", "utf8");
    writeFileSync(join(root, "delegation", "index.ts"), "mine\n", "utf8");
    // A corrupt journal reads as empty → the file on disk matches neither our
    // bytes nor a recorded hash → it is the user's → untouched. Losing that one
    // upgrade is the safe direction; deleting their file is not.
    const result = ensureContent(root, [file("delegation/index.ts", "I\n")], "extensions");
    expect(result).toEqual({ written: [], diverged: ["delegation/index.ts"], retired: [] });
    expect(readFileSync(join(root, "delegation", "index.ts"), "utf8")).toBe("mine\n");
  });
});

describe("writes are atomic (temp file + rename)", () => {
  it("names every temp file so pi's discovery rules cannot pick it up", () => {
    // pi loads extensions/*.ts, extensions/*/index.ts, agents/*.md and any
    // directory containing SKILL.md. A leftover temp must match none of those.
    expect(TMP_SUFFIX.startsWith(".")).toBe(true);
    expect(TMP_SUFFIX.endsWith(".ts")).toBe(false);
    expect(TMP_SUFFIX.endsWith(".md")).toBe(false);
    expect(`${TMP_SUFFIX}`).not.toContain("SKILL.md");
  });

  it("leaves the old bytes AND the old journal entry when the write fails", () => {
    const home = tempDir();
    const root = join(home, "extensions");
    ensureContent(root, [file("a.ts", "ours v1\n")], "extensions");
    const journalBefore = readFileSync(join(root, JOURNAL_FILE), "utf8");
    // Block the temp path with a directory: the write of the temp file fails
    // before anything touches the target.
    mkdirSync(join(root, `a.ts${TMP_SUFFIX}`));
    const result = ensureContent(root, [file("a.ts", "ours v2\n")], "extensions");
    expect(result.written).toEqual([]);
    // The target still holds a COMPLETE file (the old one) — a truncated file
    // here is the failure mode this whole mechanism exists to prevent.
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("ours v1\n");
    // And the journal still says v1, so the next run retries the upgrade instead
    // of mistaking our own broken copy for a user edit.
    expect(readFileSync(join(root, JOURNAL_FILE), "utf8")).toBe(journalBefore);
    expect(parseJournal(journalBefore).shipped["a.ts"]).toBe(sha256("ours v1\n"));
    // Control: unblock the temp path and the very same call succeeds, so the
    // assertions above are about the blocked write and nothing else.
    rmSync(join(root, `a.ts${TMP_SUFFIX}`), { recursive: true, force: true });
    const retry = ensureContent(root, [file("a.ts", "ours v2\n")], "extensions");
    expect(retry.written).toEqual(["a.ts"]);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("ours v2\n");
  });

  it("leaves no temp file behind on a successful write", () => {
    const home = tempDir();
    const root = join(home, "extensions");
    ensureContent(root, [file("a.ts", "A\n"), file("delegation/i.ts", "I\n")], "extensions");
    expect(readdirSync(root).filter((n) => n.includes(TMP_SUFFIX))).toEqual([]);
    expect(readdirSync(join(root, "delegation")).filter((n) => n.includes(TMP_SUFFIX))).toEqual([]);
  });

  it("ignores a stale temp file from an interrupted run", () => {
    const home = tempDir();
    const root = join(home, "extensions");
    mkdirSync(join(root, "delegation"), { recursive: true });
    writeFileSync(join(root, `delegation/i.ts${TMP_SUFFIX}`), "half-writ", "utf8");
    const result = ensureContent(root, [file("delegation/i.ts", "I\n")], "extensions");
    expect(result.written).toEqual(["delegation/i.ts"]);
    expect(readFileSync(join(root, "delegation", "i.ts"), "utf8")).toBe("I\n");
    // A stale temp is never entered into the journal either.
    expect(Object.keys(parseJournal(readFileSync(join(root, JOURNAL_FILE), "utf8")).shipped)).toEqual([
      "delegation/i.ts",
    ]);
  });

  it("does the same through the async io (the WSL path)", async () => {
    const home = tempDir();
    const root = join(home, "extensions");
    await syncContent(nodeContentIo(root), [file("a.ts", "A\n")]);
    expect(readdirSync(root).filter((n) => n.includes(TMP_SUFFIX))).toEqual([]);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("A\n");
    expect(parseJournal(readFileSync(join(root, JOURNAL_FILE), "utf8")).shipped["a.ts"]).toBe(sha256("A\n"));
  });
});

describe("buildApplyScript", () => {
  it("appends the trailer as its own always-succeeding lines", () => {
    const script = buildApplyScript({
      plan: { writes: [], diverged: [], retired: [] },
      current: {},
      journal: { version: 1, shipped: {}, diverged: {} },
      remoteRoot: "$HOME/.pi/agent/extensions",
      trailer: "( test -f $HOME/.pi/agent/agents/planner.md && rm -f $HOME/.pi/agent/agents/planner.md || true )\n",
    });
    const lines = script.trim().split("\n");
    expect(lines.at(-1)).toBe(
      "( test -f $HOME/.pi/agent/agents/planner.md && rm -f $HOME/.pi/agent/agents/planner.md || true )",
    );
    // The journal is still written before the trailer, so a failed legacy retire
    // cannot lose the classification of everything we just installed.
    expect(script.indexOf(JOURNAL_FILE)).toBeLessThan(script.indexOf("planner.md"));
    // Every line is complete on its own: `sh -s` reads to EOF.
    expect(script.endsWith("\n")).toBe(true);
  });

  it("installs each file through a temp file and renames it into place", () => {
    const files = [file("x.ts", "X\n"), file("delegation/i.ts", "I\n")];
    files[0]!.policy = "overwrite";
    const plan = planSync({}, { version: 1, shipped: {}, diverged: {} }, files);
    const script = buildApplyScript({
      plan,
      current: {},
      journal: nextJournal(plan, { version: 1, shipped: {}, diverged: {} }, files),
      remoteRoot: "$HOME/.pi/agent/extensions",
    });
    const lines = script.split("\n");
    // `set -e` is first and load-bearing: a script's exit status is its LAST
    // command's, and the last thing here is the journal write. Without it, a
    // failed write in the middle is masked (`ok: true`, "synced"), and the
    // journal claims a file we never landed — which the next connect reads as
    // "the user edited it", freezing it forever.
    expect(lines[0]).toBe("set -e");
    let installs = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes("base64 -d >")) continue;
      installs++;
      // The decode and the rename are SEPARATE statements. They cannot share an
      // `&&`: `set -e` does not fire on the left-hand side of one (a pipeline
      // whose status is being tested is exempt), so the classic one-liner is
      // masked exactly when it matters.
      const m = /^echo (\S+) \| base64 -d > (\S+)\.pipi-tmp$/.exec(line);
      expect(m, line).not.toBeNull();
      const target = m![2]!;
      const tmp = `${target}${TMP_SUFFIX}`;
      expect(target).toContain("$HOME/.pi/agent/extensions/");
      // …and the target is only ever touched by the rename, which is adjacent.
      expect(lines[i + 1]).toBe(`mv -f ${tmp} ${target}`);
    }
    expect(installs).toBe(3); // two files + the journal
    // The ledger is the LAST thing written, which is what makes the abort safe:
    // a failure anywhere above it leaves the OLD journal in place, so the next
    // connect can still tell our copies from the user's edits.
    const body = script.trimEnd().split("\n");
    expect(body[body.length - 2]).toContain(`${JOURNAL_FILE}${TMP_SUFFIX}`);
    expect(body[body.length - 1]).toBe(
      `mv -f $HOME/.pi/agent/extensions/${JOURNAL_FILE}${TMP_SUFFIX} $HOME/.pi/agent/extensions/${JOURNAL_FILE}`,
    );
  });

  it("cleans up the temp of a file it retires", () => {
    const files = [file("gone.ts", "G\n")];
    const previous = { version: 1 as const, shipped: { "gone.ts": sha256("G\n") }, diverged: {} };
    const plan = planSync({ "gone.ts": "G\n" }, previous, []);
    const script = buildApplyScript({ plan, current: { "gone.ts": "G\n" }, journal: previous, remoteRoot: "$R" });
    expect(script).toContain("rm -f $R/gone.ts\n");
    expect(script).toContain(`rm -f $R/gone.ts${TMP_SUFFIX}`);
    // Deliberately NOT `|| true`: a retire that fails (a root-owned file, a
    // non-empty directory in the way) has to stop the script, because stopping
    // keeps the journal entry and the next connect retries. Swallowing it would
    // drop the entry while the file is still there — a retired extension that
    // pi keeps loading, invisible from then on. Verified on real Linux: the
    // script exits 1 and the journal is never written.
    expect(script).not.toContain("rm -f $R/gone.ts || true");
    expect(script).not.toContain(`rm -f $R/gone.ts${TMP_SUFFIX} || true`);
    // The bundle itself never contains a relPath that ends in the temp suffix,
    // so a retired temp can never collide with a real file.
    expect(files.some((f) => f.relPath.endsWith(TMP_SUFFIX))).toBe(false);
  });

  it("writes nothing twice: an unchanged file is not in the payload", () => {
    const files = [file("a.ts", "A\n")];
    const journal = { version: 1 as const, shipped: { "a.ts": sha256("A\n") }, diverged: {} };
    const plan = planSync({ "a.ts": "A\n" }, journal, files);
    const script = buildApplyScript({ plan, current: { "a.ts": "A\n" }, journal, remoteRoot: "$HOME/.pi/agent" });
    expect(script.split("\n").filter((line) => line.includes("a.ts"))).toEqual([]);
  });
});

/**
 * The probe's second job — after "what are the bytes there" — is to say whether
 * there is a journal it could READ. "Absent" means a fresh server; "present but
 * unreadable" means we cannot tell our copies from the user's, and the only safe
 * answer is to touch nothing.
 */
describe("the probe tells an absent journal apart from an unreadable one", () => {
  const script = () => buildProbeScript(["a.ts"], "$HOME/.pi/agent/skills");

  it("tests for existence, not for file-ness, and marks a failed read", () => {
    expect(script()).toContain(`if [ -e $HOME/.pi/agent/skills/${JOURNAL_FILE} ]; then`);
    // `|| printf` rather than `|| true`: the old form swallowed the failure and
    // the parse then saw an EMPTY journal — a lie the apply went on to write
    // back to the remote, destroying the real one.
    expect(script()).toContain("base64 $HOME/.pi/agent/skills/.pipi.json 2>/dev/null || printf '@@ju\\n'");
    expect(script()).not.toContain("${JOURNAL_FILE}\\n' 2>/dev/null || true");
  });

  it("parses the three answers: absent, unreadable, readable", () => {
    expect(parseProbe("")).toMatchObject({ journalUnreadable: false, journal: { shipped: {}, diverged: {} } });
    const unreadable = parseProbe("@@f a.ts\nQUJD\n@@j\n@@ju\n");
    expect(unreadable.journalUnreadable).toBe(true);
    // …and the marker line is not mistaken for payload: the file's bytes still
    // arrive intact.
    expect(unreadable.files["a.ts"]).toBe("ABC");
    const readable = parseProbe(`@@j\n${Buffer.from(JSON.stringify({ version: 1, shipped: { "a.ts": "h" }, diverged: {} })).toString("base64")}\n`);
    expect(readable.journalUnreadable).toBe(false);
    expect(readable.journal.shipped).toEqual({ "a.ts": "h" });
  });

  it("refuses to apply anything when the journal cannot be read", async () => {
    const calls: string[] = [];
    const result = await syncContentViaSsh(
      async ({ stdin = "" }) => {
        calls.push(stdin);
        return { ok: true, code: 0, stdout: "@@j\n@@ju\n", stderr: "" };
      },
      { remoteRoot: "$HOME/.pi/agent/skills", label: "[skills]" },
      [file("a.ts", "A\n")],
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`.pipi.json`);
    // One trip: the probe. No apply, no retirement probe, nothing written.
    expect(calls).toHaveLength(1);
    expect(result.written).toEqual([]);
  });
});
