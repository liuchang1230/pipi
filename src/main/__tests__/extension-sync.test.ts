// extension-sync — the two roots of an agent home (extensions/, agents/) and the
// ownership rules that separate app-owned sources from text the user tunes. The
// policy mechanics live in content-sync.ts (see content-sync.test.ts); this file
// pins how the app applies them: what ships, to which root, over which
// transport, and what each transport reports.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSshInstallCommand,
  buildSshRetireTrailer,
  ensureShippedAgentHome,
  ensureShippedAgents,
  ensureShippedExtensions,
  RETIRED_FILES,
  retireShippedFiles,
  shouldRetire,
  SHIPPED_AGENT_FILES,
  SHIPPED_EXTENSION_FILES,
  syncAgentHomeViaSsh,
  syncExtensionsViaSftp,
  buildSshCatCommand,
  SHIPPED_EXTENSIONS,
} from "../extension-sync";
import { JOURNAL_FILE, parseJournal } from "../content-sync";
import type { SshRunResult } from "../ssh-exec";

let dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "extsync-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("the shipped bundle", () => {
  it("puts our 5 sources at the extension root and the delegation tree underneath", () => {
    const relPaths = SHIPPED_EXTENSION_FILES.map((f) => f.relPath);
    expect(relPaths).toEqual(
      expect.arrayContaining(["pipi-tree-nav.ts", "delegation/index.ts", "delegation/engine.ts"]),
    );
    // pi's discovery rule for a directory extension is extensions/<name>/index.ts,
    // so the delegation tree has to be complete, not just present.
    expect(relPaths.filter((p) => p.startsWith("delegation/"))).toHaveLength(5);
  });

  it("marks our own sources overwrite and the user-tunable text preserve", () => {
    for (const file of SHIPPED_EXTENSION_FILES) {
      const ours = SHIPPED_EXTENSIONS.some((e) => e.fileName === file.relPath);
      expect(file.policy === "overwrite", file.relPath).toBe(ours);
    }
    // Agent definitions are prompts people tune → never overwritten.
    for (const file of SHIPPED_AGENT_FILES) expect(file.policy).toBeUndefined();
    expect(SHIPPED_AGENT_FILES.map((f) => f.relPath)).toEqual(["analyst.md", "reviewer.md", "scout.md"]);
  });

  it("ships the same bytes the bundle carries, including CRLF", () => {
    // The sources are embedded verbatim via `?raw`: a normalizing step here would
    // make every already-installed copy on every machine look like a user edit
    // (the journal hash would no longer match) and freeze the upgrade path.
    const nav = SHIPPED_EXTENSIONS.find((e) => e.fileName === "pipi-tree-nav.ts")!;
    expect(nav.content).toBe(readFileSync(join(__dirname, "..", "extensions", "pipi-tree-nav.ts"), "utf8"));
  });
});

describe("ensureShippedExtensions", () => {
  it("writes all shipped extensions on first run and returns their names", () => {
    const dir = tempDir();
    const updated = ensureShippedExtensions(dir);
    expect(updated.length).toBeGreaterThan(0);
    for (const name of updated) {
      expect(existsSync(join(dir, ...name.split("/")))).toBe(true);
    }
  });

  it("returns an empty list when nothing changed on the second run", () => {
    const dir = tempDir();
    expect(ensureShippedExtensions(dir).length).toBeGreaterThan(0);
    expect(ensureShippedExtensions(dir)).toEqual([]);
  });

  it("returns only the changed file after one file is modified", () => {
    const dir = tempDir();
    const updated = ensureShippedExtensions(dir);
    expect(updated.length).toBeGreaterThan(1);
    // Corrupt one of OUR files: the next sync must rewrite exactly that one.
    const target = join(dir, updated[0]!);
    writeFileSync(target, "// tampered\n", "utf8");
    expect(ensureShippedExtensions(dir)).toEqual([updated[0]]);
    expect(existsSync(target)).toBe(true);
  });

  it("keeps a delegation file the user edited, and says so", () => {
    const dir = tempDir();
    ensureShippedExtensions(dir);
    const tuned = join(dir, "delegation", "declarations.ts");
    writeFileSync(tuned, "// my own declarations\n", "utf8");
    // Their bytes stay (they are running that code) …
    expect(ensureShippedExtensions(dir)).toEqual([]);
    expect(readFileSync(tuned, "utf8")).toBe("// my own declarations\n");
    // … and the divergence is an explicit state in the journal, not silence.
    const journal = parseJournal(readFileSync(join(dir, JOURNAL_FILE), "utf8"));
    expect(Object.keys(journal.diverged)).toEqual(["delegation/declarations.ts"]);
    expect(journal.shipped["delegation/declarations.ts"]).toBeUndefined();
  });
});

