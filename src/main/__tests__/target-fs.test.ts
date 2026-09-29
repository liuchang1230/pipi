// TargetFs — interface-level tests over an in-memory channel.
//
// What this file pins down is the *contract*, not any transport: path algebra
// and containment, the truncation window math, mutation pre-conditions (exists
// / not-found / invalid name), cache-key invalidation, and the channel-selection
// rule. Because the channel is in-memory, a regression here is a contract
// regression, not a filesystem accident — the same trick as
// session-index's setWslPathMapperForTests. The real adapters get their own
// tmpdir/真 fs coverage.
//
// POSIX semantics are driven through the posix binding and Windows semantics
// through a win binding, so neither depends on the machine running the tests
// (the module takes the dialect from the binding, not from process.platform).
import { describe, expect, it, vi } from "vitest";
import { win32 as winPath } from "node:path";
import {
  classifyError,
  createTargetFs,
  dialectOf,
  isTargetFsError,
  isValidName,
  localTarget,
  sftpTarget,
  sshTarget,
  targetKey,
  TEXT_PREVIEW_HALF_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  wslTarget,
  type Binding,
  type Channel,
  type TargetFs,
  type TargetFsDeps,
  type TreeCache,
} from "../target-fs";
import type { FileNode } from "../file-tree";
import type { RemoteOpts } from "../pty";

interface Entry {
  type: "file" | "directory";
  content?: Buffer;
}

