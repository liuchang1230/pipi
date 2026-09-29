/**
 * Production adapters for the TargetFs seam (docs/adr/0001-target-fs-seam.md).
 *
 * Three channels and the bindings that pair a channel with its path dialect:
 *  - `localFs` — the real filesystem. WSL reuses it through a `\\wsl$` UNC path
 *    mapper, which is why the mapper lives in the BINDING and not in a channel.
 *  - `sftp` — remotes, over a pooled lease (password or key auth).
 *  - `ssh` — `ssh cat` only: the key-auth SESSION-FILE fast path, which must
 *    not take an SFTP lease. Every other primitive fails loudly.
 *
 * Everything here is a TERMINATING primitive: no caching, no filtering, no
 * truncation, no path algebra. The module owns those, so every channel behaves
 * identically and the rules above the seam exist exactly once.
 */
import { mkdir, open as fspOpen, readdir, readFile, rename as fspRename, rm, stat as fspStat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { wslToWinPath } from "./wsl";
import type SftpClient from "ssh2-sftp-client";
import type { RemoteOpts, TabInfo } from "./pty";
import { isSftpMissingPathError } from "./sftp-errors";
import { TargetFsError, createTargetFs, localTarget, sftpTarget, sshTarget, targetKey, wslTarget } from "./target-fs";
import type { Binding, Channel, PathDialect, Target, TargetFs, TargetFsDeps } from "./target-fs";

function toBuffer(raw: string | Buffer | NodeJS.WritableStream): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  return Buffer.from(typeof raw === "string" ? raw : "", "utf8");
}

