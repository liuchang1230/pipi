/**
 * Interface tests for the PRODUCTION adapters (target-fs-channels.ts).
 *
 * The module's semantics are covered by target-fs.test.ts through in-memory
 * channels. What is covered HERE is the part that only exists in production:
 * the real filesystem channel, the SFTP wire calls (including the inclusive
 * range mapping), the ssh fallback, and the two bridges (targetFromTab /
 * createTargetFsFactory).
 */
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteOpts } from "../pty";
import { FileTreeIndex } from "../file-tree-index";
import { TargetFsError, createTargetFs, localTarget, sftpTarget, wslTarget, type Binding, type Channel, type Target, type TargetFsDeps } from "../target-fs";
import {
  createTargetFsFactory,
  isWindowsPath,
  localBinding,
  mutationErrorText,
  sftpBinding,
  sshBinding,
  targetFromTab,
  wslBinding,
} from "../target-fs-channels";

const POSIX_BINDING = localBinding();

/** A path-algebra-only binding for the slots a test does not exercise (the
 *  channel is never called, but the dialect still validates the root). */
const NEVER_CALLED = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("channel not expected in this test");
    },
  }
) as unknown as Channel;
const POSIX_STUB: Binding = {
  channel: NEVER_CALLED,
  dialect: "posix",
  toNative: (p) => p,
  isNative: (p) => p.startsWith("/"),
  home: async () => "/home/u",
};

/** Host-appropriate local root: the local binding's dialect decides what
 *  "absolute" means, so the tests must speak the host's path language. */
const LOCAL_ROOT = process.platform === "win32" ? "C:\\tmp\\p" : "/tmp/p";
const OTHER_LOCAL_ROOT = process.platform === "win32" ? "C:\\tmp\\other" : "/tmp/other";

