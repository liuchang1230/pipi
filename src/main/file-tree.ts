/**
 * File tree builder + content reader for the left/right panels.
 *
 * Runs in the main process (renderer has no Node access). All paths returned
 * to the renderer are relative to the project root; reads resolve relative to
 * root with a containment check so the renderer can never escape cwd.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

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
