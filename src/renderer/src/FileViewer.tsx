/**
 * Right-panel file viewer (Q3 + markdown/code highlighting).
 *
 * - .md / .markdown → rendered as GitHub-flavored Markdown (shared component).
 * - Code files (.js/.ts/.py/.json/...) → syntax-highlighted via highlight.js.
 * - Other text → plain <pre>.
 * - Binary → placeholder.
 */
import { useMemo, useCallback } from "react";
import hljs from "highlight.js/lib/common";
import Markdown from "./Markdown";

export interface CurrentFile {
  path: string;
  content: string;
  bytes: number;
  isBinary: boolean;
  /** True when shown because pi's tools touched it (auto-follow), false when opened manually. */
  followed: boolean;
  source?: "local" | "remote";
  sourceLabel?: string;
}

interface FileViewerProps {
  file: CurrentFile | null;
  loading: boolean;
}

// Map file extensions to highlight.js language ids.
const EXT_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python",
  json: "json", jsonc: "json",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  md: "markdown", markdown: "markdown",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml",
  toml: "ini", ini: "ini",
  go: "go",
  rs: "rust",
  java: "java", kt: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sql: "sql",
  dockerfile: "dockerfile",
  gitignore: "plaintext",
  lua: "lua",
  r: "r",
  pl: "perl",
  vue: "xml",
};

function extOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return base.toLowerCase(); // e.g. "Dockerfile"
  return base.slice(dot + 1).toLowerCase();
}

function isMarkdown(path: string): boolean {
  return ["md", "markdown"].includes(extOf(path));
}

/** Highlight code text; falls back to auto-detection then plaintext. */
function highlightCode(code: string, path: string): string {
  const lang = EXT_LANG[extOf(path)];
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default function FileViewer({ file, loading }: FileViewerProps) {
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (selectedText) {
      navigator.clipboard.writeText(selectedText).catch(() => {
        // Fallback for older Electron: use execCommand
        document.execCommand("copy");
      });
    }
  }, []);

  const rendered = useMemo(() => {
    if (!file || file.isBinary) return null;
    if (isMarkdown(file.path)) return { kind: "md" as const };
    const lang = EXT_LANG[extOf(file.path)];
    const isCode =
      !!lang ||
      /\.(js|ts|py|json|css|html|xml|sh|yml|yaml|go|rs|java|c|cpp|cs|rb|php|swift|sql|lua|vue|tsx|jsx|mts|cts)$/i.test(
        file.path
      );
    if (isCode) {
      return { kind: "code" as const, html: highlightCode(file.content, file.path) };
    }
    return { kind: "text" as const };
  }, [file]);

  if (loading) {
    return <div className="placeholder" onContextMenu={handleContextMenu}>读取中…</div>;
  }
  if (!file) {
    return (
      <pre className="viewer-content" onContextMenu={handleContextMenu}>
        （只读查看器 · 工具操作文件时自动跟随，或点击左侧文件查看）
      </pre>
    );
  }
  if (file.isBinary) {
    return <pre className="viewer-content" onContextMenu={handleContextMenu}>📎 二进制文件（{file.bytes.toLocaleString()} B）</pre>;
  }

  if (rendered?.kind === "md") {
    return <Markdown content={file.content} className="viewer-content" onContextMenu={handleContextMenu} />;
  }
  if (rendered?.kind === "code") {
    return (
      <pre className="viewer-content code-view" onContextMenu={handleContextMenu}>
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      </pre>
    );
  }
  return <pre className="viewer-content">{file.content}</pre>;
}