/** A local TargetFs over a temp dir: exercises the REAL fs channel. */
function localFs(root: string, cache?: FileTreeIndex) {
  const target = localTarget(root);
  const deps: TargetFsDeps = {
    local: POSIX_BINDING,
    wsl: () => POSIX_PLACEHOLDER,
    sftp: () => POSIX_PLACEHOLDER,
    ssh: () => POSIX_PLACEHOLDER,
    ...(cache ? { cache } : {}),
  };
  return createTargetFs(target, deps);
}
const POSIX_PLACEHOLDER = POSIX_STUB;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pipi-channels-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("localChannel over the real filesystem", () => {
  it("lists, filters and sorts like the tree expects", async () => {
    await writeFile(join(dir, "b.ts"), "b");
    await writeFile(join(dir, "a.ts"), "a");
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, ".hidden"), "h");
    await writeFile(join(dir, ".gitignore"), "g");

    const fs = localFs(dir);
    expect((await fs.list(".", { filter: "tree" })).map((n) => n.path)).toEqual(["src", ".gitignore", "a.ts", "b.ts"]);
    // `all` is what the picker and the mention index need.
    expect((await fs.list(".", { filter: "all" })).map((n) => n.name)).toContain("node_modules");
    expect((await fs.list(".", { filter: "all" })).map((n) => n.name)).toContain(".hidden");
  });

  it("lists a subdirectory with paths relative to the ROOT", async () => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "a");
    const fs = localFs(dir);
    expect((await fs.list("src")).map((n) => n.path)).toEqual(["src/a.ts"]);
  });

  it("reads text, notices binary, and samples a head+tail window when oversize", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    await writeFile(join(dir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const fs = localFs(dir);
    expect((await fs.readPreview("a.txt")).content).toBe("hello");
    const binary = await fs.readPreview("bin.dat");
    expect(binary.isBinary).toBe(true);
    expect(binary.content).toBe("(二进制文件，无法以文本显示)");

    // 3 MB of text: only the two 512 KB windows may be transferred.
    const line = "x".repeat(1023) + "\n";
    await writeFile(join(dir, "big.txt"), Buffer.from(line.repeat(3100)));
    const big = await fs.readPreview("big.txt");
    expect(big.truncated).toBe(true);
    expect(big.bytes).toBe(line.length * 3100);
    // 512 KB head + "\n\n……\n\n" + 512 KB tail, far below the file size.
    expect(big.content.length).toBeLessThan(1_100_000);
    expect(big.content).toContain("……");
  });

  it("writes through missing parent directories and reads the file back", async () => {
    const fs = localFs(dir);
    await fs.writeText("a/b/c.txt", "deep");
    expect(await readFile(join(dir, "a", "b", "c.txt"), "utf8")).toBe("deep");
    expect((await fs.readPreview("a/b/c.txt")).content).toBe("deep");
    expect((await fs.list("a/b")).map((n) => n.path)).toEqual(["a/b/c.txt"]);
  });

  it("mkdir is idempotent for a directory and refuses a file in the way", async () => {
    const fs = localFs(dir);
    await fs.mkdir("src");
    await fs.mkdir("src"); // no error the second time
    await writeFile(join(dir, "taken"), "x");
    await expect(fs.mkdir("taken")).rejects.toMatchObject({ kind: "exists" });
  });

  it("removes files and directories, and reports a missing path", async () => {
    const fs = localFs(dir);
    await fs.writeText("keep/a.txt", "a");
    await fs.writeText("keep/sub/b.txt", "b");
    await fs.remove("keep/sub");
    await expect(stat(join(dir, "keep", "sub"))).rejects.toThrow();
    await expect(fs.remove("keep/sub")).rejects.toMatchObject({ kind: "not-found" });
    await fs.remove("keep/a.txt");
    expect((await fs.list("keep")).map((n) => n.name)).toEqual([]);
  });

  it("renames inside the same directory, rejects invalid names, collisions and no-ops", async () => {
    const fs = localFs(dir);
    await fs.writeText("a.txt", "a");
    await fs.rename("a.txt", "b.txt");
    expect((await fs.list(".")).map((n) => n.name)).toEqual(["b.txt"]);
    await expect(fs.rename("b.txt", "x/y")).rejects.toMatchObject({ kind: "invalid-name" });
    await expect(fs.rename("b.txt", "b.")).rejects.toMatchObject({ kind: "invalid-name" });
    await fs.rename("b.txt", "b.txt"); // same name → no-op
    await fs.writeText("other.txt", "o");
    await expect(fs.rename("b.txt", "other.txt")).rejects.toMatchObject({ kind: "exists" });
    await expect(fs.rename("nope.txt", "x.txt")).rejects.toMatchObject({ kind: "not-found" });
  });

  it("refuses to escape the root, including via traversal", async () => {
    await writeFile(join(dir, "inside.txt"), "i");
    const fs = localFs(dir);
    await expect(fs.readPreview("../outside.txt")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.writeText("../outside.txt", "x")).rejects.toMatchObject({ kind: "escape" });
    // Inside-but-unnormalized is legal: the containment check decides.
    expect((await fs.readPreview("sub/../inside.txt")).content).toBe("i");
  });

  it("readText takes a channel-native absolute path", async () => {
    const file = join(dir, "sessions", "s.jsonl");
    await mkdir(join(dir, "sessions"));
    await writeFile(file, '{"a":1}\n');
    const fs = localFs(dir);
    expect(await fs.readText(file)).toBe('{"a":1}\n');
    await expect(fs.readText("sessions/s.jsonl")).rejects.toMatchObject({ kind: "escape" });
  });

  it("serves a cached listing until it expires, and honours fresh", async () => {
    const fs = localFs(dir, new FileTreeIndex());
    await writeFile(join(dir, "a.txt"), "a");
    expect((await fs.list(".")).map((n) => n.name)).toEqual(["a.txt"]);
    // A write that bypasses the module (pi's own write) is only visible after
    // an explicit invalidate / fresh.
    await writeFile(join(dir, "b.txt"), "b");
    expect((await fs.list(".")).map((n) => n.name)).toEqual(["a.txt"]);
    await fs.invalidate(["a.txt"]);
    expect((await fs.list(".")).map((n) => n.name)).toEqual(["a.txt", "b.txt"]);
    await writeFile(join(dir, "c.txt"), "c");
    expect((await fs.list(".", { fresh: true })).map((n) => n.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("keeps a symlink as an openable row instead of dropping it", async () => {
    if (process.platform !== "win32") {
      await writeFile(join(dir, "real.txt"), "r");
      await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
      const fs = localFs(dir);
      expect((await fs.list(".")).map((n) => n.name)).toContain("link.txt");
      // The local channel stat() follows the link, so it previews as a file.
      expect((await fs.readPreview("link.txt")).content).toBe("r");
    }
  });

  it("deletes a symlink to a directory without following it into the target", async () => {
    if (process.platform !== "win32") {
      const fs = localFs(dir);
      await fs.writeText("real/inner.txt", "keep me");
      await symlink(join(dir, "real"), join(dir, "linkdir"));
      // stat() follows links, so `remove` sees a directory and asks the channel
      // for a recursive delete. The delete must unlink the LINK: following it
      // would destroy the contents of `real`, which is data loss.
      await fs.remove("linkdir");
      await expect(stat(join(dir, "linkdir"))).rejects.toThrow();
      expect((await fs.list("real")).map((n) => n.name)).toEqual(["inner.txt"]);
      expect((await fs.readPreview("real/inner.txt")).content).toBe("keep me");
    }
  });
});

// ---------------------------------------------------------------------------
// SFTP: the wire calls and their path/range mapping
// ---------------------------------------------------------------------------

type FakeCall = { op: string; args: unknown[] };

function fakeSftp(homeDir = "/home/u") {
  const files = new Map<string, Buffer>([
    ["/home/u/proj/a.txt", Buffer.from("alpha")],
    ["/home/u/proj/dir/b.txt", Buffer.from("beta")],
    ["/home/u/big.txt", Buffer.from("0123456789")],
  ]);
  const dirs = new Set(["/home/u", "/home/u/proj", "/home/u/proj/dir"]);
  const calls: FakeCall[] = [];
  /** Paths that exist as SYMLINKS: `exists` (an lstat on the server) must
   *  report them as links even when they point at a directory. */
  const links = new Map<string, string>();
  const client = {
    async list(p: string) {
      calls.push({ op: "list", args: [p] });
      if (!dirs.has(p)) throw Object.assign(new Error("No such file"), { code: 2 });
      const names = [...files.keys(), ...dirs]
        .filter((f) => f !== p && f.startsWith(p === "/" ? "/" : `${p}/`) && !f.slice(p.length + 1).includes("/"))
        .map((f) => f.slice(p.length + 1));
      return [{ name: ".", type: "-" }, { name: "..", type: "-" }].concat(
        [...new Set(names)].map((name) => ({ name, type: dirs.has(`${p}/${name}`) ? "d" : "-" }))
      );
    },
    async stat(p: string) {
      calls.push({ op: "stat", args: [p] });
      const buf = files.get(p);
      if (buf) return { size: buf.length, isDirectory: false };
      if (dirs.has(p)) return { size: 0, isDirectory: true };
      // `stat` FOLLOWS a link, like the real client.
      const link = links.get(p);
      if (link) {
        if (dirs.has(link)) return { size: 0, isDirectory: true };
        const target = files.get(link);
        if (target) return { size: target.length, isDirectory: false };
      }
      throw Object.assign(new Error("No such file"), { code: 2 });
    },
    async exists(p: string) {
      calls.push({ op: "exists", args: [p] });
      if (links.has(p)) return "l";
      if (dirs.has(p)) return "d";
      if (files.has(p)) return "-";
      return false;
    },
    async get(p: string, _dst?: unknown, options?: { readStreamOptions?: { start: number; end: number } }) {
      calls.push({ op: "get", args: [p, options] });
      const buf = files.get(p);
      if (!buf) throw Object.assign(new Error("No such file"), { code: 2 });
      const range = options?.readStreamOptions;
      // ssh2's `end` is INCLUSIVE — the adapter must subtract one.
      return range ? buf.subarray(range.start, range.end + 1) : buf;
    },
    async put(content: Buffer, p: string) {
      calls.push({ op: "put", args: [p, content] });
      files.set(p, Buffer.from(content));
      return "ok";
    },
    async mkdir(p: string, recursive?: boolean) {
      calls.push({ op: "mkdir", args: [p, recursive] });
      dirs.add(p);
      return p;
    },
    async rmdir(p: string, recursive?: boolean) {
      calls.push({ op: "rmdir", args: [p, recursive] });
      dirs.delete(p);
      return p;
    },
    async delete(p: string) {
      calls.push({ op: "delete", args: [p] });
      files.delete(p);
      return p;
    },
    async rename(from: string, to: string) {
      calls.push({ op: "rename", args: [from, to] });
      const buf = files.get(from);
      if (!buf) throw Object.assign(new Error("No such file"), { code: 2 });
      files.delete(from);
      files.set(to, buf);
      return "ok";
    },
  };
  const remote: RemoteOpts = { host: "example.com", user: "u", port: 2222, password: "p", path: "/home/u/proj" };
  const runner = vi.fn(async (_remote: RemoteOpts, fn: (c: unknown, home: string) => Promise<unknown>) => fn(client, homeDir));
  return { calls, runner, remote, files, dirs, links, client };
}

function sftpFs(homeDir = "/home/u") {
  const fake = fakeSftp(homeDir);
  const target = sftpTarget(fake.remote, "/home/u/proj");
  const binding = sftpBinding(fake.remote, fake.runner as never);
  const deps: TargetFsDeps = { local: POSIX_BINDING, wsl: () => POSIX_BINDING, sftp: () => binding, ssh: () => POSIX_BINDING };
  return { ...fake, fs: createTargetFs(target, deps), binding };
}

describe("sftpBinding", () => {
  it("maps SFTP 'd' entries to directories and drops . / ..", async () => {
    const { fs } = sftpFs();
    expect((await fs.list(".")).map((n) => `${n.name}:${n.type}`)).toEqual(["dir:directory", "a.txt:file"]);
    // Absolute (browse) input keeps absolute paths, like the pre-seam adapter.
    expect((await fs.list("/home/u/proj/dir")).map((n) => n.path)).toEqual(["/home/u/proj/dir/b.txt"]);
  });

  it("expands a ~ root through the lease's home dir", async () => {
    const fake = fakeSftp("/home/u");
    const target = sftpTarget(fake.remote, "~");
    const binding = sftpBinding(fake.remote, fake.runner as never);
    const fs = createTargetFs(target, { local: POSIX_BINDING, wsl: () => POSIX_BINDING, sftp: () => binding, ssh: () => POSIX_BINDING });
    await fs.list(".");
    expect(fake.calls[0]).toEqual({ op: "list", args: ["/home/u"] });
  });

  it("requests ranges with an INCLUSIVE end and slices the oversize window", async () => {
    const { fs, calls, files } = sftpFs();
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    files.set("/home/u/proj/big.txt", big);
    const preview = await fs.readPreview("big.txt");
    expect(preview.truncated).toBe(true);
    const gets = calls.filter((c) => c.op === "get");
    expect(gets).toHaveLength(2);
    expect((gets[0].args[1] as { readStreamOptions: { start: number; end: number } }).readStreamOptions).toEqual({
      start: 0,
      end: 512 * 1024 - 1,
    });
    expect((gets[1].args[1] as { readStreamOptions: { start: number; end: number } }).readStreamOptions).toEqual({
      start: big.length - 512 * 1024,
      end: big.length - 1,
    });
    expect(preview.content.startsWith("aaaa")).toBe(true);
  });

  it("reports a missing file as not-found (ssh2 code 2) and a missing dir likewise", async () => {
    const { fs } = sftpFs();
    await expect(fs.readPreview("nope.txt")).rejects.toMatchObject({ kind: "not-found" });
    await expect(fs.list("nope")).rejects.toMatchObject({ kind: "not-found" });
  });

  it("answers an existence probe with null instead of throwing", async () => {
    // The module probes before every mkdir/rename/remove, and `withSftp`
    // DESTROYS the pooled lease on any error that escapes its callback — a miss
    // must therefore resolve, not reject, or the normal "target does not exist
    // yet" path would recycle the connection and kill concurrent operations.
    const fake = fakeSftp();
    const binding = sftpBinding(fake.remote, fake.runner as never);
    await expect(binding.channel.stat("/home/u/proj/nope")).resolves.toBeNull();
    expect(fake.runner).toHaveBeenCalledTimes(1);
    // Anything else still leaves the channel as a classified failure.
    const broken = vi.fn(async () => {
      throw Object.assign(new Error("Permission denied"), { code: 3 });
    });
    await expect(sftpBinding(fake.remote, broken as never).channel.stat("/home/u/proj/a.txt")).rejects.toMatchObject({
      code: 3,
    });
  });

  it("probes with lstat (...) so a symlink is unlinked, not rmdir'd", async () => {
    const { fs, calls, links } = sftpFs();
    // `stat` (what the module saw) follows the link and calls it a directory;
    // the server's rmdir would then refuse it. `exists` is the lstat.
    links.set("/home/u/proj/linkdir", "/home/u/proj/dir");
    await fs.remove("linkdir");
    expect(calls).toContainEqual({ op: "exists", args: ["/home/u/proj/linkdir"] });
    expect(calls).toContainEqual({ op: "delete", args: ["/home/u/proj/linkdir"] });
    expect(calls.filter((c) => c.op === "rmdir")).toHaveLength(0);
  });

  it("writes (mkdir -p + put as a Buffer), renames and deletes with the right primitives", async () => {
    const { fs, calls, dirs } = sftpFs();
    await fs.writeText("dir/new.txt", "n");
    expect(calls).toContainEqual({ op: "mkdir", args: ["/home/u/proj/dir", true] });
    // put() treats a string as a LOCAL path → the adapter must send a Buffer.
    const puts = calls.filter((c) => c.op === "put");
    expect(puts).toHaveLength(1);
    expect(Buffer.isBuffer(puts[0].args[1])).toBe(true);
    expect((puts[0].args[1] as Buffer).toString("utf8")).toBe("n");
    await fs.rename("dir/new.txt", "renamed.txt");
    expect(calls).toContainEqual({ op: "rename", args: ["/home/u/proj/dir/new.txt", "/home/u/proj/dir/renamed.txt"] });
    await fs.remove("dir/renamed.txt");
    expect(calls).toContainEqual({ op: "delete", args: ["/home/u/proj/dir/renamed.txt"] });
    dirs.add("/home/u/proj/sub");
    await fs.remove("sub");
    expect(calls).toContainEqual({ op: "rmdir", args: ["/home/u/proj/sub", true] });
  });

  it("keeps the write inside the project root", async () => {
    const { fs } = sftpFs();
    await expect(fs.writeText("../escape.txt", "x")).rejects.toMatchObject({ kind: "escape" });
    await expect(fs.readPreview("/etc/passwd")).rejects.toMatchObject({ kind: "escape" });
  });

  it("reads a whole session file at an absolute path without re-rooting it", async () => {
    const { fs, files } = sftpFs();
    files.set("/home/u/.pi/agent/sessions/s.jsonl", Buffer.from("{}\n"));
    expect(await fs.readText("/home/u/.pi/agent/sessions/s.jsonl")).toBe("{}\n");
  });
});

// ---------------------------------------------------------------------------
// ssh (key-auth): exactly one primitive
// ---------------------------------------------------------------------------

describe("sshBinding", () => {
  const remote: RemoteOpts = { host: "example.com", user: "u", path: "~" };

  function sshFs(cat: (remote: RemoteOpts, p: string) => Promise<string>) {
    const binding = sshBinding(remote, cat);
    const target = sftpTarget(remote, "~");
    return createTargetFs(target, { local: POSIX_BINDING, wsl: () => POSIX_BINDING, sftp: () => binding, ssh: () => binding });
  }

  it("reads a session file through `ssh cat`", async () => {
    const fs = sshFs(async (_r, p) => `content of ${p}`);
    expect(await fs.readText("/home/u/.pi/agent/sessions/s.jsonl")).toBe("content of /home/u/.pi/agent/sessions/s.jsonl");
  });

  it("turns the empty-string failure signal into a thrown error (callers fall back to RPC)", async () => {
    const fs = sshFs(async () => "");
    await expect(fs.readText("/home/u/s.jsonl")).rejects.toMatchObject({ kind: "transport" });
    await expect(fs.readText("/home/u/s.jsonl")).rejects.toThrow(/key-auth remote read failed/);
  });

  it("fails loudly on every primitive it cannot do", async () => {
    const fs = sshFs(async () => "x");
    await expect(fs.list(".")).rejects.toMatchObject({ kind: "transport" });
    await expect(fs.writeText("a.txt", "x")).rejects.toMatchObject({ kind: "transport" });
    await expect(fs.remove("a.txt")).rejects.toMatchObject({ kind: "transport" });
    await expect(fs.readText("~")).rejects.toMatchObject({ kind: "transport" });
  });
});

// ---------------------------------------------------------------------------
// WSL binding: posix algebra over a UNC wire path
// ---------------------------------------------------------------------------

describe("wslBinding", () => {
  it("maps posix paths to \\\\wsl$ and passes UNC paths through", async () => {
    const binding = wslBinding("Ubuntu-22.04", async () => "/home/u");
    expect(binding.dialect).toBe("posix");
    expect(binding.toNative("/home/u/proj/a.txt")).toBe("\\\\wsl$\\Ubuntu-22.04\\home\\u\\proj\\a.txt");
    expect(binding.isNative("\\\\wsl$\\Ubuntu-22.04\\home\\u\\proj\\a.txt")).toBe(true);
    expect(binding.isNative("/home/u/proj/a.txt")).toBe(false);
    expect(await binding.home()).toBe("/home/u");
  });

  it("is used for every channel call of a WSL target", async () => {
    // A UNC-shaped path is native, so readText must not remap it; a Linux
    // absolute one must be mapped. Assert the mapping rule itself, since the
    // real UNC share only exists on a machine with that distro.
    const binding = wslBinding("Ubuntu-22.04", async () => "/home/u");
    const seen: string[] = [];
    const spy = { ...binding, toNative: (p: string) => { seen.push(p); return binding.toNative(p); } };
    const fs = createTargetFs(wslTarget("Ubuntu-22.04", "~/proj"), {
      local: POSIX_BINDING,
      wsl: () => spy,
      sftp: () => POSIX_BINDING,
      ssh: () => POSIX_BINDING,
    });
    // readText on a Linux-absolute session path goes through the mapper…
    await expect(fs.readText("/home/u/s.jsonl")).rejects.toBeTruthy();
    expect(seen).toContain("/home/u/s.jsonl");
    // …while an already-UNC path is passed straight through.
    seen.length = 0;
    await expect(fs.readText("\\\\wsl$\\Ubuntu-22.04\\home\\u\\s.jsonl")).rejects.toBeTruthy();
    expect(seen).toEqual([]);
    // This one reaches the REAL WSL channel, so it does UNC I/O against a share
    // whose distro may not exist — seconds of SMB-level retry, not the 5s default.
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The two bridges
// ---------------------------------------------------------------------------

describe("targetFromTab", () => {
  it("maps a WSL tab to a posix target with a ~ fallback root", () => {
    expect(targetFromTab({ wsl: { distro: "Ubuntu" }, cwd: "C:\\x" })).toEqual({ kind: "wsl", distro: "Ubuntu", root: "~" });
    expect(targetFromTab({ wsl: { distro: "Ubuntu", path: "/srv/app" }, cwd: "" })).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
      root: "/srv/app",
    });
  });

  it("maps a remote tab to sftp when it has a password and ssh otherwise", () => {
    const remote: RemoteOpts = { host: "h", user: "u", password: "p", path: "/srv/app" };
    const target = targetFromTab({ remote, cwd: "" });
    expect(target).toEqual({ kind: "sftp", remote, root: "/srv/app" });
    // Same REFERENCE, not just the same fields: `stableRemoteKey` hashes
    // host|user|port|path|agentDir into the lease key, so a caller that
    // rebuilds the object literal would split one server into two leases and
    // two caches (CONTEXT: 那个「间歇性变慢」地雷).
    expect((target as { remote: RemoteOpts }).remote).toBe(remote);
    const keyAuth: RemoteOpts = { host: "h", user: "u" };
    expect(targetFromTab({ remote: keyAuth, cwd: "" })).toMatchObject({ kind: "ssh", root: "~" });
    // An EMPTY password is not a password: those profiles are key-auth, and
    // choosing sftp for them would take a lease that then fails to
    // authenticate (the old suite pinned this; now for `targetFromTab`).
    expect(targetFromTab({ remote: { ...keyAuth, password: "" }, cwd: "" })).toMatchObject({ kind: "ssh" });
  });

  it("prefers wsl when a tab somehow carries both", () => {
    // Non-empty wsl wins over remote: the field order is the rule the tab
    // model has always used, and a tab that carries both must not depend on
    // which one the reader looks at second.
    const remote: RemoteOpts = { host: "h", user: "u", password: "p" };
    expect(targetFromTab({ wsl: { distro: "Ubuntu", path: "/srv" }, remote, cwd: "/tmp/p" })).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
      root: "/srv",
    });
    // ...and remote wins over a cwd, which is what makes a remote tab's
    // separate local cwd harmless for file IO.
    expect(targetFromTab({ remote, cwd: "/tmp/p" })).toMatchObject({ kind: "sftp" });
  });

  it("maps a local tab to its cwd, and refuses an empty one", () => {
    expect(targetFromTab({ cwd: "/tmp/p" })).toEqual({ kind: "local", root: "/tmp/p" });
    expect(targetFromTab({ cwd: "" })).toBeUndefined();
  });
});

describe("createTargetFsFactory", () => {
  const deps: TargetFsDeps = { local: POSIX_BINDING, wsl: () => POSIX_STUB, sftp: () => POSIX_STUB, ssh: () => POSIX_STUB };

  it("hands out ONE instance per target so the cache is shared", () => {
    const factory = createTargetFsFactory(deps);
    const a = factory(localTarget(LOCAL_ROOT));
    expect(factory(localTarget(LOCAL_ROOT))).toBe(a);
    expect(factory(localTarget(OTHER_LOCAL_ROOT))).not.toBe(a);
    const remote: RemoteOpts = { host: "h", user: "u", password: "p" };
    expect(factory(sftpTarget(remote, "/srv"))).toBe(factory(sftpTarget(remote, "/srv")));
    // A different root on the SAME server is a different containment base.
    expect(factory(sftpTarget(remote, "/srv/other"))).not.toBe(factory(sftpTarget(remote, "/srv")));
  });

  it("keeps two servers apart", () => {
    const factory = createTargetFsFactory(deps);
    const one = factory(sftpTarget({ host: "a", user: "u", password: "p" }, "/srv"));
    const two = factory(sftpTarget({ host: "b", user: "u", password: "p" }, "/srv"));
    expect(one).not.toBe(two);
  });
});

describe("isWindowsPath", () => {
  it("recognizes drive-letter paths only", () => {
    expect(isWindowsPath("C:\\x")).toBe(true);
    expect(isWindowsPath("c:/x")).toBe(true);
    expect(isWindowsPath("/home/u/x")).toBe(false);
    expect(isWindowsPath("rel/x")).toBe(false);
  });

  it("is what keeps a Windows path off a POSIX channel", async () => {
    const { fs } = sftpFs();
    // The IPC boundary rejects it before the module sees it; the module would
    // otherwise treat `C:\x` as a relative name inside the root.
    const target: Target = sftpTarget({ host: "h", user: "u", password: "p" }, "/srv");
    expect(target.kind).toBe("sftp");
    expect(isWindowsPath("C:\\Users\\me\\a.txt")).toBe(true);
    await expect(fs.readPreview("C:\\Users\\me\\a.txt")).rejects.toMatchObject({ kind: "not-found" });
  });
});

describe("mutationErrorText", () => {
  // These strings are the UI (toasts and the tree's inline error row) and
  // predate the seam, so they are pinned verbatim: the module's classified
  // English errors must not leak into Chinese surfaces.
  it("keeps the wording of a name the tree refuses", () => {
    const e = new TargetFsError("invalid-name", "invalid name: a/b");
    expect(mutationErrorText(e, "a/b", "a/b")).toBe("名称不合法（不能包含 / 或 \\）");
  });

  it("reads one `exists` kind two ways: a file in the way vs a taken name", () => {
    const e = new TargetFsError("exists", "file occupies path: x");
    expect(mutationErrorText(e, "x")).toBe("已存在同名文件: x");
    expect(mutationErrorText(e, "dir/x", "x")).toBe("目标已存在: x");
  });

  it("turns the module's miss wording into the surface's", () => {
    // The module says "No such file or directory: x" so local reads keep the
    // renderer's retry predicate working; mutations need the Chinese wording.
    const e = new TargetFsError("not-found", "No such file or directory: x");
    expect(mutationErrorText(e, "x")).toBe("路径不存在: x");
  });

  it("reports a containment refusal without leaking the absolute path algebra", () => {
    expect(mutationErrorText(new TargetFsError("escape", "escapes root: /etc/passwd"), "/etc/passwd")).toBe(
      "路径越界: /etc/passwd"
    );
  });

  it("passes transport failures through with their own detail", () => {
    expect(mutationErrorText(new TargetFsError("transport", "w: connection reset"), "w")).toBe("w: connection reset");
    expect(mutationErrorText(new Error("boom"), "w")).toBe("boom");
  });

  it("joins a REAL module failure to the surface wording", async () => {
    // The two halves were tested apart (the module's kinds, this table); this
    // pins that they compose: whatever kind the module picks for a failing
    // mutation must land on the wording that surface has always shown.
    const fs = localFs(dir);
    await fs.writeText("taken.txt", "x");
    await fs.writeText("a.txt", "a");
    const mkdirErr = await fs.mkdir("taken.txt").catch((e: unknown) => e);
    expect(mutationErrorText(mkdirErr, "taken.txt")).toBe("已存在同名文件: taken.txt");
    const renameErr = await fs.rename("a.txt", "taken.txt").catch((e: unknown) => e);
    expect(mutationErrorText(renameErr, "a.txt", "taken.txt")).toBe("目标已存在: taken.txt");
    const goneErr = await fs.remove("gone.txt").catch((e: unknown) => e);
    expect(mutationErrorText(goneErr, "gone.txt")).toBe("路径不存在: gone.txt");
    const nameErr = await fs.rename("a.txt", "a/b").catch((e: unknown) => e);
    expect(mutationErrorText(nameErr, "a.txt", "a/b")).toBe("名称不合法（不能包含 / 或 \\）");
  });
});
