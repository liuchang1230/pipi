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
import { Icon } from "./components/Icon";

export interface CurrentFile {
  path: string;
  content: string;
  bytes: number;
  isBinary: boolean;
  /** Base64 image payload when the file is a previewable raster image. */
  image?: { mimeType: string; base64: string };
  /** Set when the file exceeded the preview cap: content is head+tail only,
   *  and the file is locked read-only (saving would clobber the truncation). */
  truncated?: boolean;
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

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg"]);
// Syntax highlighting is presentation, not a reason to block file-open. Keep
// large source previews responsive by rendering escaped text for them.
const HIGHLIGHT_MAX_CHARS = 160_000;

/** True when the file is a raster image (previewed via main's base64 payload) or an SVG (inline data URL). */
function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extOf(path));
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

  const canEdit = !!file && !file.isBinary && !file.error && !loading && !file.truncated;

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
    if (!file) return null;
    // Image files: raster payload from main, or SVG inlined from its text
    // content. Must run BEFORE the isBinary early-return (rasters are binary).
    // A truncated SVG (oversize) falls through to the text branches — the
    // inline data-URL would be a broken image, and the notice bar needs to
    // render above the head/tail content.
    if (isImagePath(file.path) && !file.truncated) {
      if (file.image) {
        return { kind: "image" as const, src: `data:${file.image.mimeType};base64,${file.image.base64}` };
      }
      if (file.isBinary) {
        return { kind: "image" as const, src: null }; // raster over the preview size cap
      }
      // Only SVG is a text-based image (inline as a data URL); other image
      // extensions landing here are degenerate (e.g. empty files).
      if (extOf(file.path) === "svg") {
        return { kind: "image" as const, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}` };
      }
    }
    if (file.isBinary) return null;
    if (isMarkdown(file.path)) return { kind: "md" as const, plain: file.content.length > HIGHLIGHT_MAX_CHARS };
    const lang = EXT_LANG[extOf(file.path)];
    const isCode =
      !!lang ||
      /\.(js|ts|py|json|css|html|xml|sh|yml|yaml|go|rs|java|c|cpp|cs|rb|php|swift|sql|lua|vue|tsx|jsx|mts|cts)$/i.test(
        file.path
      );
    if (isCode) {
      return {
        kind: "code" as const,
        html: file.content.length <= HIGHLIGHT_MAX_CHARS ? highlightCode(file.content, file.path) : escapeHtml(file.content),
        plain: file.content.length > HIGHLIGHT_MAX_CHARS,
      };
    }
    return { kind: "text" as const };
  }, [file]);

  if (loading) {
    return <div className="placeholder" onContextMenu={handleContextMenu}>读取中…</div>;
  }
  if (!file) {
    return (
      <pre className="viewer-content" onContextMenu={handleContextMenu}>
        （文件查看器 · 工具操作文件时自动跟随；可点「编辑」，或点击左侧文件查看）
      </pre>
    );
  }

  const actions = (
    <div className="viewer-actions">
      {editing ? (
        <>
          <span className="viewer-edit-hint">Ctrl+S 保存</span>
          <button className="btn btn-small btn-primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : (<><Icon name="save" /> 保存</>)}
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
          title={canEdit ? "编辑文件" : file?.truncated ? "文件过大（预览为截断内容），已锁定为只读" : "二进制文件或未打开文件，不可编辑"}
        >
          <Icon name="pencil" /> 编辑
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
            ? "文件不存在（可能已被移动或删除）"
            : `无法读取文件：${file.error}`}
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

  if (rendered?.kind === "image") {
    return (
      <div className="viewer-body">
        {actions}
        {rendered.src ? (
          <img
            className="viewer-image"
            src={rendered.src}
            alt={file.path}
            draggable={false}
            onContextMenu={handleContextMenu}
          />
        ) : (
          <div className="viewer-content viewer-image-too-large" onContextMenu={handleContextMenu}>
            图片文件（{(file.bytes / 1024 / 1024).toFixed(1)} MB）超过预览上限（10 MB），无法预览
          </div>
        )}
      </div>
    );
  }

  if (file.isBinary) {
    return (
      <div className="viewer-body">
        {actions}
        <pre className="viewer-content" onContextMenu={handleContextMenu}>二进制文件（{file.bytes.toLocaleString()} B）</pre>
      </div>
    );
  }

  // Oversize text: the preview is head+tail only, and the file is locked
  // read-only (saving the truncated buffer would clobber the original).
  const truncatedNote = file.truncated ? (
    <div className="viewer-truncated-note">
      文件过大（{(file.bytes / 1024 / 1024).toFixed(1)} MB）：仅显示首尾各 512 KB，已锁定为只读
    </div>
  ) : null;

  if (rendered?.kind === "md") {
    return (
      <div className="viewer-body">
        {actions}
        {truncatedNote}
        {rendered.plain && (
          <div className="viewer-truncated-note">提示：为保持打开速度，此 Markdown 文件超过 160 KB，已跳过代码块语法高亮</div>
        )}
        <Markdown content={file.content} plainCode={rendered.plain} className="viewer-content" currentPath={file.path} onContextMenu={handleContextMenu} />
      </div>
    );
  }
  if (rendered?.kind === "code") {
    return (
      <div className="viewer-body">
        {actions}
        {truncatedNote}
        {rendered.plain && (
          <div className="viewer-truncated-note">提示：为保持打开速度，此源文件超过 160 KB，已跳过语法高亮</div>
        )}
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
      {truncatedNote}
      <pre className="viewer-content" onContextMenu={handleContextMenu}>{file.content}</pre>
    </div>
  );
}