/** Minimal in-memory filesystem addressed by absolute POSIX paths. */
function memChannel(initial: Record<string, string | Buffer> = {}) {
  const nodes = new Map<string, Entry>();
  for (const [p, v] of Object.entries(initial)) {
    if (v === undefined) {
      nodes.set(p, { type: "directory" });
      continue;
    }
    nodes.set(p, { type: "file", content: Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8") });
    const parts = p.split("/").slice(1);
    let cur = "";
    for (const part of parts.slice(0, -1)) {
      cur += `/${part}`;
      if (!nodes.has(cur)) nodes.set(cur, { type: "directory" });
    }
  }
  const calls: string[] = [];
  const notFound = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const channel: Channel = {
    async list(absDir) {
      calls.push(`list:${absDir}`);
      if (!nodes.has(absDir)) throw notFound();
      const prefix = absDir.endsWith("/") ? absDir : `${absDir}/`;
      const out = [];
      for (const [p, e] of nodes) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        out.push({ name: rest, type: e.type });
      }
      return out;
    },
    async stat(absPath) {
      calls.push(`stat:${absPath}`);
      const e = nodes.get(absPath);
      return e ? { type: e.type, size: e.content?.length ?? 0 } : null;
    },
    async readRange(absPath, start, length) {
      calls.push(`range:${absPath}:${start}:${length}`);
      const e = nodes.get(absPath);
      if (!e?.content) throw notFound();
      return e.content.subarray(start, start + length);
    },
    async readAll(absPath) {
      calls.push(`read:${absPath}`);
      const e = nodes.get(absPath);
      if (!e?.content) throw notFound();
      return e.content;
    },
    async writeText(absPath, content) {
      calls.push(`write:${absPath}`);
      nodes.set(absPath, { type: "file", content: Buffer.from(content, "utf8") });
    },
    async mkdirp(absDir) {
      calls.push(`mkdirp:${absDir}`);
      if (!nodes.has(absDir)) nodes.set(absDir, { type: "directory" });
    },
    async remove(absPath, type) {
      calls.push(`remove:${type}:${absPath}`);
      nodes.delete(absPath);
    },
    async rename(fromAbs, toAbs) {
      calls.push(`rename:${fromAbs}->${toAbs}`);
      const e = nodes.get(fromAbs);
      if (!e) return;
      nodes.delete(fromAbs);
      nodes.set(toAbs, e);
    },
  };
  return { channel, calls, nodes };
}

const posixBinding = (channel: Channel, home = "/home/u"): Binding => ({
  channel,
  dialect: "posix",
  toNative: (p) => p,
  isNative: (p) => p.startsWith("/"),
  home: async () => home,
});

/** Windows binding: identity mapper (the channel is fed Windows paths). */
const winBinding = (channel: Channel, home = "C:\\Users\\u"): Binding => ({
  channel,
  dialect: "win",
  toNative: (p) => p,
  isNative: (p) => winPath.isAbsolute(p),
  home: async () => home,
});

function depsWith(channel: Channel, overrides: Partial<TargetFsDeps> = {}): TargetFsDeps {
  const b = posixBinding(channel);
  return { local: b, wsl: () => b, sftp: () => b, ssh: () => b, ...overrides };
}

/** POSIX-path target (WSL with an identity mapper) — the dialect most tests
 *  care about. */
function posixFs(root: string, channel: Channel, overrides: Partial<TargetFsDeps> = {}): TargetFs {
  return createTargetFs(wslTarget("Ubuntu", root), depsWith(channel, overrides));
}

const REMOTE: RemoteOpts = { host: "h", user: "u", path: "~" } as RemoteOpts;

describe("TargetFs · target kinds", () => {
  it("has one constructor per channel: auth is not a channel choice", () => {
    expect(sftpTarget({ ...REMOTE, password: "pw" }, "~").kind).toBe("sftp");
    // A key-auth server browses over SFTP too (agent/default keys) — the ssh
    // channel is only the session-file fast path, never the browse channel.
    expect(sftpTarget(REMOTE, "~").kind).toBe("sftp");
    expect(sshTarget(REMOTE, "~").kind).toBe("ssh");
  });

  it("keys the cache by target AND root, so two roots never share", () => {
    expect(targetKey(localTarget("C:\\a"))).not.toBe(targetKey(localTarget("C:\\b")));
    expect(targetKey(wslTarget("Ubuntu", "/p"))).toContain("wsl:Ubuntu");
    expect(targetKey(sftpTarget({ ...REMOTE, password: "pw", port: 2222, agentDir: "~/d" }, "~"))).toBe(
      "sftp:u@h:2222[~/d]\0~"
    );
  });

  it("refuses to build on an empty or relative root instead of resolving against the CWD", () => {
    expect(() => posixFs("", memChannel({}).channel)).toThrow(/root must be absolute/);
    expect(() => posixFs("relative/dir", memChannel({}).channel)).toThrow(/root must be absolute/);
    expect(() => posixFs("  ", memChannel({}).channel)).toThrow(/root must be absolute/);
  });

  it("exports a default dialect helper that follows the host for local targets", () => {
    expect(dialectOf(wslTarget("Ubuntu", "/p"))).toBe("posix");
    expect(dialectOf(sftpTarget(REMOTE, "~"))).toBe("posix");
    expect(dialectOf(localTarget("C:\\p"))).toBe(process.platform === "win32" ? "win" : "posix");
  });
});

describe("TargetFs · list", () => {
  it("is domain-preserving: relative in → relative out", async () => {
    const { channel } = memChannel({ "/p/src/a.ts": "a", "/p/readme.md": "r" });
    const fs = posixFs("/p", channel);
    // directories first, then files — the order the renderer expects
    expect((await fs.list(".")).map((n) => n.path)).toEqual(["src", "readme.md"]);
    expect(await fs.list("src")).toEqual([{ name: "a.ts", path: "src/a.ts", type: "file" }]);
  });

  it("leaves directories unexpanded so the renderer can inject children", async () => {
    const { channel } = memChannel({ "/p/src/deep/x.ts": "x" });
    const fs = posixFs("/p", channel);
    expect(await fs.list("src")).toEqual([{ name: "deep", path: "src/deep", type: "directory", children: undefined }]);
  });

  it("navigates freely: an absolute or ~ dir is NOT contained by the root", async () => {
    const { channel, calls } = memChannel({ "/home/u/other/x.ts": "x" });
    const fs = posixFs("/p", channel);
    expect((await fs.list("/home/u/other")).map((n) => n.path)).toEqual(["/home/u/other/x.ts"]);
    expect(await fs.list("~")).toEqual([{ name: "other", path: "/home/u/other", type: "directory", children: undefined }]);
    expect(calls).toContain("list:/home/u");
  });

  it("shows everything by default (the picker must reach node_modules) and filters only for the tree", async () => {
    const { channel } = memChannel({ "/p/node_modules/x": "x", "/p/.config/c": "c", "/p/a.ts": "a" });
    const all = await posixFs("/p", channel).list(".");
    expect(all.map((n) => n.name)).toEqual([".config", "node_modules", "a.ts"]);

    const tree = await posixFs("/p", channel, { filter: "tree" }).list(".");
    expect(tree.map((n) => n.name)).toEqual(["a.ts"]);
  });

  it("maps to the channel's native space (WSL → \\\\wsl$ UNC) while keeping paths in the browse domain", async () => {
    const nativePaths: string[] = [];
    const channel: Channel = {
      ...memChannel({}).channel,
      list: async (nativeDir) => {
        nativePaths.push(nativeDir);
        return [{ name: "x.ts", type: "file" }];
      },
    };
    const fs = createTargetFs(wslTarget("Ubuntu", "/home/u/p"), {
      ...depsWith(channel),
      wsl: () => ({
        channel,
        dialect: "posix",
        toNative: (p) => `\\\\wsl$\\Ubuntu${p.replace(/\//g, "\\")}`,
        isNative: (p) => p.startsWith("\\\\"),
        home: async () => "/home/u",
      }),
    });
    expect((await fs.list(".")).map((n) => n.path)).toEqual(["x.ts"]);
    expect(nativePaths).toEqual(["\\\\wsl$\\Ubuntu\\home\\u\\p"]);
  });

  it("reports a missing directory as a classified not-found (the caller decides)", async () => {
    const { channel } = memChannel({ "/p/a.txt": "a" });
    await expect(posixFs("/p", channel).list("gone")).rejects.toMatchObject({ kind: "not-found" });
  });

  it("surfaces permission problems instead of pretending the directory is empty", async () => {
    const channel: Channel = {
      ...memChannel({}).channel,
      list: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    await expect(posixFs("/p", channel).list("x")).rejects.toMatchObject({ kind: "denied" });
  });

  it("serves a cached listing, invalidates the ancestor chain, and honours fresh", async () => {
    const { channel, calls } = memChannel({ "/p/src/a.ts": "a" });
    const store = new Map<string, FileNode[]>();
    const cache: TreeCache = {
      cached: (k) => store.get(k),
      refresh: async (k, walk) => {
        const nodes = await walk();
        store.set(k, nodes);
        return nodes;
      },
      invalidate: (k) => {
        store.delete(k);
      },
    };
    const fs = posixFs("/p", channel, { cache });
    const first = await fs.list("src");
    expect(await fs.list("src")).toBe(first);
    expect(calls.filter((c) => c === "list:/p/src")).toHaveLength(1);

    // The same directory spelled with a trailing separator is the same entry,
    // and the child paths must not grow a second slash.
    expect(await fs.list("src/")).toBe(first);
    expect(first.map((n) => n.path)).toEqual(["src/a.ts"]);

    expect(await fs.list("src", { fresh: true })).not.toBe(first); // auto-follow bypass
    expect(calls.filter((c) => c === "list:/p/src")).toHaveLength(2);

    // A write deep inside the tree can change the listing of every ancestor.
    await fs.invalidate(["src/deep/nested/a.ts"]);
    expect(store.size).toBe(0);
  });

  it("invalidates through aliases of the same directory, and leaves unrelated entries alone", async () => {
    const { channel } = memChannel({ "/home/u/p/src/a.ts": "a", "/other/x.ts": "x" });
    const store = new Map<string, FileNode[]>();
    const cache: TreeCache = {
      cached: (k) => store.get(k),
      refresh: async (k, walk) => {
        const nodes = await walk();
        store.set(k, nodes);
        return nodes;
      },
      invalidate: (k) => {
        store.delete(k);
      },
    };
    const fs = posixFs("~/p", channel, { cache });
    await fs.list("~"); // cached under the EXPANDED path
    await fs.list("src");
    await fs.list("/other");
    expect(store.size).toBe(3);

    // A mutation reported as a root-relative path must drop the `~` listing…
    await fs.invalidate(["src/a.ts"]);
    expect(store.size).toBe(1); // …but not the sibling root `/other`
  });

  it("keeps one directory's tree and picker listings apart in the cache", async () => {
    const { channel, calls } = memChannel({ "/p/node_modules/x": "x", "/p/a.ts": "a" });
    const store = new Map<string, FileNode[]>();
    const cache: TreeCache = {
      cached: (k) => store.get(k),
      refresh: async (k, walk) => {
        const nodes = await walk();
        store.set(k, nodes);
        return nodes;
      },
      invalidate: (k) => {
        store.delete(k);
      },
    };
    const fs = posixFs("/p", channel, { cache });
    // One instance, one directory, two filters: whichever ran first must not
    // answer for the other (a shared entry hides node_modules from the picker,
    // or leaks it into the project tree).
    expect((await fs.list(".", { filter: "tree" })).map((n) => n.name)).toEqual(["a.ts"]);
    expect((await fs.list(".", { filter: "all" })).map((n) => n.name)).toEqual(["node_modules", "a.ts"]);
    expect((await fs.list(".", { filter: "tree" })).map((n) => n.name)).toEqual(["a.ts"]);
    expect(calls.filter((c) => c === "list:/p")).toHaveLength(2); // two walks, not three
  });

  it("drops EVERY filter variant of an ancestor when a path is invalidated", async () => {
    const { channel, calls } = memChannel({ "/p/src/a.ts": "a" });
    const store = new Map<string, FileNode[]>();
    const cache: TreeCache = {
      cached: (k) => store.get(k),
      refresh: async (k, walk) => {
        const nodes = await walk();
        store.set(k, nodes);
        return nodes;
      },
      invalidate: (k) => {
        store.delete(k);
      },
    };
    const fs = posixFs("/p", channel, { cache });
    await fs.list(".", { filter: "tree" });
    await fs.list("src", { filter: "tree" });
    await fs.list("src", { filter: "all" });
    const walks = calls.filter((c) => c === "list:/p/src").length;
    // A mutation inside `src` invalidates `src`; if only the filter that
    // happens to be asked for were dropped, the OTHER variant would keep
    // answering from cache and the picker would miss the new file.
    await fs.invalidate(["src/a.ts"]);
    await fs.list("src", { filter: "tree" });
    await fs.list("src", { filter: "all" });
    await fs.list("src", { filter: "tree" }); // cached again
    expect(calls.filter((c) => c === "list:/p/src").length).toBe(walks + 2);
  });

  it("refreshes a stale listing after its own mutations", async () => {
    const { channel } = memChannel({ "/p/src/a.ts": "a" });
    const store = new Map<string, FileNode[]>();
    const cache: TreeCache = {
      cached: (k) => store.get(k),
      refresh: async (k, walk) => {
        const nodes = await walk();
        store.set(k, nodes);
        return nodes;
      },
      invalidate: (k) => {
        store.delete(k);
      },
    };
    const fs = posixFs("/p", channel, { cache });
    expect((await fs.list("src")).map((n) => n.name)).toEqual(["a.ts"]);
    await fs.writeText("src/b.ts", "b");
    expect((await fs.list("src")).map((n) => n.name)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("TargetFs · error contract", () => {
  it("phrases a missing file the way the renderer's retry predicate expects", async () => {
    const { channel } = memChannel({ "/p/a.ts": "a" });
    const fs = posixFs("/p", channel);
    // `viewerStore` auto-follows a file the write tool just created by retrying
    // while the error still reads as "not found yet" — the wording is part of
    // the interface, not cosmetics.
    for (const run of [() => fs.readPreview("gone.ts"), () => fs.remove("gone.ts"), () => fs.rename("gone.ts", "b.ts")]) {
      const err = await run().then(
        () => null,
        (e: unknown) => e
      );
      expect(isTargetFsError(err)).toBe(true);
      expect((err as Error).message).toMatch(/ENOENT|No such file/);
      expect((err as { kind: string }).kind).toBe("not-found");
    }
  });

  it("classifies a channel's own error and keeps its raw text", () => {
    const err = classifyError(Object.assign(new Error("ENOENT: no such file or directory, stat '/p/x'"), { code: "ENOENT" }), "/p/x");
    expect(err.kind).toBe("not-found");
    expect(err.message).toContain("/p/x");
  });
});

describe("TargetFs · containment", () => {
  it("rejects traversal out of the root but allows .. that stays inside", async () => {
    const { channel } = memChannel({ "/p/readme.md": "r" });
    const fs = posixFs("/p", channel);
    await expect(fs.readPreview("../secrets")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.readPreview("../../etc/passwd")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.readPreview("/etc/passwd")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.writeText("", "x")).rejects.toMatchObject({ kind: "escape" });
    // A backslash is an ordinary filename character in POSIX, so this is
    // simply a file that is not there — not an escape (Windows is different,
    // see the dialect suite below).
    await expect(fs.readPreview("..\\secrets")).rejects.toMatchObject({ kind: "not-found" });
    // `src/../readme.md` never leaves the root, so it is legal (the local
    // adapter accepted it too).
    await expect(fs.readPreview("src/../readme.md")).resolves.toMatchObject({ bytes: 1 });
  });

  it("does not confuse a sibling with a shared name prefix", async () => {
    const { channel } = memChannel({ "/p2/secrets": "s" });
    const fs = posixFs("/p", channel);
    await expect(fs.readPreview("/p2/secrets")).rejects.toMatchObject({ kind: "escape" });
    // A root written with a trailing separator behaves the same.
    const trailing = posixFs("/p/", channel);
    await expect(trailing.readPreview("a.ts")).rejects.toMatchObject({ kind: "not-found" });
    await expect(trailing.readPreview("/p2/secrets")).rejects.toMatchObject({ kind: "escape" });
  });

  it("refuses to operate on the root itself", async () => {
    const { channel } = memChannel({ "/p/a.ts": "a" });
    const fs = posixFs("/p", channel);
    await expect(fs.remove(".")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.rename(".", "x")).rejects.toMatchObject({ kind: "escape" });
  });

  it("accepts an absolute path INSIDE the root (the remote wire shape)", async () => {
    const { channel } = memChannel({ "/p/src/a.ts": "hello" });
    const fs = createTargetFs(sftpTarget({ ...REMOTE, password: "pw" }, "/p"), depsWith(channel));
    expect(await fs.readPreview("/p/src/a.ts")).toEqual({ content: "hello", bytes: 5, isBinary: false });
  });

  it("expands a ~ root once, in dialect space", async () => {
    const { channel, calls } = memChannel({ "/home/u/p/a.ts": "a" });
    const fs = posixFs("~/p", channel);
    await fs.readPreview("a.ts");
    await fs.readPreview("a.ts");
    expect(calls).toContain("read:/home/u/p/a.ts");
    expect(calls).toContain("stat:/home/u/p/a.ts");
  });
});

describe("TargetFs · Windows dialect (host-independent)", () => {
  const winFs = (root: string, channel: Channel, overrides: Partial<TargetFsDeps> = {}) =>
    createTargetFs(localTarget(root), { ...depsWith(channel, { local: winBinding(channel) }), ...overrides });

  it("contains case-insensitively (C:\\Foo and c:\\foo are one directory)", async () => {
    const { channel } = memChannel({ "/p/a.ts": "a" });
    const fs = winFs("c:\\p", channel);
    await expect(fs.readPreview("C:\\P\\a.ts")).rejects.toMatchObject({ kind: "not-found" }); // reached the channel
    await expect(fs.readPreview("c:/p/a.ts")).rejects.toMatchObject({ kind: "not-found" });
    await expect(fs.readPreview("C:\\other\\a.ts")).rejects.toMatchObject({ kind: "escape" });
  });

  it("rejects segments Windows silently rewrites (`.. ` opens the parent)", async () => {
    const { channel } = memChannel({ "/p/a.ts": "a" });
    const fs = winFs("C:\\p", channel);
    await expect(fs.readPreview("..\\secrets")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.readPreview(".. \\Windows\\win.ini")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.readPreview("dir.\\x")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.writeText("...\\x", "x")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.remove(" dir")).rejects.toMatchObject({ kind: "escape" });
    // A sibling that merely shares the prefix is not inside the root.
    await expect(fs.readPreview("C:\\p2\\x")).rejects.toMatchObject({ kind: "escape" });
  });

  it("treats ~ and UNC roots as absolute, with either separator", async () => {
    const { channel, calls } = memChannel({});
    const fs = winFs("~\\proj", channel);
    await fs.list("src").catch(() => undefined);
    expect(calls.some((c) => c === "list:C:\\Users\\u\\proj\\src")).toBe(true);

    const fwd = winFs("~/proj", channel);
    await fwd.list("src").catch(() => undefined);
    expect(calls.some((c) => c === "list:C:\\Users\\u\\proj\\src")).toBe(true);

    // readText must accept `~/...` on Windows too (session paths).
    await expect(fwd.readText("~/file.jsonl")).rejects.toMatchObject({ kind: "not-found" });
    expect(calls).toContain("read:C:\\Users\\u\\file.jsonl");

    const unc = createTargetFs(localTarget("\\\\wsl$\\Ubuntu\\home\\u\\p"), {
      ...depsWith(channel, { local: winBinding(channel) }),
    });
    await expect(unc.readPreview("a.ts")).rejects.toMatchObject({ kind: "not-found" });

    // `//server/share` is absolute for Node, so it must be absolute here too.
    const share = createTargetFs(localTarget("//server/share"), {
      ...depsWith(channel, { local: winBinding(channel) }),
    });
    await expect(share.readPreview("a.ts")).rejects.toMatchObject({ kind: "not-found" });
  });
});

describe("TargetFs · preview policy", () => {
  it("reads small text whole and flags binary without an image payload", async () => {
    const { channel } = memChannel({ "/p/a.txt": "hi", "/p/b.bin": Buffer.from([0, 1, 2, 3]) });
    const fs = posixFs("/p", channel);
    expect(await fs.readPreview("a.txt")).toEqual({ content: "hi", bytes: 2, isBinary: false });
    const b = await fs.readPreview("b.bin");
    expect(b.isBinary).toBe(true);
    expect(b.image).toBeUndefined();
  });

  it("attaches a base64 payload for a small raster image", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16, 0)]);
    const { channel } = memChannel({ "/p/i.png": png });
    const fs = posixFs("/p", channel);
    const r = await fs.readPreview("i.png");
    expect(r.isBinary).toBe(true);
    expect(r.image?.mimeType).toBe("image/png");
    expect(r.image?.base64).toBe(png.toString("base64"));
  });

  it("returns an empty payload for a zero-byte file", async () => {
    const { channel } = memChannel({ "/p/empty.txt": "" });
    const fs = posixFs("/p", channel);
    expect(await fs.readPreview("empty.txt")).toEqual({ content: "", bytes: 0, isBinary: false });
  });

  it("reads a file of exactly the cap whole", async () => {
    const body = Buffer.alloc(TEXT_PREVIEW_MAX_BYTES, 0x61);
    const { channel, calls } = memChannel({ "/p/at.log": body });
    const fs = posixFs("/p", channel);
    const r = await fs.readPreview("at.log");
    expect(r.truncated).toBeUndefined();
    expect(r.bytes).toBe(TEXT_PREVIEW_MAX_BYTES);
    expect(calls).toContain("read:/p/at.log");
  });

  it("samples head+tail one byte over the cap and never reads it whole", async () => {
    const size = TEXT_PREVIEW_MAX_BYTES + 1;
    const body = Buffer.alloc(size, 0x61); // 'a'
    body.write("HEAD", 0);
    body.write("TAIL", size - 4);
    const { channel, calls } = memChannel({ "/p/big.log": body });
    const fs = posixFs("/p", channel);
    const r = await fs.readPreview("big.log");
    expect(r.bytes).toBe(size);
    expect(r.truncated).toBe(true);
    expect(r.content.startsWith("HEAD")).toBe(true);
    expect(r.content.endsWith("TAIL")).toBe(true);
    expect(calls).toEqual([
      "stat:/p/big.log",
      "range:/p/big.log:0:524288",
      `range:/p/big.log:${size - TEXT_PREVIEW_HALF_BYTES}:524288`,
    ]);
  });

  it("still pays for the full read when an oversize raster needs its base64", async () => {
    const size = 1024 * 1024 + 8;
    const png = Buffer.alloc(size, 0); // NUL bytes → binary sample
    png.write("PNG", 0);
    const { channel, calls } = memChannel({ "/p/big.png": png });
    const fs = posixFs("/p", channel);
    expect((await fs.readPreview("big.png")).image).toBeDefined();
    expect(calls).toContain("read:/p/big.png");
  });

  it("reports not-found as a classified error", async () => {
    const { channel } = memChannel({});
    const fs = posixFs("/p", channel);
    await expect(fs.readPreview("nope.txt")).rejects.toMatchObject({ kind: "not-found" });
  });
});

describe("TargetFs · mutations", () => {
  it("creates parent directories on write", async () => {
    const { channel, calls } = memChannel({ "/p": undefined as unknown as string });
    const fs = posixFs("/p", channel);
    await fs.writeText("deep/nested/a.txt", "hi");
    expect(calls).toEqual(["mkdirp:/p/deep/nested", "write:/p/deep/nested/a.txt"]);
  });

  it("mkdir is a no-op for an existing directory and refuses a file in the way", async () => {
    const { channel, calls } = memChannel({ "/p/dir": undefined as unknown as string, "/p/f.txt": "f" });
    const fs = posixFs("/p", channel);
    await fs.mkdir("dir");
    expect(calls.filter((c) => c === "mkdirp:/p/dir")).toHaveLength(0);
    await expect(fs.mkdir("f.txt")).rejects.toMatchObject({ kind: "exists" });
    await fs.mkdir("new");
    expect(calls).toContain("mkdirp:/p/new");
  });

  it("remove reports not-found and tells the channel whether it was a directory", async () => {
    const { channel, calls } = memChannel({ "/p/a.txt": "a", "/p/dir/x": "x" });
    const fs = posixFs("/p", channel);
    await fs.remove("a.txt");
    await fs.remove("dir");
    expect(calls).toContain("remove:file:/p/a.txt");
    expect(calls).toContain("remove:directory:/p/dir");
    await expect(fs.remove("a.txt")).rejects.toMatchObject({ kind: "not-found" });
  });

  it("rename validates the name, refuses an occupied target, and no-ops on the same name", async () => {
    const { channel, calls } = memChannel({ "/p/a.txt": "a", "/p/taken.txt": "t" });
    const fs = posixFs("/p", channel);
    await expect(fs.rename("a.txt", "x/y")).rejects.toMatchObject({ kind: "invalid-name" });
    await expect(fs.rename("a.txt", "..")).rejects.toMatchObject({ kind: "invalid-name" });
    await expect(fs.rename("a.txt", "x.")).rejects.toMatchObject({ kind: "invalid-name" });
    await expect(fs.rename("a.txt", "taken.txt")).rejects.toMatchObject({ kind: "exists" });
    await expect(fs.rename("gone.txt", "x.txt")).rejects.toMatchObject({ kind: "not-found" });
    // A missing source renamed to its own name must not look like success.
    await expect(fs.rename("gone.txt", "gone.txt")).rejects.toMatchObject({ kind: "not-found" });
    await fs.rename("a.txt", "a.txt");
    expect(calls.some((c) => c.startsWith("rename:"))).toBe(false);
    await fs.rename("a.txt", "b.txt");
    expect(calls).toContain("rename:/p/a.txt->/p/b.txt");
    expect(isValidName("my file.txt")).toBe(true);
  });
});

describe("TargetFs · readText", () => {
  it("passes a channel-native path straight through (session files)", async () => {
    const { channel, calls } = memChannel({ "/home/u/.pi/agent/sessions/x.jsonl": "line\n" });
    const fs = posixFs("/p", channel);
    expect(await fs.readText("/home/u/.pi/agent/sessions/x.jsonl")).toBe("line\n");
    expect(calls).toContain("read:/home/u/.pi/agent/sessions/x.jsonl");
  });

  it("expands ~ for a remote target instead of rejecting it", async () => {
    const { channel, calls } = memChannel({ "/home/u/.pi/agent/sessions/x.jsonl": "line\n" });
    const fs = posixFs("/p", channel);
    expect(await fs.readText("~/.pi/agent/sessions/x.jsonl")).toBe("line\n");
    expect(calls).toContain("read:/home/u/.pi/agent/sessions/x.jsonl");
  });

  it("keeps a WSL UNC path intact (no dialect re-mapping)", async () => {
    const seen: string[] = [];
    const channel: Channel = {
      ...memChannel({}).channel,
      readAll: async (p) => {
        seen.push(p);
        return Buffer.from("ok");
      },
    };
    const fs = createTargetFs(wslTarget("Ubuntu", "/home/u/p"), {
      ...depsWith(channel),
      wsl: () => ({
        channel,
        dialect: "posix",
        toNative: (p) => `\\\\wsl$\\Ubuntu${p.replace(/\//g, "\\")}`,
        isNative: (p) => p.startsWith("\\\\"),
        home: async () => "/home/u",
      }),
    });
    expect(await fs.readText("\\\\wsl$\\Ubuntu\\home\\u\\.pi\\agent\\sessions\\x.jsonl")).toBe("ok");
    // A Linux-absolute session path is mapped to UNC exactly once.
    expect(await fs.readText("/home/u/.pi/agent/sessions/y.jsonl")).toBe("ok");
    expect(seen).toEqual([
      "\\\\wsl$\\Ubuntu\\home\\u\\.pi\\agent\\sessions\\x.jsonl",
      "\\\\wsl$\\Ubuntu\\home\\u\\.pi\\agent\\sessions\\y.jsonl",
    ]);
  });

  it("refuses a relative path rather than resolving it against the process CWD", async () => {
    const { channel } = memChannel({});
    const fs = posixFs("/p", channel);
    await expect(fs.readText("relative/x.jsonl")).rejects.toMatchObject({ kind: "escape" });
  });
});

describe("TargetFs · error classification", () => {
  it("maps every SFTP/fs 'no such file' spelling onto not-found", () => {
    // The forms ssh2-sftp-client actually produces (see sftp-errors.test.ts).
    for (const err of [
      Object.assign(new Error("x"), { code: "ENOENT" }),
      Object.assign(new Error("x"), { code: 2 }),
      Object.assign(new Error("x"), { code: "2" }),
      Object.assign(new Error("x"), { code: "NO_SUCH_FILE" }),
      new Error("list: No such file /sessions"),
    ]) {
      expect(classifyError(err, "p").kind).toBe("not-found");
    }
  });

  it("maps denied, ENOTDIR and transport, and passes TargetFsError through", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "EACCES" }), "p").kind).toBe("denied");
    expect(classifyError(Object.assign(new Error("x"), { code: 3 }), "p").kind).toBe("denied");
    expect(classifyError(Object.assign(new Error("x"), { code: "3" }), "p").kind).toBe("denied");
    expect(classifyError(Object.assign(new Error("x"), { code: "ENOTDIR" }), "p").kind).toBe("not-found");
    expect(classifyError(new Error("boom"), "p").kind).toBe("transport");
    // A bare string has no `.message`, so its text is never sniffed (parity
    // with sftp-errors, which deliberately refused to inspect plain strings).
    expect(classifyError("list: No such file /x", "p").kind).toBe("transport");
    const own = classifyError(Object.assign(new Error("x"), { code: "ENOENT" }), "p");
    expect(classifyError(own, "p")).toBe(own);
    expect(isTargetFsError(own)).toBe(true);
    expect(isTargetFsError(new Error("x"))).toBe(false);
  });

  it("clears a failed root lookup instead of poisoning the instance", async () => {
    const { channel } = memChannel({ "/home/u/p/a.ts": "a" });
    const home = vi.fn().mockRejectedValueOnce(new Error("no wsl")).mockResolvedValue("/home/u");
    const fs = posixFs("~/p", channel, { wsl: () => ({ ...posixBinding(channel), home }) });
    await expect(fs.readPreview("a.ts")).rejects.toThrow("no wsl");
    await expect(fs.readPreview("a.ts")).resolves.toMatchObject({ bytes: 1 });
    expect(home).toHaveBeenCalledTimes(2);
  });
});
