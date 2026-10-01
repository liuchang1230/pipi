// The shipped content, executed for REAL on Linux (through WSL).
//
// Both ssh transports send a content-free argv (`sh -s`) and read the real work
// from stdin, so only running them on a POSIX box proves the parts we do not
// control: the base64 round-trip, the nested `mkdir -p`, byte-exact content, the
// marker-guarded legacy retire (delete what we shipped, keep what the user
// wrote) and the journal's classification of an edited file.
//
// Everything is seeded and read back INSIDE the distro, through the same shell
// a remote host would use — nothing here depends on the app's \\wsl$ path
// mapping, which is exercised by its own tests.
//
// Skipped when no WSL distro is reachable; that is the only environment where
// this machine can run Linux at all.
//
// Opt-in on purpose: `npm test` stays hermetic and offline (see the note at the
// top of session-index.test.ts) and spawning wsl.exe also boots a distro, which
// is slow enough to time out under a full parallel run. Run it with
// `npm run smoke:skills-wsl`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSshInstallCommand,
  RETIRED_FILES,
  SHIPPED_AGENT_FILES,
  SHIPPED_EXTENSION_FILES,
  syncAgentHomeViaSsh,
} from "../extension-sync";
import { parseJournal, SHIPPED_SKILL_FILES, syncSkillsViaSsh, type SshScriptRunner } from "../skill-sync";
import { TMP_SUFFIX } from "../content-sync";

function pickDistro(): string | null {
  try {
    // `wsl -l -q` answers in UTF-16LE.
    const out = execFileSync("wsl.exe", ["-l", "-q"], { timeout: 20_000 }).toString("utf16le");
    const names = out
      .split(/\r?\n/)
      .map((line) => line.replace(/\0/g, "").trim())
      .filter((line) => line.length > 0 && !/docker-desktop/i.test(line));
    return names[0] ?? null;
  } catch {
    return null;
  }
}

const DISTRO = pickDistro();
const ENABLED = process.env.PIPI_WSL_E2E === "1";

/** Run a command inside the distro, optionally feeding `input` on stdin. */
function wsl(args: string[], input?: string): string {
  return execFileSync("wsl.exe", ["-d", DISTRO!, "--", ...args], { input, encoding: "utf8", timeout: 60_000 });
}

