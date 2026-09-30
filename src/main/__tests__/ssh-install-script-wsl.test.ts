// The extension install script, executed for REAL on Linux (through WSL).
//
// buildSshInstallScript() travels on stdin into `sh -s` on the remote host, so
// only running it on a POSIX box proves the parts we do not control: the base64
// round-trip, the nested `mkdir -p`, byte-exact content, and the marker-guarded
// retire (delete what we shipped, keep what the user wrote).
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
  buildSshInstallScript,
  RETIRED_FILES,
  SHIPPED_EXTENSIONS,
} from "../extension-sync";
import {
  parseJournal,
  SHIPPED_SKILL_FILES,
  syncSkillsViaSsh,
  type SshScriptRunner,
} from "../skill-sync";

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

describe.skipIf(!ENABLED || !DISTRO)("install script on real Linux (WSL)", () => {
  /** The install script itself is not what this proves; running it on Linux is. */
  it("installs every shipped file byte-for-byte, and retires only files carrying our markers", () => {
    const home = `/tmp/pipi-e2e-${process.pid}-${Date.now()}`;
    const extensions = `${home}/.pi/agent/extensions`;
    const spec = RETIRED_FILES[0]!;
    const retirePath = `${home}/.pi/agent/${spec.dir}/${spec.fileName}`;
    const authoredPath = `${home}/.pi/agent/${spec.dir}/keep-me.md`;
    try {
      // Seed the retired file (carrying every marker → ours, must go) and a file
      // with no markers (→ the user's, must survive).
      seed(retirePath, spec.markers.join("\n"));
      seed(authoredPath, "mine\n");

      // The real thing: the command over argv, the script over stdin.
      expect(buildSshInstallCommand()).toBe("sh -s");
      wsl(["bash", "-c", `HOME=${home} bash -s`], buildSshInstallScript());

      for (const { fileName, content } of SHIPPED_EXTENSIONS) {
        expect(wsl(["sha256sum", `${extensions}/${fileName}`]).split(" ")[0], `${fileName} content`).toBe(
          sha256(content),
        );
      }
      expect(wsl(["bash", "-c", `test -f ${retirePath} && echo yes || echo no`]).trim()).toBe("no");
      expect(wsl(["bash", "-c", `test -f ${authoredPath} && echo yes || echo no`]).trim()).toBe("yes");
      expect(wsl(["cat", authoredPath])).toBe("mine\n");
      // Exactly the 5 shipped extensions plus the file the "user" wrote.
      const expected = ["keep-me.md", ...SHIPPED_EXTENSIONS.map((e) => e.fileName)].sort().join(" ");
      expect(wsl(["bash", "-c", `ls -1 ${extensions} | sort | tr '\\n' ' '`]).trim()).toBe(expected);
    } finally {
      try {
        wsl(["rm", "-rf", home]);
      } catch {
        /* the distro may be gone; the temp dir is under /tmp either way */
      }
    }
    // ~5s alone, but each wsl.exe call gets slower under a full parallel suite.
  }, 30_000);

  /**
   * The key-auth ssh transport, against real Linux: `wsl.exe ... bash -s` plays
   * the part of `ssh host sh -s`, so the probe and apply scripts are executed by
   * a real shell on a real file system, with an isolated HOME standing in for
   * the remote user's home dir.
   *
   * This is the case that used to be a silent overwrite: nothing can read a
   * passwordless server's files except these round trips, so "the user edited
   * this skill on the server" was invisible. Here the edit is made in the
   * distro and must survive.
   */
  it("probes, installs, and KEEPS a skill edited inside the distro", async () => {
    const home = `/tmp/pipi-ssh-skills-${process.pid}-${Date.now()}`;
    const skills = `${home}/.pi/agent/skills`;
    const run: SshScriptRunner = async ({ stdin = "" }) => {
      try {
        const stdout = wsl(["env", `HOME=${home}`, "bash", "-s"], stdin);
        return { ok: true, code: 0, stdout, stderr: "" };
      } catch (error) {
        return { ok: false, code: 1, stdout: "", stderr: String(error), error: String(error) };
      }
    };
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
      // The user's edit was not collateral damage.
      expect(wsl(["cat", `${skills}/${edited}`])).toBe("my own wizard\n");
    } finally {
      try {
        wsl(["rm", "-rf", home]);
      } catch {
        /* the distro may be gone; the temp dir is under /tmp either way */
      }
    }
  }, 120_000);
});
