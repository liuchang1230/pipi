/**
 * File tree builder + content reader for the left/right panels.
 *
 * Runs in the main process (renderer has no Node access). All paths returned
 * to the renderer are relative to the project root; reads resolve relative to
 * root with a containment check so the renderer can never escape cwd.
 */
import { readdir, readFile, stat, mkdir, writeFile, rm, rename, open as fspOpen } from "node:fs/promises";
import { join, relative, resolve, sep, dirname } from "node:path";

const IGNORE = new Set([
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

export interface FileNode {
  name: string;
  path: string; // relative to root, uses forward slashes
  type: "file" | "directory";
  children?: FileNode[];
}

/** Base64 image payload for the viewer's <img> preview. */
export interface ImagePayload {
  mimeType: string;
  base64: string;
}

/** Raster images larger than this are NOT base64-encoded for preview. */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** Text previews larger than this are NOT shipped whole — only the head+tail
 *  windows are read, and the file itself is never fully read into memory
 *  (a whole-file sync utf-8 decode used to stall the pty's event loop and
 *  the renderer when a large log/build artifact was clicked). */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Head/tail window size for oversize text previews. */
export const TEXT_PREVIEW_HALF_BYTES = 512 * 1024;

const RASTER_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};

/** MIME type if `path` names a previewable raster image, else null. */
export function rasterImageMimeOf(path: string): string | null {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return RASTER_IMAGE_MIME[base.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Build the viewer image payload for a buffer, or undefined when the file is
 * not a raster image or exceeds the preview size cap (too large to ship over
 * IPC as base64 without freezing the app).
 */
export function imagePayloadOf(buf: Buffer, path: string): ImagePayload | undefined {
  const mimeType = rasterImageMimeOf(path);
  if (!mimeType) return undefined;
  if (buf.length === 0 || buf.length > IMAGE_PREVIEW_MAX_BYTES) return undefined;
  return { mimeType, base64: buf.toString("base64") };
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export async function listFiles(rootDir: string): Promise<FileNode[]> {
  return listDirChildren(rootDir, ".");
}

/**
 * Shallow listing of ONE directory: files plus directories whose `children`
 * is `undefined` (not yet loaded). The renderer fetches children on expand —
 * the eager depth-12 recursive walk is gone, so a tree click costs at most
 * one shallow readdir instead of walking (and shipping over IPC) the whole
 * subtree, most of which the user never expands.
 */
export async function listDirChildren(rootDir: string, relDir: string): Promise<FileNode[]> {
  const abs = resolveWithin(rootDir, relDir);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    // Skip hidden entries (dotfiles/dotdirs) except a useful allowlist.
    if (entry.name.startsWith(".") && !VISIBLE_DOTFILES.has(entry.name)) {
      continue;
    }
    const relPath = toPosix(relative(rootDir, join(abs, entry.name)));
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: relPath, type: "directory", children: undefined });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: relPath, type: "file" });
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

const VISIBLE_DOTFILES = new Set([
  ".gitignore",
  ".env.example",
  ".eslintrc",
  ".prettierrc",
  ".editorconfig",
  ".npmrc",
  ".pi",
]);

/** Resolve a renderer-supplied (possibly relative) path against root, with containment. */
function resolveWithin(rootDir: string, relPath: string): string {
  const abs = resolve(rootDir, relPath);
  const rootResolved = resolve(rootDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error(`Path escapes project root: ${relPath}`);
  }
  return abs;
}

export async function readFileContent(
  rootDir: string,
  relPath: string
): Promise<{ content: string; bytes: number; isBinary: boolean; image?: ImagePayload; truncated?: boolean; error?: string }> {
  const abs = resolveWithin(rootDir, relPath);
  return readPreviewFromAbs(abs, relPath);
}

/** Positioned read of [start, start+len) — never buffers the whole file. */
async function readSlice(abs: string, start: number, len: number): Promise<Buffer> {
  const handle = await fspOpen(abs, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Preview a file at an ABSOLUTE path (shared by the local and WSL read
 * paths). Files at/below TEXT_PREVIEW_MAX_BYTES are read whole; larger ones
 * are sampled head+tail via positioned reads — the whole file is never
 * buffered. `relPath` drives the image payload decision.
 */
export async function readPreviewFromAbs(
  abs: string,
  relPath: string
): Promise<{ content: string; bytes: number; isBinary: boolean; image?: ImagePayload; truncated?: boolean; error?: string }> {
  const st = await stat(abs);
  if (st.size <= TEXT_PREVIEW_MAX_BYTES) {
    const buf = await readFile(abs);
    const isBinary = isBinaryBuffer(buf);
    if (isBinary) {
      return {
        content: "(二进制文件，无法以文本显示)",
        bytes: buf.length,
        isBinary: true,
        image: imagePayloadOf(buf, relPath),
      };
    }
    return { content: buf.toString("utf-8"), bytes: buf.length, isBinary: false };
  }
  // Oversize: sample head+tail without reading the whole file into memory.
  const half = TEXT_PREVIEW_HALF_BYTES;
  const head = await readSlice(abs, 0, half);
  const tail = await readSlice(abs, st.size - half, half);
  if (isBinaryBuffer(head)) {
    let image: ImagePayload | undefined;
    if (rasterImageMimeOf(relPath) && st.size <= IMAGE_PREVIEW_MAX_BYTES) {
      // A raster within the preview cap still needs the FULL bytes for the
      // base64 payload — read it (bounded by IMAGE_PREVIEW_MAX_BYTES, OK).
      const full = await readFile(abs);
      image = imagePayloadOf(full, relPath);
    }
    return {
      content: "(二进制文件，无法以文本显示)",
      bytes: st.size,
      isBinary: true,
      image,
    };
  }
  return {
    content: `${head.toString("utf8")}\n\n……\n\n${tail.toString("utf8")}`,
    bytes: st.size,
    isBinary: false,
    truncated: true,
  };
}

export function isBinaryBuffer(buf: Buffer): boolean {
  // Heuristic: null bytes or many non-text bytes in first 8KB → binary.
  // Exported for cross-backend consistency (SFTP uses the same rule).
  const sample = buf.subarray(0, 8192);
  if (sample.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return true; // NUL → definitely binary
    if (b < 0x09 || (b > 0x0d && b < 0x20)) nonText++;
  }
  return nonText / sample.length > 0.3;
}

export async function pathInfo(rootDir: string, relPath: string) {
  const abs = resolveWithin(rootDir, relPath);
  const s = await stat(abs);
  return { isDirectory: s.isDirectory(), isFile: s.isFile() };
}

export type FileOpResult = { ok: true } | { ok: false; error: string };

function opError(error: unknown): FileOpResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Reject unsafe names: empty, or containing path separators / traversal. */
export function isValidName(name: string): boolean {
  if (!name || !name.trim()) return false;
  const n = name.trim();
  if (n === "." || n === "..") return false;
  if (/[\/\\]/.test(n)) return false;
  return true;
}

/** Write/overwrite a file (creating parent directories). */
export async function writeFileContent(
  rootDir: string,
  relPath: string,
  content: string
): Promise<FileOpResult> {
  try {
    const abs = resolveWithin(rootDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
    return { ok: true };
  } catch (error) {
    return opError(error);
  }
}

/** Create a directory (recursive; errors if an existing file occupies the path). */
export async function createDirectory(rootDir: string, relPath: string): Promise<FileOpResult> {
  try {
    const abs = resolveWithin(rootDir, relPath);
    const existing = await stat(abs).catch(() => null);
    if (existing && !existing.isDirectory()) {
      return { ok: false, error: `已存在同名文件: ${relPath}` };
    }
    if (existing) return { ok: true }; // already a directory
    await mkdir(abs, { recursive: true });
    return { ok: true };
  } catch (error) {
    return opError(error);
  }
}

/** Delete a file or a directory (recursive for directories). */
export async function deletePath(rootDir: string, relPath: string): Promise<FileOpResult> {
  try {
    const abs = resolveWithin(rootDir, relPath);
    const existing = await stat(abs).catch(() => null);
    if (!existing) {
      return { ok: false, error: `路径不存在: ${relPath}` };
    }
    await rm(abs, { recursive: true, force: false });
    return { ok: true };
  } catch (error) {
    return opError(error);
  }
}

/** Rename a file/directory within its parent (newName must be a bare name). */
export async function renamePath(
  rootDir: string,
  relPath: string,
  newName: string
): Promise<FileOpResult> {
  if (!isValidName(newName)) {
    return { ok: false, error: "名称不合法（不能包含 / 或 \\）" };
  }
  try {
    const abs = resolveWithin(rootDir, relPath);
    const existing = await stat(abs).catch(() => null);
    if (!existing) return { ok: false, error: `路径不存在: ${relPath}` };
    const target = join(dirname(abs), newName);
    // abs is inside root and newName is a bare name → target is also inside root.
    const rootResolved = resolve(rootDir);
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      return { ok: false, error: "目标路径越界" };
    }
    const targetExists = await stat(target).catch(() => null);
    if (targetExists && target !== abs) {
      return { ok: false, error: `目标已存在: ${newName}` };
    }
    if (target === abs) return { ok: true }; // same name → no-op
    await rename(abs, target);
    return { ok: true };
  } catch (error) {
    return opError(error);
  }
}
