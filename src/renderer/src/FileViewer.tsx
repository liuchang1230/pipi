/**
 * Right-panel file viewer (Q3 + markdown/code highlighting).
 *
 * - .md / .markdown → rendered as GitHub-flavored Markdown (shared component).
 * - Code files (.js/.ts/.py/.json/...) → syntax-highlighted via highlight.js.
 * - Other text → plain <pre>.
 * - Binary → placeholder.
 */
import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import hljs from "highlight.js/lib/common";
import Markdown from "./Markdown";

export interface CurrentFile {
  path: string;
  content: string;
  bytes: number;
  isBinary: boolean;
  /** True when shown because pi's tools touched it (auto-follow), false when opened manually. */
  followed: boolean;
  /** Set when the read failed (e.g. ENOENT); content then carries the message. */
  error?: string;
  /** Tab + preview root the file was opened from — saves go back HERE, not
   *  to whatever tab/root is active when the user hits Ctrl+S. */
  tabId?: string;
  rootPath?: string;
  source?: "local" | "remote";
  sourceLabel?: string;
}

interface FileViewerProps {
  file: CurrentFile | null;
  loading: boolean;
  /** Active tab id, passed through for save (undefined = local default tab). */
  tabId?: string;
  /** Called after a successful save (App re-reads the file + refreshes tree).
   *  May return a promise; save mode stays active until it resolves so a quick
   *  re-edit can never seed the draft from pre-save content. */
  onSaved?: (path: string) => Promise<void> | void;
  onToast?: (msg: string, type: "ok" | "err") => void;
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

export default function FileViewer({ file, loading, tabId, onSaved, onToast }: FileViewerProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Content the viewer was last seeded from. If the file changes underneath
  // (auto-follow / agent write) while editing, we bail out so a later Ctrl+S
  // can never overwrite newer content with a stale draft.
  const contentRef = useRef<string | null>(null);

  // Switching to another file (or closing the viewer) cancels editing.
  useEffect(() => {
    setEditing(false);
  }, [file?.path]);

  // External content change while editing → discard the draft (lose-work-safe).
  useEffect(() => {
    if (!file) {
      contentRef.current = null;
      return;
    }
    if (editing && contentRef.current !== null && contentRef.current !== file.content) {
      setEditing(false);
      setDraft("");
    }
    contentRef.current = file.content;
  }, [file, editing]);

  // Enter edit mode with a fresh draft.
  const startEdit = useCallback(() => {
    if (!file || file.isBinary || loading) return;
    contentRef.current = file.content;
    setDraft(file.content);
    setEditing(true);
  }, [file, loading]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft("");
  }, []);

  const save = useCallback(async () => {
    if (!file || saving) return;
    setSaving(true);
    try {
      // Write back to where the file was OPENED from (preview root / origin
      // tab), never to the currently-active tab/project.
      const res = await window.api.file.write(file.tabId ?? tabId, file.path, draft, file.rootPath);
      if (res.ok) {
        // Stay in save mode until the re-read lands so a quick 编辑 re-click
        // seeds the draft from fresh content.
        await onSaved?.(file.path);
        setEditing(false);
        onToast?.("已保存", "ok");
      } else {
        onToast?.(res.error || "保存失败", "err");
      }
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : "保存失败", "err");
    } finally {
      setSaving(false);
    }
  }, [file, saving, tabId, draft, onSaved, onToast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    },
    [save],
  );

  const canEdit = !!file && !file.isBinary && !file.error && !loading;

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
        （文件查看器 · 工具操作文件时自动跟随；可点 ✏️ 编辑，或点击左侧文件查看）
      </pre>
    );
  }

  const actions = (
    <div className="viewer-actions">
      {editing ? (
        <>
          <span className="viewer-edit-hint">Ctrl+S 保存</span>
          <button className="btn btn-small btn-primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "💾 保存"}
          </button>
          <button className="btn btn-small" onClick={cancelEdit} disabled={saving}>
            取消
          </button>
        </>
      ) : (
        <button
          className="btn btn-small"
          onClick={startEdit}
          disabled={!canEdit}
          title={canEdit ? "编辑文件" : "二进制文件或未打开文件，不可编辑"}
        >
          ✏️ 编辑
        </button>
      )}
    </div>
  );

  if (file.error) {
    return (
      <div className="viewer-body">
        {actions}
        <pre className="viewer-content viewer-error" onContextMenu={handleContextMenu}>
          {file.error.includes("ENOENT")
            ? "⚠️ 文件不存在（可能已被移动或删除）"
            : `⚠️ 无法读取文件：${file.error}`}
        </pre>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="viewer-editing">
        {actions}
        <textarea
          ref={taRef}
          className="viewer-edit-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoFocus
        />
      </div>
    );
  }

  if (file.isBinary) {
    return (
      <div className="viewer-body">
        {actions}
        <pre className="viewer-content" onContextMenu={handleContextMenu}>📎 二进制文件（{file.bytes.toLocaleString()} B）</pre>
      </div>
    );
  }

  if (rendered?.kind === "md") {
    return (
      <div className="viewer-body">
        {actions}
        <Markdown content={file.content} className="viewer-content" currentPath={file.path} onContextMenu={handleContextMenu} />
      </div>
    );
  }
  if (rendered?.kind === "code") {
    return (
      <div className="viewer-body">
        {actions}
        <pre className="viewer-content code-view" onContextMenu={handleContextMenu}>
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        </pre>
      </div>
    );
  }
  return (
    <div className="viewer-body">
      {actions}
      <pre className="viewer-content" onContextMenu={handleContextMenu}>{file.content}</pre>
    </div>
  );
}
