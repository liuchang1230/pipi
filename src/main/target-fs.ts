/**
 * target-fs.ts — the one module that reads and writes files for a Target.
 *
 * Before this module, every file operation existed once per target kind:
 * containment checks in three places (with two different error strings),
 * write/rename/delete semantics twice (bare `node:fs` vs the WSL helpers),
 * "which transport do I use" twice (session-file-reader's rule vs the ad-hoc
 * branches in each handler), and two tree caches (the FileTreeIndex plus a
 * bare Map keyed by `wsl:<distro>:` / `::tree::` strings). The root cause was
 * that a Target had no real representation — `resolveTarget` materialised a
 * FAKE TabInfo and callers told kinds apart by which of `t.wsl` / `t.remote`
 * happened to be set.
 *
 * Three path domains, on purpose (see docs/adr/0001-target-fs-seam.md):
 *
 *  - BROWSE (`list`): free navigation. Takes an absolute dialect path or `~`;
 *    NOT contained by the root, because the remote tree and the directory
 *    picker legitimately browse outside the project dir. Domain-preserving:
 *    absolute in → absolute out, root-relative in → root-relative out.
 *  - ROOT-RELATIVE (`readPreview`, `writeText`, `mkdir`, `remove`, `rename`):
 *    contained by the target root. Absolute wire paths (what the renderer
 *    sends for remote/WSL) are relativised against the root at THIS boundary —
 *    the asymmetry is absorbed here and nowhere else.
 *  - ABSOLUTE (`readText`): a dialect-absolute path chosen by pi itself (the
 *    session JSONL), not by the renderer, so it is not contained.
 *
 * Channels differ only in transport; truncation, filtering, path algebra and
 * naming rules live HERE, above the seam, exactly once. Errors are thrown as
 * `TargetFsError` with a classified `kind`; user-facing wording stays at the
 * IPC boundary.
 */
import { posix as posixPath, win32 as winPath } from "node:path";
import { isBinaryBuffer, imagePayloadOf, rasterImageMimeOf, type FileNode, type PreviewPayload } from "./file-tree";
import type { RemoteOpts } from "./pty";
import { buildRemoteKey } from "./pty";

/** Text previews above this are never read whole (head+tail windows instead). */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Head/tail window size for oversize text previews. */
export const TEXT_PREVIEW_HALF_BYTES = 512 * 1024;
/** Raster images above this are not base64-encoded for the viewer. */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

const BINARY_NOTICE = "(二进制文件，无法以文本显示)";