/** The real filesystem, addressed by native paths. */
export function localChannel(): Channel {
  return {
    async list(dir) {
      const items = await readdir(dir, { withFileTypes: true });
      // A Dirent that is neither file nor directory (a symlink on a filesystem
      // that does not resolve it, a socket) is reported as a file rather than
      // dropped: a row that vanishes is harder to explain than a row that
      // opens with an error. Remote channels classify the same way.
      return items.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    },
    async stat(p) {
      const st = await fspStat(p);
      return { type: st.isDirectory() ? "directory" : "file", size: st.size };
    },
    async readRange(p, start, length) {
      const handle = await fspOpen(p, "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async readAll(p) {
      return readFile(p);
    },
    async writeText(p, content) {
      await writeFile(p, content, "utf8");
    },
    async mkdirp(p) {
      await mkdir(p, { recursive: true });
    },
    async remove(p, type) {
      await rm(p, type === "directory" ? { recursive: true, force: false } : { force: false });
    },
    async rename(from, to) {
      await fspRename(from, to);
    },
  };
}

export function dialectForHost(): PathDialect {
  return process.platform === "win32" ? "win" : "posix";
}

export function localBinding(): Binding {
  const dialect = dialectForHost();
  return {
    channel: localChannel(),
    dialect,
    toNative: (p) => p,
    isNative: (p) => (dialect === "win" ? /^[A-Za-z]:[\\/]|^\\\\|^\/\//.test(p) : p.startsWith("/")),
    home: async () => homedir(),
  };
}

/**
 * WSL: Linux path algebra, `\\wsl$\<distro>\…` on the wire. An already-UNC
 * session path is native and passes straight through, so no reverse mapper is
 * needed — the module never has to guess which direction it is going.
 */
export function wslBinding(distro: string, home: () => Promise<string>): Binding {
  return {
    channel: localChannel(),
    dialect: "posix",
    toNative: (p) => wslToWinPath(distro, p),
    isNative: (p) => /^\\\\wsl\$/i.test(p),
    home,
  };
}

/** `<withSftp>` as the main process declares it (lease + home dir). */
export type SftpRunner = <T>(remote: RemoteOpts, fn: (client: SftpClient, homeDir: string) => Promise<T>) => Promise<T>;

export function sftpBinding(remote: RemoteOpts, withSftp: SftpRunner): Binding {
  return {
    channel: {
      async list(dir) {
        return withSftp(remote, async (client) => {
          const items = (await client.list(dir)) as Array<{ name: string; type: string }>;
          return items
            .filter((item) => item.name !== "." && item.name !== "..")
            .map((item) => ({ name: item.name, type: item.type === "d" ? ("directory" as const) : ("file" as const) }));
        });
      },
      async stat(p) {
        // A miss must NOT escape the `withSftp` callback: that wrapper destroys
        // the pooled lease on ANY error (index.ts), so probing for a directory
        // that does not exist yet — which `mkdir`, `rename` and every `remove`
        // do — would recycle the connection and kill concurrent operations on
        // the same server. The Channel contract allows `null` for exactly this.
        return withSftp(remote, async (client) => {
          try {
            const st = await client.stat(p);
            return { type: st.isDirectory ? ("directory" as const) : ("file" as const), size: st.size };
          } catch (e) {
            if (isSftpMissingPathError(e)) return null;
            throw e;
          }
        });
      },
      async readRange(p, start, length) {
        if (length <= 0) return Buffer.alloc(0);
        // ssh2's ReadStreamOptions.end is INCLUSIVE. The @types for
        // TransferOptions predate this option, but v12 forwards it to ssh2
        // (same call the previous inline implementation made).
        const raw = await withSftp(remote, (client) =>
          client.get(p, undefined, { readStreamOptions: { start, end: start + length - 1 } } as never)
        );
        return toBuffer(raw);
      },
      async readAll(p) {
        return toBuffer(await withSftp(remote, (client) => client.get(p)));
      },
      async writeText(p, content) {
        await withSftp(remote, (client) => client.put(Buffer.from(content, "utf8"), p));
      },
      async mkdirp(p) {
        await withSftp(remote, (client) => client.mkdir(p, true));
      },
      async remove(p) {
        await withSftp(remote, async (client) => {
          // `stat` (what the module saw) FOLLOWS symlinks, but the delete
          // primitives do not: `rmdir` re-checks with `lstat` and refuses a link
          // to a directory, so a symlink on a Linux remote could not be deleted
          // at all. `exists` IS that lstat — the same probe the previous inline
          // implementation used.
          const kind = await client.exists(p);
          if (!kind) throw new TargetFsError("not-found", `No such file or directory: ${p}`);
          if (kind === "d") await client.rmdir(p, true);
          else await client.delete(p);
        });
      },
      async rename(from, to) {
        await withSftp(remote, (client) => client.rename(from, to));
      },
    },
    dialect: "posix",
    toNative: (p) => p,
    isNative: (p) => p.startsWith("/"),
    home: async () => withSftp(remote, async (_client, homeDir) => homeDir),
  };
}

/**
 * Key-auth remote. `sshCatRemoteFile` signals failure with an empty string
 * (the caller used to translate that), and there is no home lookup without a
 * second round trip — `~` roots therefore fail loudly instead of guessing.
 */
export function sshBinding(remote: RemoteOpts, catRemoteFile: (remote: RemoteOpts, absPath: string) => Promise<string>): Binding {
  const unsupported = (op: string): never => {
    throw new TargetFsError("transport", `免密远程不支持${op}`);
  };
  return {
    channel: {
      list: async () => unsupported("目录浏览，请改用密码连接"),
      stat: async () => unsupported("文件信息查询"),
      readRange: async () => unsupported("分段读取"),
      async readAll(p) {
        const text = await catRemoteFile(remote, p);
        if (!text) throw new TargetFsError("transport", "key-auth remote read failed");
        return Buffer.from(text, "utf8");
      },
      writeText: async () => unsupported("写入"),
      mkdirp: async () => unsupported("新建目录"),
      remove: async () => unsupported("删除"),
      rename: async () => unsupported("重命名"),
    },
    dialect: "posix",
    toNative: (p) => p,
    isNative: (p) => p.startsWith("/"),
    home: async () => {
      throw new TargetFsError("transport", "免密远程无法解析 ~（没有 home 查询通道）");
    },
  };
}

/**
 * The ONE bridge from a tab's fields to a Target. After this, file IO never
 * reads `tab.wsl` / `tab.remote` / the faked variants again — which is what
 * retires "guess the kind from whichever field is present".
 */
export function targetFromTab(tab: Pick<TabInfo, "wsl" | "remote" | "cwd">): Target | undefined {
  if (tab.wsl) return wslTarget(tab.wsl.distro, tab.wsl.path || "~");
  // The session-file channel rule (session-file-reader.ts owned it before):
  // SFTP when a lease can be established, otherwise `ssh cat`.
  if (tab.remote) {
    return tab.remote.password
      ? sftpTarget(tab.remote, tab.remote.path || "~")
      : sshTarget(tab.remote, tab.remote.path || "~");
  }
  return tab.cwd ? localTarget(tab.cwd) : undefined;
}

/**
 * One TargetFs per (kind, remote identity, root): the TTL cache and the
 * memoised home lookup must be shared by every handler touching the same
 * project, or two handlers would keep two divergent caches of one directory.
 */
export function createTargetFsFactory(deps: TargetFsDeps): (target: Target) => TargetFs {
  const byKey = new Map<string, TargetFs>();
  return (target) => {
    const key = targetKey(target);
    let fs = byKey.get(key);
    if (!fs) {
      fs = createTargetFs(target, deps);
      byKey.set(key, fs);
    }
    return fs;
  };
}

/** Remote guard: a Windows-local path must never reach a POSIX channel. */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}
