// ensureShippedExtensions — ships app-bundled pi extension sources to the
// target dir, only writing when content differs, returning what was actually
// updated. Uses a real temp dir (no Electron runtime needed).
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureShippedExtensions,
  syncExtensionsViaSftp,
  buildSshInstallCommand,
  buildSshCatCommand,
  SHIPPED_EXTENSIONS,
  RETIRED_FILES,
  retireShippedFiles,
  shouldRetire,
} from "../extension-sync";

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

describe("ensureShippedExtensions", () => {
  it("writes all shipped extensions on first run and returns their names", () => {
    const dir = tempDir();
    const updated = ensureShippedExtensions(dir);
    expect(updated.length).toBeGreaterThan(0);
    for (const name of updated) {
      expect(existsSync(join(dir, name))).toBe(true);
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
    // Corrupt one file: the next sync must rewrite exactly that one.
    const target = join(dir, updated[0]!);
    writeFileSync(target, "// tampered\n", "utf8");
    expect(ensureShippedExtensions(dir)).toEqual([updated[0]]);
    expect(existsSync(target)).toBe(true);
  });
});

describe("buildSshInstallCommand", () => {
  it("produces a quote-free install command covering every shipped extension", () => {
    const cmd = buildSshInstallCommand();
    expect(cmd.startsWith("mkdir -p $HOME/.pi/agent/extensions && ")).toBe(true);
    // The command crosses Windows spawn → ssh.exe → remote bash: any quote
    // would need escaping, so the command must be entirely quote-free.
    expect(cmd).not.toMatch(/['"]/);
    for (const { fileName, content } of SHIPPED_EXTENSIONS) {
      expect(cmd).toContain(`echo ${Buffer.from(content, "utf8").toString("base64")} | base64 -d > $HOME/.pi/agent/extensions/${fileName}`);
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
      },
      puts,
      mkdirs,
    };
  }

  it("uploads every shipped extension to the remote agent extensions dir (missing files reject on get)", async () => {
    const { client, puts, mkdirs } = mockClient(new Map());
    const result = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(result.ok).toBe(true);
    expect(puts.length).toBe(SHIPPED_EXTENSIONS.length);
    for (const p of puts) {
      expect(p.path.startsWith("/home/user/.pi/agent/extensions/")).toBe(true);
      expect(p.content.toString("utf8").length).toBeGreaterThan(0);
    }
    expect(mkdirs).toContain("/home/user/.pi/agent/extensions");
  });

  it("honors an absolute agentDir override when computing the remote base", async () => {
    const { client, puts } = mockClient(new Map());
    const result = await syncExtensionsViaSftp(client as never, "/home/user", "/srv/shared-pi");
    expect(result.ok).toBe(true);
    for (const p of puts) expect(p.path.startsWith("/srv/shared-pi/extensions/")).toBe(true);
  });

  it("expands a ~/ agentDir override against the remote home", async () => {
    const { client, puts } = mockClient(new Map());
    const result = await syncExtensionsViaSftp(client as never, "/home/user", "~/shared-pi");
    expect(result.ok).toBe(true);
    for (const p of puts) expect(p.path.startsWith("/home/user/shared-pi/extensions/")).toBe(true);
  });

  it("skips files whose remote content already matches (string or Buffer)", async () => {
    const existing = new Map<string, string | Buffer>();
    SHIPPED_EXTENSIONS.forEach(({ fileName, content }, i) => {
      const path = `/home/user/.pi/agent/extensions/${fileName}`;
      existing.set(path, i % 2 === 0 ? Buffer.from(content, "utf8") : content);
    });
    const { client, puts } = mockClient(existing);
    const result = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(result.ok).toBe(true);
    expect(puts.length).toBe(0);
    expect(result.uploaded.length).toBe(0);
  });

  it("re-uploads a file that drifted from the shipped content", async () => {
    const file = SHIPPED_EXTENSIONS[0]!;
    const existing = new Map<string, string | Buffer>([
      [`/home/user/.pi/agent/extensions/${file.fileName}`, "// tampered\n"],
    ]);
    const { client, puts } = mockClient(existing);
    const result = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(result.ok).toBe(true);
    const re = puts.find((p) => p.path.endsWith(`/${file.fileName}`));
    expect(re).toBeDefined();
    expect(re!.content.toString("utf8")).toBe(file.content);
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

  it("reports partial progress when the second upload fails", async () => {
    const { client, puts } = mockClient(new Map());
    const original = (client as { put: (c: Buffer, p: string) => Promise<void> }).put.bind(client);
    let putCount = 0;
    (client as { put: (c: Buffer, p: string) => Promise<void> }).put = async (c, p) => {
      putCount += 1;
      if (putCount === 2) throw new Error("disk full");
      return original(c, p);
    };
    const result = await syncExtensionsViaSftp(client as never, "/home/user", undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disk full");
    expect(puts.length).toBe(1);
    expect(result.uploaded.length).toBe(1);
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

  it("the ssh install command retires guarded by our markers (and stays quote-free)", () => {
    const cmd = buildSshInstallCommand();
    expect(cmd).not.toMatch(/['"]/);
    for (const spec of RETIRED_FILES) {
      const path = `$HOME/.pi/agent/${spec.dir}/${spec.fileName}`;
      expect(cmd).toContain(`( test -f ${path}`);
      expect(cmd).toContain(`rm -f ${path}`);
      // every marker must be probed before the delete
      for (const m of spec.markers) {
        const b64 = Buffer.from(m, "utf8").toString("base64");
        expect(cmd).toContain(`grep -q $(echo ${b64} | base64 -d) ${path}`);
      }
    }
  });
});
