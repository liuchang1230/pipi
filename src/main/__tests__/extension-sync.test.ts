// ensureShippedExtensions — ships app-bundled pi extension sources to the
// target dir, only writing when content differs, returning what was actually
// updated. Uses a real temp dir (no Electron runtime needed).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureShippedExtensions, syncExtensionsViaSftp, SHIPPED_EXTENSIONS } from "../extension-sync";

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