describe("ensureShippedAgents / ensureShippedAgentHome", () => {
  it("writes agent definitions into agents/, not into extensions/", () => {
    const home = tempDir();
    expect(ensureShippedAgents(join(home, "agents")).length).toBe(SHIPPED_AGENT_FILES.length);
    expect(existsSync(join(home, "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(home, "extensions", "reviewer.md"))).toBe(false);
  });

  it("provisions both roots and reports their journals separately", () => {
    const home = tempDir();
    const result = ensureShippedAgentHome(home);
    expect(result.extensions).toHaveLength(SHIPPED_EXTENSION_FILES.length);
    expect(result.agents).toHaveLength(SHIPPED_AGENT_FILES.length);
    expect(result.diverged).toEqual([]);
    // Separate journals: retiring a file in one root cannot touch the other.
    const extJournal = parseJournal(readFileSync(join(home, "extensions", JOURNAL_FILE), "utf8"));
    const agentJournal = parseJournal(readFileSync(join(home, "agents", JOURNAL_FILE), "utf8"));
    expect(Object.keys(extJournal.shipped)).toHaveLength(SHIPPED_EXTENSION_FILES.length);
    expect(Object.keys(agentJournal.shipped)).toHaveLength(SHIPPED_AGENT_FILES.length);
  });

  it("is a no-op on the second run and takes the legacy retire with it", () => {
    const home = tempDir();
    ensureShippedAgentHome(home);
    const again = ensureShippedAgentHome(home);
    expect(again.extensions).toEqual([]);
    expect(again.agents).toEqual([]);
    expect(again.retired).toEqual([]);
    // A pre-journal file carrying our markers is removed by the same call.
    const legacy = join(home, "agents", "planner.md");
    writeFileSync(legacy, RETIRED_FILES[1]!.markers.join("\n"), "utf8");
    expect(ensureShippedAgentHome(home).retired).toEqual([legacy]);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe("key-auth ssh transport (unit shape)", () => {
  /** A fake remote: records the scripts it is handed and answers from a queue. */
  function fakeRunner(responses: Array<Partial<SshRunResult>>) {
    const calls: Array<{ command: string; stdin: string }> = [];
    const run = async (options: { command: string; stdin?: string }) => {
      calls.push({ command: options.command, stdin: options.stdin ?? "" });
      const answer = responses[calls.length - 1] ?? { ok: true };
      return { ok: true, code: 0, stdout: "", stderr: "", ...answer } as SshRunResult;
    };
    return { run, calls };
  }

  it("keeps the command content-free no matter how large the shipped set is", () => {
    // Regression: the install used to embed every extension as base64 IN THE
    // COMMAND LINE. Windows caps a command line at 32,767 characters and spawn
    // throws ENAMETOOLONG *synchronously* past it — so adding
    // pipi-approval-gate.ts (17.6KB) made syncKeyAuthExtensions throw out of the
    // tab:create handler on every key-auth connect. The argv must never grow
    // with the payload; the payload rides on stdin.
    expect(buildSshInstallCommand()).toBe("sh -s");
    expect(buildSshInstallCommand().length).toBeLessThan(64);
  });

  it("sends one probe→apply per root, extensions first, and the retire only with them", async () => {
    const { run, calls } = fakeRunner([{}, {}, {}, {}]);
    const result = await syncAgentHomeViaSsh(run, 20_000);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.command === "sh -s")).toBe(true);
    // Probe then apply, and the two roots never share a trip: the probe has to
    // report the remote's own bytes for THIS root before the plan is made.
    expect(calls[0]!.stdin).toContain(".pi/agent/extensions");
    expect(calls[1]!.stdin).toContain("delegation/index.ts");
    expect(calls[2]!.stdin).toContain(".pi/agent/agents");
    expect(calls[3]!.stdin).toContain("reviewer.md");
    // The pre-journal retire rides on the extensions apply (no extra round trip).
    expect(calls[1]!.stdin).toContain("pipi-mode-switch.ts");
    expect(calls[3]!.stdin).not.toContain("pipi-mode-switch.ts");
    // Every payload line is `<base64> | base64 -d > <path>`: the bytes never
    // touch the shell as text, and only the (quote-free, space-free) remote paths
    // do. The probe's own shell syntax may quote freely — it is a script, not an
    // argv — but the bytes we install must never need escaping.
    for (const call of calls) {
      expect(call.command).not.toMatch(/['"]/);
      for (const line of call.stdin.split("\n")) {
        if (line.includes("base64 -d >")) expect(line).not.toMatch(/['"]/);
      }
    }
    expect(result.extensions).toHaveLength(SHIPPED_EXTENSION_FILES.length);
    expect(result.agents).toHaveLength(SHIPPED_AGENT_FILES.length);
  });

  it("aborts before the agents root when the extensions probe fails", async () => {
    const { run, calls } = fakeRunner([{ ok: false, error: "no route to host" }]);
    const result = await syncAgentHomeViaSsh(run, 20_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no route to host");
    expect(calls).toHaveLength(1);
  });

  it("fails the whole call when only the agents half fails, so the digest is not marked done", async () => {
    const { run, calls } = fakeRunner([{}, {}, { ok: false, error: "permission denied" }]);
    const result = await syncAgentHomeViaSsh(run, 20_000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission denied");
    // The extensions half DID land, and the caller still retries everything next
    // connect — re-syncing is a no-op for what already arrived.
    expect(result.extensions).toHaveLength(SHIPPED_EXTENSION_FILES.length);
    expect(calls).toHaveLength(3);
  });
});

describe("buildSshRetireTrailer", () => {
  it("retires guarded by our markers, quote-free, without failing the script", () => {
    const trailer = buildSshRetireTrailer();
    expect(trailer).not.toMatch(/['"]/);
    for (const spec of RETIRED_FILES) {
      const path = `$HOME/.pi/agent/${spec.dir}/${spec.fileName}`;
      expect(trailer).toContain(`( test -f ${path}`);
      expect(trailer).toContain(`rm -f ${path}`);
      // every marker must be probed before the delete, and every clause must be
      // unable to fail the apply (the trailer is the last thing the shell runs).
      for (const m of spec.markers) {
        const b64 = Buffer.from(m, "utf8").toString("base64");
        expect(trailer).toContain(`grep -q $(echo ${b64} | base64 -d) ${path}`);
      }
      expect(trailer).toMatch(/rm -f [^\n]*\|\| true \)/);
    }
  });
});

describe("buildSshCatCommand", () => {
  it("embeds the path as base64 and cats the decoded result", () => {
    const path = "/home/user/.pi/agent/sessions/--D-其余文件-项目-agent--/x.jsonl";
    const cmd = buildSshCatCommand(path);
    const b64 = Buffer.from(path, "utf8").toString("base64");
    expect(cmd).toContain(b64);
    expect(cmd).toContain("cat \"$P\"");
    // The raw path must not appear — it would need quoting to cross the
    // Windows spawn → ssh.exe → bash chain (spaces / CJK).
    expect(cmd).not.toContain(path);
    // Round-trip: the embedded b64 decodes back to the path.
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(path);
  });
});

describe("syncExtensionsViaSftp", () => {
  /** Remote file store: missing file → get() REJECTS, like real
   *  ssh2-sftp-client. Values are stored as Buffers where the caller
   *  uploaded one, strings otherwise, to exercise both compare branches. */
  function mockClient(remoteFiles: Map<string, string | Buffer>) {
    const puts: Array<{ path: string; content: Buffer }> = [];
    const mkdirs: string[] = [];
    const deleted: string[] = [];
    const renames: Array<{ from: string; to: string; how: "posix" | "plain" }> = [];
    // Every real SFTP server we care about (OpenSSH) implements
    // posix-rename@openssh.com; tests override this to exercise the fallbacks.
    let posixRenameFails = false;
    return {
      client: {
        mkdir: async (dir: string) => {
          mkdirs.push(dir);
        },
        get: async (path: string) => {
          const v = remoteFiles.get(path);
          if (v === undefined) throw new Error("No such file");
          return v;
        },
        put: async (content: Buffer, path: string) => {
          puts.push({ path, content });
          remoteFiles.set(path, content);
        },
        delete: async (path: string) => {
          deleted.push(path);
          remoteFiles.delete(path);
        },
        posixRename: async (from: string, to: string) => {
          if (posixRenameFails) throw new Error("Operation unsupported");
          if (!remoteFiles.has(from)) throw new Error(`No such file: ${from}`);
          renames.push({ from, to, how: "posix" });
          remoteFiles.set(to, remoteFiles.get(from)!);
          remoteFiles.delete(from);
        },
        rename: async (from: string, to: string) => {
          if (!remoteFiles.has(from)) throw new Error(`No such file: ${from}`);
          renames.push({ from, to, how: "plain" });
          remoteFiles.set(to, remoteFiles.get(from)!);
          remoteFiles.delete(from);
        },
      },
      puts,
      mkdirs,
      deleted,
      renames,
      failPosixRename: () => {
        posixRenameFails = true;
      },
    };
  }

  it("uploads both roots on the first sync, journals included", async () => {
    const files = new Map<string, string | Buffer>();
    const { client, puts, mkdirs } = mockClient(files);
    const result = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(result.ok).toBe(true);
    // put() only ever targets a temp path; the live paths appear because the
    // rename put them there (so they are complete files, never partial ones).
    for (const p of puts) expect(p.path).toMatch(/\.pipi-tmp$/);
    const installed = [...files.keys()];
    expect(installed).toContain("/home/user/.pi/agent/extensions/delegation/index.ts");
    expect(installed).toContain("/home/user/.pi/agent/agents/reviewer.md");
    expect(installed).toContain("/home/user/.pi/agent/extensions/.pipi.json");
    expect(installed).toContain("/home/user/.pi/agent/agents/.pipi.json");
    expect(installed).toHaveLength(SHIPPED_EXTENSION_FILES.length + SHIPPED_AGENT_FILES.length + 2);
    expect(mkdirs).toContain("/home/user/.pi/agent/extensions");
    expect(mkdirs).toContain("/home/user/.pi/agent/agents");
    expect(result.uploaded).toHaveLength(SHIPPED_EXTENSION_FILES.length + SHIPPED_AGENT_FILES.length);
    expect(result.uploaded).toContain("/home/user/.pi/agent/extensions/delegation/index.ts");
  });

  it("honors an absolute agentDir override when computing the remote base", async () => {
    const { client, puts } = mockClient(new Map());
    const result = await syncExtensionsViaSftp(client as never, "/home/user", "/srv/shared-pi");
    expect(result.ok).toBe(true);
    for (const p of puts) expect(p.path.startsWith("/srv/shared-pi/")).toBe(true);
    expect(result.uploaded.some((p) => p.startsWith("/srv/shared-pi/agents/"))).toBe(true);
  });

  it("expands a ~/ agentDir override against the remote home", async () => {
    const { client, puts } = mockClient(new Map());
    const result = await syncExtensionsViaSftp(client as never, "/home/user", "~/shared-pi");
    expect(result.ok).toBe(true);
    for (const p of puts) expect(p.path.startsWith("/home/user/shared-pi/")).toBe(true);
  });

  it("is a no-op on the second sync (the journal is what makes it idempotent)", async () => {
    const files = new Map<string, string | Buffer>();
    const { client, puts } = mockClient(files);
    await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    puts.length = 0;
    const second = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(second.ok).toBe(true);
    expect(puts).toEqual([]);
    expect(second.uploaded).toEqual([]);
  });

  it("re-uploads an app-owned extension that drifted, but keeps a tuned delegation file", async () => {
    const files = new Map<string, string | Buffer>();
    const first = mockClient(files);
    await syncExtensionsViaSftp(first.client as never, "/home/user", undefined);
    first.renames.length = 0;
    // The user tweaks the delegation code ON THE SERVER, and something else
    // tampers with one of our own sources.
    const tuned = "/home/user/.pi/agent/extensions/delegation/engine.ts";
    const ours = "/home/user/.pi/agent/extensions/pipi-tree-nav.ts";
    files.set(tuned, "// my engine\n");
    files.set(ours, "// tampered\n");
    const second = await syncExtensionsViaSftp(first.client as never, "/home/user", undefined);
    expect(second.ok).toBe(true);
    const touched = first.renames.map((r) => r.to);
    expect(touched).toContain(ours);
    expect(touched).not.toContain(tuned);
    expect(files.get(tuned)).toBe("// my engine\n");
    expect(second.uploaded).not.toContain(tuned);
    // Whatever the server says about it, the journal records the divergence so
    // the next sync does not adopt their file as ours.
    const journal = parseJournal(files.get("/home/user/.pi/agent/extensions/.pipi.json")!.toString());
    expect(Object.keys(journal.diverged)).toContain("delegation/engine.ts");
  });

  it("reports a failure without throwing when mkdir rejects", async () => {
    const { client } = mockClient(new Map());
    (client as { mkdir: (d: string) => Promise<void> }).mkdir = async () => {
      throw new Error("permission denied");
    };
    const result = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission denied");
  });

  it("claims nothing when an upload fails midway (the next sync redoes that root)", async () => {
    const { client } = mockClient(new Map());
    let putCount = 0;
    const original = (client as { put: (c: Buffer, p: string) => Promise<void> }).put.bind(client);
    (client as { put: (c: Buffer, p: string) => Promise<void> }).put = async (c, p) => {
      putCount += 1;
      if (putCount === 2) throw new Error("disk full");
      return original(c, p);
    };
    const result = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disk full");
    // No journal was written for that root, so nothing is marked as ours there:
    // the whole root is simply re-uploaded on the next connect.
    expect(result.uploaded).toEqual([]);
  });

  /**
   * Atomicity: files are uploaded to `<target>.pipi-tmp` and renamed over the
   * target, so an interrupted sync can never leave a truncated file where the
   * next run would find it, hash it, and file it under "the user edited this".
   */
  it("installs through a temp file plus rename, never a direct overwrite", async () => {
    const files = new Map<string, string | Buffer>();
    const { client, renames } = mockClient(files);
    await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    const target = "/home/user/.pi/agent/extensions/pipi-tree-nav.ts";
    expect(renames).toContainEqual({ from: `${target}.pipi-tmp`, to: target, how: "posix" });
    // Every uploaded path is a temp path; nothing is ever put() straight onto a
    // live target (a half-written extension file would be loaded by pi).
    for (const p of files.keys()) expect(p.endsWith(".pipi-tmp")).toBe(false);
  });

  it("falls back to plain rename when the server has no posix-rename extension", async () => {
    const files = new Map<string, string | Buffer>();
    const mock = mockClient(files);
    mock.failPosixRename();
    const result = await syncExtensionsViaSftp(mock.client as never, "/home/user", undefined);
    expect(result.ok).toBe(true);
    expect(mock.renames.length).toBeGreaterThan(0);
    expect(mock.renames.every((r) => r.how === "plain")).toBe(true);
    expect(mock.deleted).toEqual([]); // rename clobbered the target on its own
  });

  it("deletes the target then renames, when the server refuses to clobber", async () => {
    const files = new Map<string, string | Buffer>();
    const mock = mockClient(files);
    await syncExtensionsViaSftp(mock.client as never, "/home/user", undefined);
    // A server with no posix-rename that ALSO refuses to rename onto an existing
    // file: the only way left is delete-then-rename.
    mock.failPosixRename();
    (mock.client as { rename: (f: string, t: string) => Promise<void> }).rename = async (from, to) => {
      if (files.has(to)) throw new Error("Failure: target exists");
      files.set(to, files.get(from)!);
      files.delete(from);
    };
    // Drift one of our own files so there is something to write at all (the
    // journal says everything else is already ours).
    const target = "/home/user/.pi/agent/extensions/pipi-tree-nav.ts";
    files.set(target, "// tampered\n");
    mock.deleted.length = 0;
    const second = await syncExtensionsViaSftp(mock.client as never, "/home/user", undefined);
    expect(second.ok).toBe(true);
    expect(mock.deleted).toEqual([target]);
    expect(files.get(target)?.toString()).toContain("pipi-tree-nav");
    // Nothing was left behind half-written or as a stray temp.
    expect([...files.keys()].filter((k) => k.endsWith(".pipi-tmp"))).toEqual([]);
  });

  it("keeps the previous bytes when the upload itself fails", async () => {
    const files = new Map<string, string | Buffer>();
    const mock = mockClient(files);
    const target = "/home/user/.pi/agent/extensions/pipi-tree-nav.ts";
    await syncExtensionsViaSftp(mock.client as never, "/home/user", undefined);
    const before = files.get(target);
    // Now make the next upload of THAT file fail at the put() step.
    const original = (mock.client as { put: (c: Buffer, p: string) => Promise<void> }).put.bind(mock.client);
    (mock.client as { put: (c: Buffer, p: string) => Promise<void> }).put = async (c, p) => {
      if (p === `${target}.pipi-tmp`) throw new Error("connection reset");
      return original(c, p);
    };
    files.set(target, "// tampered\n");
    files.delete("/home/user/.pi/agent/extensions/.pipi.json");
    const result = await syncExtensionsViaSftp(mock.client as never, "/home/user", undefined);
    expect(result.ok).toBe(false);
    // The temp never became the target: the file on the server is still the
    // (tampered) copy it was, not a half-written one, and the journal does not
    // claim the new bytes as ours.
    expect(files.get(target)).toBe("// tampered\n");
    expect(before).toBeDefined();
  });
});

/**
 * Retirement: a file we no longer ship must be DELETED, not ignored — pi
 * auto-loads every .ts under extensions/, so a retired extension left on disk
 * keeps running (the app would only stop rendering its UI). Deleting a user's
 * own file, on the other hand, would be worse: recognize ours by exact bytes or
 * by all markers, never by file name alone.
 */
describe("retireShippedFiles", () => {
  it("recognizes our bytes by hash, our runs by markers, and nothing else", () => {
    const spec = { dir: "extensions" as const, fileName: "x.ts", sha256: createHash("sha256").update("exact", "utf8").digest("hex"), markers: ["marker-one", "marker-two"] };
    expect(shouldRetire("exact", spec)).toBe(true);
    expect(shouldRetire(["marker-one", "marker-two"].join("\n"), spec)).toBe(true);
    expect(shouldRetire("marker-one only", spec)).toBe(false);
    expect(shouldRetire("somebody else's file", spec)).toBe(false);
  });

  it("every retired file ships a full sha256 and space-free markers (remote one-liner)", () => {
    for (const spec of RETIRED_FILES) {
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      for (const m of spec.markers) expect(m).not.toMatch(/\s/);
    }
  });

  it("removes a file that carries every marker (an older shipped version)", () => {
    const home = mkdtempSync(join(tmpdir(), "retire-"));
    const dir = join(home, "agents");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "planner.md");
    writeFileSync(target, "---\nname: planner\n---\nYou are a planning specialist.\nREAD-ONLY.\n", "utf8");
    expect(retireShippedFiles(home)).toEqual([target]);
    expect(existsSync(target)).toBe(false);
  });

  it("leaves a user's own file alone and returns nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "retire-"));
    const dir = join(home, "prompts");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "scout-and-plan.md");
    writeFileSync(target, "---\ndescription: my own prompt\n---\nDo the thing.\n", "utf8");
    expect(retireShippedFiles(home)).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });

  it("is a no-op when the files are already gone", () => {
    expect(retireShippedFiles(mkdtempSync(join(tmpdir(), "retire-")))).toEqual([]);
  });
});