/** Write `content` to `path` inside the distro (base64 keeps the quoting out of it). */
function seed(path: string, content: string): void {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  wsl(["bash", "-c", `mkdir -p $(dirname ${path}) && echo ${b64} | base64 -d > ${path}`]);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `wsl.exe ... bash -s` plays the part of `ssh host sh -s`: a real shell, on a
 *  real file system, with an isolated HOME standing in for the remote user's.
 *  An SshScriptRunner never throws, so a failed call comes back as ok:false. */
function wslRunner(home: string): SshScriptRunner {
  return async ({ stdin = "" }) => {
    try {
      const stdout = wsl(["env", `HOME=${home}`, "bash", "-s"], stdin);
      return { ok: true, code: 0, stdout, stderr: "" };
    } catch (error) {
      return { ok: false, code: 1, stdout: "", stderr: String(error), error: String(error) };
    }
  };
}

/** Remove a scratch dir inside the distro, ignoring a distro that has gone away. */
function cleanup(home: string): void {
  try {
    wsl(["rm", "-rf", home]);
  } catch {
    /* the distro may be gone; the temp dir is under /tmp either way */
  }
}

describe.skipIf(!ENABLED || !DISTRO)("shipped content on real Linux (WSL)", () => {
  /**
   * The key-auth ssh transport end to end, over both roots of an agent home:
   * probe → classify → apply, executed by a real shell.
   *
   * Two properties can only be proven here — that the scripts are valid POSIX
   * (the probe's `base64`/`printf` fallbacks, the nested mkdir) and that the
   * classification reaches the right verdict on a real disk: the user's edits
   * survive while our own tampered copies are restored.
   */
  it("probes, installs both roots byte-for-byte, and keeps what the user edited", async () => {
    const home = `/tmp/pipi-e2e-ext-${process.pid}-${Date.now()}`;
    const extensions = `${home}/.pi/agent/extensions`;
    const agents = `${home}/.pi/agent/agents`;
    const spec = RETIRED_FILES[0]!;
    const retirePath = `${home}/.pi/agent/${spec.dir}/${spec.fileName}`;
    const authoredPath = `${home}/.pi/agent/${spec.dir}/keep-me.md`;
    const run = wslRunner(home);
    try {
      // Seed a pre-journal file carrying every marker (→ ours, must go) and a
      // file with no markers (→ the user's, must survive).
      seed(retirePath, spec.markers.join("\n"));
      seed(authoredPath, "mine\n");

      // 1. Empty agent home → everything lands byte-exact, on both roots.
      expect(buildSshInstallCommand()).toBe("sh -s");
      const first = await syncAgentHomeViaSsh(run, 60_000);
      expect(first.ok).toBe(true);
      expect(first.extensions.sort()).toEqual(SHIPPED_EXTENSION_FILES.map((f) => f.relPath).sort());
      expect(first.agents.sort()).toEqual(SHIPPED_AGENT_FILES.map((f) => f.relPath).sort());
      for (const { relPath, content } of SHIPPED_EXTENSION_FILES) {
        expect(wsl(["sha256sum", `${extensions}/${relPath}`]).split(" ")[0], relPath).toBe(sha256(content));
      }
      for (const { relPath, content } of SHIPPED_AGENT_FILES) {
        expect(wsl(["sha256sum", `${agents}/${relPath}`]).split(" ")[0], relPath).toBe(sha256(content));
      }
      // The retired file is gone, the user's file is not.
      expect(wsl(["bash", "-c", `test -f ${retirePath} && echo yes || echo no`]).trim()).toBe("no");
      expect(wsl(["cat", authoredPath])).toBe("mine\n");

      // 2. Second run: nothing to do, and it says so.
      const second = await syncAgentHomeViaSsh(run, 60_000);
      expect(second).toMatchObject({ ok: true, extensions: [], agents: [], diverged: [], retired: [] });

      // 3. The user tunes the delegation code and an agent definition.
      const tunedExtension = "delegation/declarations.ts";
      const tunedAgent = "reviewer.md";
      seed(`${extensions}/${tunedExtension}`, "// my declarations\n");
      seed(`${agents}/${tunedAgent}`, "my reviewer\n");
      const third = await syncAgentHomeViaSsh(run, 60_000);
      expect(third.ok).toBe(true);
      expect(third.diverged.sort()).toEqual([tunedExtension, tunedAgent].sort());
      expect(wsl(["cat", `${extensions}/${tunedExtension}`])).toBe("// my declarations\n");
      expect(wsl(["cat", `${agents}/${tunedAgent}`])).toBe("my reviewer\n");
      // …and both stay theirs after another sync: the journal did not adopt them,
      // which is what would otherwise lose the edit on the next app update.
      expect((await syncAgentHomeViaSsh(run, 60_000)).diverged.sort()).toEqual([tunedExtension, tunedAgent].sort());
      expect(wsl(["cat", `${extensions}/${tunedExtension}`])).toBe("// my declarations\n");

      // 4. Our OWN sources, in the same directory, are a different class: a
      // tampered copy is a bug, so it is restored rather than kept.
      const ours = "pipi-tree-nav.ts";
      seed(`${extensions}/${ours}`, "// tampered\n");
      const oursContent = SHIPPED_EXTENSION_FILES.find((f) => f.relPath === ours)!.content;
      const fourth = await syncAgentHomeViaSsh(run, 60_000);
      expect(fourth.extensions).toEqual([ours]);
      expect(fourth.diverged.sort()).toEqual([tunedExtension, tunedAgent].sort());
      expect(wsl(["sha256sum", `${extensions}/${ours}`]).split(" ")[0]).toBe(sha256(oursContent));
      // Every write above went through a temp file and a real `mv`; a real disk
      // is the only place that proves the rename left nothing behind (an
      // interrupted one would show up here as a stray temp).
      expect(
        wsl(["bash", "-c", `find ${home}/.pi/agent -name '*${TMP_SUFFIX}' | wc -l`]).trim(),
      ).toBe("0");

      // 5. Each root's journal records that split, so the next run is stable.
      const extJournal = parseJournal(wsl(["cat", `${extensions}/.pipi.json`]));
      // The file the user tuned is theirs now: never in `shipped` (which would
      // adopt it as ours and freeze it), always in `diverged`.
      expect(Object.keys(extJournal.shipped).sort()).toEqual(
        SHIPPED_EXTENSION_FILES.map((f) => f.relPath)
          .filter((p) => p !== tunedExtension)
          .sort(),
      );
      expect(Object.keys(extJournal.diverged)).toEqual([tunedExtension]);
      const agentJournal = parseJournal(wsl(["cat", `${agents}/.pipi.json`]));
      expect(Object.keys(agentJournal.shipped).sort()).toEqual(
        SHIPPED_AGENT_FILES.map((f) => f.relPath)
          .filter((p) => p !== tunedAgent)
          .sort(),
      );
      expect(Object.keys(agentJournal.diverged)).toEqual([tunedAgent]);
      // Nothing we installed is invisible to the journal: the extensions root
      // holds our 5 sources, the delegation tree, the journal, and the file the
      // user wrote — and nothing else.
      expect(wsl(["bash", "-c", `ls -1A ${extensions} | sort | tr '\\n' ' '`]).trim()).toBe(
        ["keep-me.md", ".pipi.json", "delegation", ...SHIPPED_EXTENSION_FILES.map((f) => f.relPath.split("/")[0]!)]
          .filter((v, i, all) => all.indexOf(v) === i)
          .sort()
          .join(" "),
      );
    } finally {
      cleanup(home);
    }
    // ~10s alone, but each wsl.exe call gets slower under a full parallel suite.
  }, 120_000);

  /**
   * The same transport for the skills tree, which shares the engine: an isolated
   * HOME, a real shell, and a journal that has to tell "the user edited this"
   * apart from "this is our older copy".
   */
  it("probes, installs, and KEEPS a skill edited inside the distro", async () => {
    const home = `/tmp/pipi-ssh-skills-${process.pid}-${Date.now()}`;
    const skills = `${home}/.pi/agent/skills`;
    const run = wslRunner(home);
    try {
      // 1. Empty server → the whole bundle lands, byte-exact.
      const first = await syncSkillsViaSsh(run, 60_000);
      expect(first.ok).toBe(true);
      expect(first.written).toHaveLength(SHIPPED_SKILL_FILES.length);
      for (const { relPath, content } of SHIPPED_SKILL_FILES) {
        expect(wsl(["sha256sum", `${skills}/${relPath}`]).split(" ")[0], relPath).toBe(sha256(content));
      }

      // 2. Second run: nothing to do, and it says so.
      expect(await syncSkillsViaSsh(run, 60_000)).toMatchObject({ ok: true, written: [], diverged: [] });

      // 3. The user edits a shipped skill ON THE SERVER.
      const edited = "engineering/wizard/SKILL.md";
      seed(`${skills}/${edited}`, "my own wizard\n");
      const third = await syncSkillsViaSsh(run, 60_000);
      expect(third.diverged).toEqual([edited]);
      expect(wsl(["cat", `${skills}/${edited}`])).toBe("my own wizard\n");

      // 4. …and it is still theirs after another sync, i.e. the journal did not
      // adopt it (which would lose the edit on the next app update).
      expect((await syncSkillsViaSsh(run, 60_000)).diverged).toEqual([edited]);
      expect(wsl(["cat", `${skills}/${edited}`])).toBe("my own wizard\n");

      // 5. Our own older copy, however, IS upgraded — the journal is what tells
      // the two cases apart.
      const journalPath = `${skills}/.pipi.json`;
      const journal = parseJournal(wsl(["cat", journalPath]));
      expect(Object.keys(journal.shipped)).toHaveLength(SHIPPED_SKILL_FILES.length - 1);
      const pristine = "productivity/handoff/SKILL.md";
      seed(`${skills}/${pristine}`, "handoff v1\n");
      const patched = parseJournal(wsl(["cat", journalPath]));
      patched.shipped[pristine] = sha256("handoff v1\n");
      seed(journalPath, `${JSON.stringify(patched, null, 2)}\n`);
      const fourth = await syncSkillsViaSsh(run, 60_000);
      expect(fourth.written).toEqual([pristine]);
      const shippedHandoff = SHIPPED_SKILL_FILES.find((f) => f.relPath === pristine)!.content;
      expect(wsl(["sha256sum", `${skills}/${pristine}`]).split(" ")[0]).toBe(sha256(shippedHandoff));
      // Every install went through a temp file and a real `mv`, and the user's
      // edit is still there afterwards.
      expect(wsl(["bash", "-c", `find ${home}/.pi/agent -name '*${TMP_SUFFIX}' | wc -l`]).trim()).toBe("0");
      // The user's edit was not collateral damage.
      expect(wsl(["cat", `${skills}/${edited}`])).toBe("my own wizard\n");
    } finally {
      cleanup(home);
    }
  }, 120_000);

  /**
   * A write that fails has to be reported.
   *
   * A shell script's exit status is the LAST command's, and the last thing this
   * one does is write the journal — so a failed `> <target>.pipi-tmp` in the
   * middle was masked by it: the app logged a successful sync, and the journal
   * claimed a file we never landed. The next connect probes that file, finds
   * bytes that match neither the bundle nor a journal entry, and concludes the
   * user edited it — after which it is never updated again. Wrong answer, kept
   * forever.
   */
  it("reports a failed write instead of a success masked by the last command", async () => {
    const home = `/tmp/pipi-e2e-writefail-${process.pid}-${Date.now()}`;
    const skills = `${home}/.pi/agent/skills`;
    const blocked = "engineering/wizard/SKILL.md";
    const run = wslRunner(home);
    try {
      // The temp path is already a directory, so the redirect fails (EISDIR) and
      // the rename — the only step that touches the target — cannot run. On a
      // real server this is EACCES or ENOSPC; the difficulty of arranging it as
      // root is why it took a test to find.
      wsl(["bash", "-c", `mkdir -p ${skills}/${blocked}${TMP_SUFFIX}`]);
      const result = await syncSkillsViaSsh(run, 60_000);
      expect(result.ok, "a failed write must not be reported as a successful sync").toBe(false);
      expect(result.error ?? "").not.toBe("");
      // And no ledger that disagrees with the disk: a journal recording the
      // blocked file as ours is what would freeze it forever.
      expect(
        wsl(["bash", "-c", `test -f ${skills}/.pipi.json && echo has-journal || echo no-journal`]).trim(),
      ).toBe("no-journal");
      expect(wsl(["bash", "-c", `test -f ${skills}/${blocked} && echo yes || echo no`]).trim()).toBe("no");
    } finally {
      cleanup(home);
    }
  }, 120_000);

  /**
   * The probe must not answer "no journal" when a journal is there but cannot be
   * read.
   *
   * An emptied ledger makes every file we ever shipped look like the user's own
   * (so they are never upgraded again), and the apply — which runs anyway, since
   * the script exits 0 — replaces the real journal with that lie. One unreadable
   * file turned into permanent, silent divergence.
   */
  it("refuses to sync when the remote journal exists but cannot be read", async () => {
    const home = `/tmp/pipi-e2e-noledger-${process.pid}-${Date.now()}`;
    const skills = `${home}/.pi/agent/skills`;
    const edited = "engineering/wizard/SKILL.md";
    const run = wslRunner(home);
    try {
      expect((await syncSkillsViaSsh(run, 60_000)).ok).toBe(true);
      seed(`${skills}/${edited}`, "my own wizard\n");
      // A directory stands in for the unreadable journal a real server can hand
      // us (root-owned, or EACCES — root bypasses chmod, a directory does not).
      wsl(["bash", "-c", `rm -f ${skills}/.pipi.json && mkdir ${skills}/.pipi.json`]);
      const result = await syncSkillsViaSsh(run, 60_000);
      expect(result.ok, "an unreadable ledger must stop the sync, not silently empty itself").toBe(false);
      expect(result.error ?? "").toMatch(/\.pipi\.json/);
      // Nothing was written and nothing was overwritten: not the file the user
      // wrote, not the journal we could not read.
      expect(wsl(["cat", `${skills}/${edited}`])).toBe("my own wizard\n");
      expect(
        wsl(["bash", "-c", `test -d ${skills}/.pipi.json && echo still-a-directory || echo replaced`]).trim(),
      ).toBe("still-a-directory");
    } finally {
      cleanup(home);
    }
  }, 120_000);
});
