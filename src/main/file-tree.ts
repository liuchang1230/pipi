/**
 * File tree builder + content reader for the left/right panels.
 *
 * Runs in the main process (renderer has no Node access). All paths returned
 * to the renderer are relative to the project root; reads resolve relative to
 * root with a containment check so the renderer can never escape cwd.
 */
import { readdir, readFile, stat, mkdir, writeFile, rm, rename } from "node:fs/promises";
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

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export async function listFiles(
  rootDir: string,
  maxDepth = 12
): Promise<FileNode[]> {
  return walk(rootDir, rootDir, 0, maxDepth);
}

async function walk(
  rootDir: string,
  dir: string,
  depth: number,
  maxDepth: number
): Promise<FileNode[]> {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
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
    const fullPath = join(dir, entry.name);
    const relPath = toPosix(relative(rootDir, fullPath));
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        children: await walk(rootDir, fullPath, depth + 1, maxDepth),
      });
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
): Promise<{ content: string; bytes: number; isBinary: boolean; error?: string }> {
  const abs = resolveWithin(rootDir, relPath);
  const buf = await readFile(abs);
  const isBinary = isBinaryBuffer(buf);
  if (isBinary) {
    return { content: "(二进制文件，无法以文本显示)", bytes: buf.length, isBinary: true };
  }
  return { content: buf.toString("utf-8"), bytes: buf.length, isBinary: false };
}

function isBinaryBuffer(buf: Buffer): boolean {
  // Heuristic: null bytes or many non-text bytes in first 8KB → binary.
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