// The head/tail windows must not meet in the middle. The window is only used
// when `size > MAX`, and the smallest such size needs `size - HALF >= HALF`,
// so the invariant is `2 * HALF <= MAX + 1`.
if (TEXT_PREVIEW_HALF_BYTES * 2 > TEXT_PREVIEW_MAX_BYTES + 1) {
  throw new Error("target-fs: preview windows must be smaller than the whole-file cap");
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/** Where a file operation happens. The one true representation — the bridges
 *  (`targetFromTab` / `resolveTargetRef` in index.ts) build it, and nothing
 *  else interrogates a tab to work out what kind of target it is. */
export type Target =
  | { kind: "local"; root: string }
  | { kind: "wsl"; distro: string; root: string }
  | { kind: "sftp"; remote: RemoteOpts; root: string }
  | { kind: "ssh"; remote: RemoteOpts; root: string };

export function localTarget(root: string): Target {
  return { kind: "local", root };
}

export function wslTarget(distro: string, root: string): Target {
  return { kind: "wsl", distro, root };
}

/** Browsing/IO over a pooled SFTP lease. Used for EVERY remote file operation
 *  a user addresses through the tree or the viewer — a password is auth
 *  material, not a channel choice (`remoteAuthOptions` also accepts agent and
 *  default keys, which is what the pre-seam `remoteReadFile` relied on). */
export function sftpTarget(remote: RemoteOpts, root: string): Target {
  return { kind: "sftp", remote, root };
}

/** Plain `ssh cat`, no SFTP lease. This is the SESSION-FILE fast path for
 *  key-auth remotes (it also works while the remote pi is dead, which is when
 *  that path matters) — not a general “passwordless ⇒ ssh” rule: it must not
 *  be used for tree browsing or previews. */
export function sshTarget(remote: RemoteOpts, root: string): Target {
  return { kind: "ssh", remote, root };
}

/** Stable cache/dedup key. Includes the root: two tabs on the same server but
 *  different project dirs must never share a tree entry. */
export function targetKey(target: Target): string {
  switch (target.kind) {
    case "local":
      return `local\0${target.root}`;
    case "wsl":
      return `wsl:${target.distro}\0${target.root}`;
    default:
      return `${target.kind}:${remoteIdentity(target.remote)}\0${target.root}`;
  }
}

/** Same key the rest of the main process uses for remote tabs (pty.ts owns
 *  the algorithm, including the `?? 22` default port); step ④ removes the
 *  remaining inline copies. */
function remoteIdentity(remote: RemoteOpts): string {
  return buildRemoteKey(remote);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TargetFsErrorKind =
  | "not-found"
  | "denied"
  | "escape"
  | "transport"
  | "invalid-name"
  | "exists";

/** Every failure leaving this module is classified. Callers branch on `kind`;
 *  user-facing wording (Chinese, per surface) is added at the IPC boundary. */
export class TargetFsError extends Error {
  constructor(
    readonly kind: TargetFsErrorKind,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "TargetFsError";
  }
}

export function isTargetFsError(e: unknown): e is TargetFsError {
  return e instanceof TargetFsError;
}

/** Best-effort classification of a raw fs/SFTP error. Channels may throw a
 *  `TargetFsError` directly when they already know the kind. The SFTP forms
 *  are deliberately as broad as `sftp-errors.isSftpMissingPathError` was: ssh2
 *  reports SSH_FX_NO_SUCH_FILE as the number 2, the client also aliases it to
 *  ENOENT or a `NO_SUCH_FILE` code, and some paths only carry the message. A
 *  miss classified as `transport` is a user-visible regression (it is how the
 *  sidebar once showed “远程会话加载失败：list: No such file” for a project that
 *  simply had no sessions yet), so this must stay a superset, not a rewrite. */
export function classifyError(e: unknown, what: string): TargetFsError {
  if (isTargetFsError(e)) return e;
  const code = (e as { code?: unknown } | null)?.code;
  // Only a real `.message` is inspected — the same restraint as
  // sftp-errors.ts, so a bare string that merely mentions the words is not
  // swallowed.
  const rawMsg = (e as { message?: unknown } | null)?.message;
  const msg = typeof rawMsg === "string" ? rawMsg : "";
  // The raw cause stays in the message: consumers match the English spelling
  // (`viewerStore` retries a just-created file while the error says ENOENT or
  // "No such file"), so replacing it with module-speak would silently drop a
  // retry path. `what` is the absolute path the operation was attempted on.
  const detail = (fallback: string) => `${what}: ${msg || fallback}`;
  // ssh2 SFTP statuses: 2 = NO_SUCH_FILE, 3 = PERMISSION_DENIED (the client
  // surfaces either as a number or as its string form).
  if (code === 2 || code === "2" || code === "ENOENT") {
    return new TargetFsError("not-found", detail("not found"), e);
  }
  if (typeof code === "string" && /NO_SUCH_FILE/i.test(code)) {
    return new TargetFsError("not-found", detail("not found"), e);
  }
  // ENOTDIR means a *file* was listed or read as a directory: from the tree's
  // point of view that is still "nothing to list", and the local adapter used
  // to answer an empty listing for it.
  if (code === "ENOTDIR" || code === 20) return new TargetFsError("not-found", detail("not a directory"), e);
  if (code === "EACCES" || code === "EPERM" || code === 3 || code === "3") {
    return new TargetFsError("denied", detail("permission denied"), e);
  }
  // Message-only fallback, kept narrow so a network error containing the same
  // words is not swallowed.
  if (/(^|:\s*)No such file(\b|$)/i.test(msg)) return new TargetFsError("not-found", detail("not found"), e);
  return new TargetFsError("transport", `${what}: ${msg || String(e)}`, e);
}

// ---------------------------------------------------------------------------
// Path algebra (one implementation per dialect, shared by every channel)
// ---------------------------------------------------------------------------

export type PathDialect = "win" | "posix";

interface Dialect {
  isAbsolute(p: string): boolean;
  join(base: string, rel: string): string;
  contains(root: string, abs: string): boolean;
  parent(p: string): string;
  normalize(p: string): string;
  expandUser(p: string, home: string): string;
}

const posixDialect: Dialect = {
  isAbsolute: (p) => p.startsWith("/") || p === "~" || p.startsWith("~/"),
  join: (base, rel) => posixPath.resolve(base, rel),
  contains: (root, abs) => abs === root || abs.startsWith(root.endsWith("/") ? root : `${root}/`),
  parent: (p) => posixPath.dirname(p),
  normalize: (p) => posixPath.normalize(p),
  expandUser: (p, home) => (p === "~" ? home : p.startsWith("~/") ? `${home}${p.slice(1)}` : p),
};

const winDialect: Dialect = {
  // `~` counts as absolute here too: expandUser() handles it, and a `~` that
  // fell through to the relative branch would be joined onto the root as a
  // literal directory named `~`. Both separators, and `//server/share` (which
  // Node itself calls absolute).
  isAbsolute: (p) =>
    /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("//") || p === "~" || /^~[\\/]/.test(p),
  join: (base, rel) => winPath.resolve(base, rel),
  // Windows compares case-insensitively — `C:\Foo` and `c:\foo` are the same
  // directory, so a case-sensitive check would reject a legal path or accept
  // an escape depending on how the root happened to be typed.
  contains: (root, abs) => {
    const r = root.toLowerCase().replace(/[\\/]+$/, "");
    const a = abs.toLowerCase();
    return a === r || a.startsWith(`${r}\\`);
  },
  parent: (p) => winPath.dirname(p),
  normalize: (p) => winPath.normalize(p),
  expandUser: (p, home) => (p === "~" ? home : /^~[\\/]/.test(p) ? `${home}${p.slice(1)}` : p),
};

/** Default dialect for a target. The BINDING's `dialect` is what the module
 *  actually uses (so a test can exercise Windows algebra on any host); this
 *  helper is what the production bindings call for their local channel. Local
 *  follows the HOST platform — a Linux/macOS build has a POSIX local
 *  filesystem, so this cannot be hard-coded to win32. WSL paths are Linux paths
 *  even though they are read over the `\\wsl$` UNC share, so containment runs in
 *  POSIX space and the mapping to UNC happens after. */
export function dialectOf(target: Target): PathDialect {
  if (target.kind !== "local") return "posix";
  return process.platform === "win32" ? "win" : "posix";
}

const DIALECTS: Record<PathDialect, Dialect> = { win: winDialect, posix: posixDialect };

// ---------------------------------------------------------------------------
// Channel port (the adapter seam)
// ---------------------------------------------------------------------------

/** One entry from a shallow listing. No path: the module computes every path
 *  it returns, so a channel cannot disagree about path algebra. */
export interface RawEntry {
  name: string;
  type: "file" | "directory";
}

/**
 * A transport that can read and write files, addressed by ABSOLUTE paths in
 * its own native space (WSL: `\\wsl$\<distro>\…`; others: their own dialect).
 * Terminating only — no caching, no filtering, no truncation: those belong to
 * the module, so every channel behaves identically.
 */
export interface Channel {
  list(absDir: string): Promise<RawEntry[]>;
  /** `null` when nothing is there. Local/UNC may throw instead of inspecting
   *  a partial result; both are normalized by the caller. */
  stat(absPath: string): Promise<{ type: "file" | "directory"; size: number } | null>;
  readRange(absPath: string, start: number, length: number): Promise<Buffer>;
  readAll(absPath: string): Promise<Buffer>;
  writeText(absPath: string, content: string): Promise<void>;
  mkdirp(absDir: string): Promise<void>;
  /** `type` is the stat the module already did: SFTP must choose between
   *  `delete` and `rmdir(recursive)` and cannot guess from the path. */
  remove(absPath: string, type: "file" | "directory"): Promise<void>;
  rename(fromAbs: string, toAbs: string): Promise<void>;
}

/** Dialect-space path → the path this channel expects, plus the home dir used
 *  to expand a `~` root. WSL wraps the local channel with a UNC mapper; every
 *  other binding is identity. */
export interface Binding {
  channel: Channel;
  /** Path algebra for THIS channel's dialect. Declared by the binding rather
   *  than derived from the target kind, so WSL can be posix-over-UNC and a test
   *  can drive Windows algebra on any host. */
  dialect: PathDialect;
  toNative(absPath: string): string;
  /** True when a path is already in this channel's own space (local: a Windows
   *  path; WSL: `\\wsl$\…`; sftp/ssh: `/…`). Session paths arrive in exactly
   *  this form for WSL and remote alike, so `readText` must pass them through
   *  instead of re-mapping them. */
  isNative(path: string): boolean;
  home(): Promise<string>;
}

export interface TargetFsDeps {
  local: Binding;
  wsl: (distro: string) => Binding;
  sftp: (remote: RemoteOpts) => Binding;
  ssh: (remote: RemoteOpts) => Binding;
  /** Shared TTL/in-flight/generation cache. Optional: without it every listing
   *  hits the channel (tests, one-shot reads). */
  cache?: TreeCache;
  /** Default listing filter; call sites that browse a project tree pass
   *  `"tree"` per call. Defaults to `"all"` = today's remote behaviour. */
  filter?: ListFilter;
}

/** The cache seam. `FileTreeIndex` already satisfies this shape. */
export interface TreeCache {
  cached(key: string): FileNode[] | undefined;
  refresh(key: string, walk: () => Promise<FileNode[]>): Promise<FileNode[]>;
  invalidate(key: string): void;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export interface TargetFs {
  readonly target: Target;
  /** Shallow listing (directories carry `children: undefined` so the renderer
   *  can expand in place). Free navigation, not contained. `fresh` bypasses the
   *  cache — the auto-follow refresh needs it because pi writes files without
   *  going through this module's mutations. */
  list(dir: string, opts?: { fresh?: boolean; filter?: ListFilter }): Promise<FileNode[]>;
  /** Contained read with the truncation/binary/image policy applied. */
  readPreview(relPath: string): Promise<PreviewPayload>;
  /** Whole-file UTF-8 read at a channel-native path (session JSONL). */
  readText(path: string): Promise<string>;
  /** Mutations refresh the cache themselves (see `invalidate`). */
  writeText(relPath: string, content: string): Promise<void>;
  mkdir(relPath: string): Promise<void>;
  remove(relPath: string): Promise<void>;
  rename(relPath: string, newName: string): Promise<void>;
  /** Drop cached listings for these paths and everything above them, up to the
   *  root (a write into `a/b/c.txt` can change the listing of `a`, `b` and `.`).
   *  Async because the key is the RESOLVED path: `~`, `/home/u/p/x` and
   *  `x` must drop the same entry, which only the expanded root can decide.
   *  Mutations call this themselves; call sites need it for writes they did
   *  NOT go through the module (pi's own file writes). */
  invalidate(paths: string[]): Promise<void>;
}

export function createTargetFs(target: Target, deps: TargetFsDeps): TargetFs {
  const binding = bindingFor(target, deps);
  const dialect = DIALECTS[binding.dialect];
  if (!target.root || !dialect.isAbsolute(target.root)) {
    throw new TargetFsError("escape", `target root must be absolute: ${JSON.stringify(target.root)}`);
  }
  /** Canonical, separator- and filter-insensitive-enough cache key: one
   *  directory has ONE key per filter, no matter whether the caller spelled it
   *  `src`, `src/`, `/p/src` or `~` first. The filter is part of the key because
   *  the SAME directory is listed with `"tree"` by the tree and `"all"` by the
   *  picker and the mention index: sharing an entry would hide `node_modules`
   *  from the picker for the TTL, or leak it into the tree. */
  const keyOf = (abs: string, filter: ListFilter) => {
    const n = dialect.normalize(abs);
    return `${targetKey(target)}\0${filter}\0${n.replace(/[\\/]+$/, "") || n}`;
  };

  /** Promises that are cleared on failure: a transient home lookup must not
   *  poison this instance for good. */
  function once(run: () => Promise<string>): () => Promise<string> {
    let p: Promise<string> | undefined;
    return () => {
      p ??= run().catch((e) => {
        p = undefined;
        throw e;
      });
      return p;
    };
  }
  const home = once(() => binding.home());
  const rootAbs = once(async () => dialect.normalize(dialect.expandUser(target.root, await home())));

  /** Canonical absolute path for a browse path. Free navigation: `~` and
   *  absolute paths are expanded, relative ones resolve against the root. */
  async function absOf(dir: string): Promise<string> {
    const input = dir || ".";
    return dialect.isAbsolute(input)
      ? dialect.normalize(dialect.expandUser(input, await home()))
      : dialect.join(await rootAbs(), dialect.normalize(input));
  }

  /** Windows drops trailing dots/spaces from a path segment when it opens it,
   *  so `.. ` addresses the parent while looking like a literal name — a
   *  containment check on the string alone would accept an escape, and `dir.`
   *  would silently alias `dir`. `.` / `..` are exempt: they are real,
   *  resolved by the containment check below. */
  function hasMangledSegment(p: string): boolean {
    if (binding.dialect !== "win") return false;
    return p.split(/[\\/]/).some((seg) => {
      if (!seg || seg === "." || seg === "..") return false;
      if (seg !== seg.trim()) return true;
      return /[. ]$/.test(seg);
    });
  }

  /** Wire path → absolute dialect path, contained. Absolute inputs (what the
   *  renderer sends for remote/WSL) are relativised against the root here —
   *  the single normalization point for the whole app. `..` is NOT rejected
   *  pre-emptively: `src/../readme.md` is inside the root and the local
   *  adapter accepted it; the containment check below is what decides. */
  async function resolveContained(relPath: string): Promise<string> {
    if (!relPath) throw new TargetFsError("escape", "empty path");
    if (hasMangledSegment(relPath)) throw new TargetFsError("escape", `mangled path segment: ${relPath}`);
    const root = await rootAbs();
    const abs = dialect.isAbsolute(relPath) ? dialect.normalize(relPath) : dialect.join(root, relPath);
    if (!dialect.contains(root, abs)) {
      throw new TargetFsError("escape", `path escapes root: ${relPath}`);
    }
    if (abs === root) throw new TargetFsError("escape", `refusing to operate on the root itself: ${relPath}`);
    return abs;
  }

  /** The resolved path and every ancestor, for cache invalidation. Every
   *  filter variant is dropped: we do not track which filter a caller cached,
   *  and one stale tree row is worse than one extra walk. */
  async function invalidateAbs(abs: string): Promise<void> {
    if (!deps.cache) return;
    let cur = dialect.normalize(abs);
    for (;;) {
      for (const filter of FILTERS) deps.cache.invalidate(keyOf(cur, filter));
      const parent = dialect.parent(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  }

  return {
    target,

    async list(dir: string, opts?: { fresh?: boolean; filter?: ListFilter }): Promise<FileNode[]> {
      const input = dir || ".";
      const absDir = await absOf(input);
      const filter: ListFilter = opts?.filter ?? deps.filter ?? "all";
      const key = keyOf(absDir, filter);
      if (!opts?.fresh && deps.cache) {
        const hit = deps.cache.cached(key);
        if (hit) return hit;
      }
      const walk = async (): Promise<FileNode[]> => {
        try {
          const entries = await binding.channel.list(binding.toNative(absDir));
          return project(input, absDir, entries, dialect, filter);
        } catch (e) {
          // Classified, not swallowed: a missing directory used to be reported
          // as an empty listing from here, which is how a permission or
          // transport failure could look like "this project has no files".
          // The tree boundary is what decides that not-found means [].
          throw classifyError(e, absDir);
        }
      };
      if (!deps.cache) return walk();
      // `fresh` goes through invalidate() so an in-flight walk for the same
      // key cannot answer with the listing this call was told to discard.
      if (opts?.fresh) await invalidateAbs(absDir);
      return deps.cache.refresh(key, walk);
    },

    async readPreview(relPath: string): Promise<PreviewPayload> {
      const abs = await resolveContained(relPath);
      return preview(relPath, binding.toNative(abs), binding.channel);
    },

    async readText(path: string): Promise<string> {
      // Session paths arrive already native for WSL (`\\wsl$\…`) and remote
      // (`/…`), so they must not be pushed through the dialect mapper again —
      // and a relative path must not be silently resolved against the process
      // CWD, which is what a bare `readAll` would do. A `~` or dialect-absolute
      // path is unambiguous, so it is expanded and mapped instead.
      let native = path;
      if (!binding.isNative(path)) {
        if (!dialect.isAbsolute(path)) {
          throw new TargetFsError("escape", `expected an absolute path: ${path}`);
        }
        native = binding.toNative(dialect.normalize(dialect.expandUser(path, await home())));
      }
      const buf = await viaChannel(native, () => binding.channel.readAll(native));
      return buf.toString("utf8");
    },

    async writeText(relPath: string, content: string): Promise<void> {
      const abs = await resolveContained(relPath);
      await viaChannel(abs, () => binding.channel.mkdirp(binding.toNative(dialect.parent(abs))));
      await viaChannel(abs, () => binding.channel.writeText(binding.toNative(abs), content));
      await invalidateAbs(abs);
    },

    async mkdir(relPath: string): Promise<void> {
      const abs = await resolveContained(relPath);
      const native = binding.toNative(abs);
      const st = await statOrNull(binding.channel, native);
      // Already a directory is fine; a file in the way is not (parity with the
      // local implementation, which reported `已存在同名文件`).
      if (st?.type === "directory") return;
      if (st) throw new TargetFsError("exists", `file occupies path: ${relPath}`);
      await viaChannel(abs, () => binding.channel.mkdirp(native));
      await invalidateAbs(abs);
    },

    async remove(relPath: string): Promise<void> {
      const abs = await resolveContained(relPath);
      const native = binding.toNative(abs);
      const st = await statOrNull(binding.channel, native);
      if (!st) throw notFound(relPath);
      await viaChannel(abs, () => binding.channel.remove(native, st.type));
      await invalidateAbs(abs);
    },

    async rename(relPath: string, newName: string): Promise<void> {
      const name = newName.trim();
      if (!isValidName(name)) throw new TargetFsError("invalid-name", `invalid name: ${newName}`);
      const abs = await resolveContained(relPath);
      const native = binding.toNative(abs);
      // Source first: renaming a missing path to its own name must not look
      // like a silent success.
      if (!(await statOrNull(binding.channel, native))) {
        throw notFound(relPath);
      }
      const targetAbs = dialect.join(dialect.parent(abs), name);
      if (targetAbs === abs) return; // same name → no-op
      if (await statOrNull(binding.channel, binding.toNative(targetAbs))) {
        throw new TargetFsError("exists", `target exists: ${name}`);
      }
      await viaChannel(abs, () => binding.channel.rename(native, binding.toNative(targetAbs)));
      await invalidateAbs(abs);
      await invalidateAbs(targetAbs);
    },

    async invalidate(paths: string[]): Promise<void> {
      for (const p of paths) {
        // Tolerate both the browse form (`~`, `/abs`) and the mutation form
        // (root-relative): both resolve to the same absolute key.
        await invalidateAbs(await absOf(p));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Module policy, shared by every channel
// ---------------------------------------------------------------------------

/** Reject unsafe names: empty, separators, traversal, and the spellings the OS
 *  silently rewrites (`x.` / ` x` open as `x`). The last rule is Windows's, but
 *  it is applied to every channel on purpose: one naming rule in the module is
 *  worth more than a POSIX server accepting a name that cannot be round-tripped
 *  to Windows, and the whole app must name files identically on both sides. */
export function isValidName(name: string): boolean {
  if (!name || name !== name.trim()) return false;
  if (name === "." || name === "..") return false;
  if (/[\/\\]/.test(name)) return false;
  return !/[. ]$/.test(name);
}

/** Directory noise that never earns a tree row. Opt-in per call site
 *  (`filter: "tree"`), because the directory picker must be able to enter
 *  `node_modules` / `.config`. */
export const TREE_NOISE = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  ".cache",
  ".vite",
  "coverage",
  ".next",
  ".nuxt",
  "build",
  ".DS_Store",
  "Thumbs.db",
  ".svn",
  ".hg",
]);

const VISIBLE_DOTFILES = new Set([
  ".gitignore",
  ".env.example",
  ".eslintrc",
  ".prettierrc",
  ".editorconfig",
  ".npmrc",
  ".pi",
]);

/** What a listing should hide. `"tree"` is the project tree's filter, applied
 *  to EVERY channel on purpose (a tree that hides `node_modules` locally but
 *  shows it over SFTP would be two products); `"all"` is for surfaces that must
 *  reach everything — the directory picker and the mention index. The module's
 *  default is `"all"`; the tree call sites pass `"tree"`. */
export type ListFilter = "tree" | "all";

/** Every filter a caller may have cached for one directory. */
const FILTERS: readonly ListFilter[] = ["tree", "all"];

function isVisibleEntry(name: string): boolean {
  if (TREE_NOISE.has(name)) return false;
  if (name.startsWith(".") && !VISIBLE_DOTFILES.has(name)) return false;
  return true;
}

/** Channel entries → tree nodes, with paths the module computed itself.
 *  Domain-preserving: an absolute browse dir yields absolute paths, a
 *  root-relative one yields root-relative paths (forward-slashed), which is
 *  what the renderer's prefix matching and the wire protocol expect. */
function project(
  inputDir: string,
  absDir: string,
  entries: RawEntry[],
  dialect: Dialect,
  filter: ListFilter = "all"
): FileNode[] {
  const absolute = dialect.isAbsolute(inputDir);
  // Trailing separators must not leak into the child paths (`src/` →
  // `src/a.ts`, not `src//a.ts`).
  const norm = dialect.normalize(inputDir).replace(/[\\/]+$/, "");
  const relPrefix = norm === "" || norm === "." ? "" : `${norm.replace(/\\/g, "/")}/`;
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" && entry.type !== "directory") continue;
    if (filter === "tree" && !isVisibleEntry(entry.name)) continue;
    const path = absolute ? dialect.join(absDir, entry.name) : `${relPrefix}${entry.name}`;
    nodes.push({
      name: entry.name,
      path,
      type: entry.type,
      ...(entry.type === "directory" ? { children: undefined } : {}),
    });
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

/** `stat` that answers `null` for "nothing there" instead of exploding.
 *  Anything else leaves this module classified, like every other failure. */
async function statOrNull(channel: Channel, absPath: string): Promise<{ type: "file" | "directory"; size: number } | null> {
  try {
    return await channel.stat(absPath);
  } catch (e) {
    const err = classifyError(e, absPath);
    if (err.kind === "not-found") return null;
    throw err;
  }
}

/** A missing path. The wording keeps the POSIX spelling the renderer already
 *  matches on (`viewerStore` auto-follows a file the write tool just created by
 *  retrying while the error says it does not exist yet) — replacing it with
 *  module-speak silently dropped that retry. */
function notFound(relPath: string): TargetFsError {
  return new TargetFsError("not-found", `No such file or directory: ${relPath}`);
}

/** Every channel call leaves the module classified — a raw ENOENT or SSH
 *  status must never reach an IPC handler that only knows `kind`. */
async function viaChannel<T>(absPath: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw classifyError(e, absPath);
  }
}

/** Preview policy: never read an oversize file whole, sample head+tail for
 *  text, and only pay for a full read when a raster image needs its base64.
 *  (`TEXT_PREVIEW_MAX_BYTES < 2 * TEXT_PREVIEW_HALF_BYTES` is what keeps the
 *  two windows from overlapping; the module asserts it at load time.) */
async function preview(relPath: string, native: string, channel: Channel): Promise<PreviewPayload> {
  const st = await statOrNull(channel, native);
  if (!st) throw notFound(relPath);
  const size = st.size;
  if (size <= TEXT_PREVIEW_MAX_BYTES) {
    return payloadOf(await viaChannel(native, () => channel.readAll(native)), relPath);
  }
  const half = TEXT_PREVIEW_HALF_BYTES;
  const head = await viaChannel(native, () => channel.readRange(native, 0, half));
  const tail = await viaChannel(native, () => channel.readRange(native, size - half, half));
  if (isBinaryBuffer(head)) {
    let image;
    if (rasterImageMimeOf(relPath) && size <= IMAGE_PREVIEW_MAX_BYTES) {
      image = imagePayloadOf(await viaChannel(native, () => channel.readAll(native)), relPath);
    }
    return { content: BINARY_NOTICE, bytes: size, isBinary: true, image };
  }
  return {
    content: `${head.toString("utf8")}\n\n……\n\n${tail.toString("utf8")}`,
    bytes: size,
    isBinary: false,
    truncated: true,
  };
}

function payloadOf(buf: Buffer, relPath: string): PreviewPayload {
  if (isBinaryBuffer(buf)) {
    return { content: BINARY_NOTICE, bytes: buf.length, isBinary: true, image: imagePayloadOf(buf, relPath) };
  }
  return { content: buf.toString("utf-8"), bytes: buf.length, isBinary: false };
}

function bindingFor(target: Target, deps: TargetFsDeps): Binding {
  switch (target.kind) {
    case "local":
      return deps.local;
    case "wsl":
      return deps.wsl(target.distro);
    case "sftp":
      return deps.sftp(target.remote);
    default:
      return deps.ssh(target.remote);
  }
}
