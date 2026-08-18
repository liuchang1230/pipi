/**
 * Shared Markdown renderer for chat messages and file previews.
 *
 * Uses react-markdown + remark-gfm (tables, strikethrough, task lists) +
 * rehype-highlight (syntax-highlighted code blocks). The highlight.js theme
 * is toggled via CSS `data-theme` so it follows the app theme.
 */
import React, { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { openExternalSafe } from "./openExternal";
import { useViewerStore } from "./stores/viewerStore";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// Import the light theme globally. Dark-mode overrides live in styles.css
// under [data-theme="dark"] so they scope correctly without theme-specific JS.
import "highlight.js/styles/github.css";

interface MarkdownProps {
  content: string;
  /** Above this size, skip syntax highlighting to keep the renderer responsive. */
  plainCode?: boolean;
  /** Chat/terminal transcripts may contain literal `~~` decorations. */
  disableStrikeThrough?: boolean;
  className?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
  currentPath?: string;
}

/**
 * Markdown <img>: renders external/data URLs directly; local relative paths
 * are resolved against the current file and served as base64 data URLs (same
 * origin as the right-panel viewer, so images work in file previews and chat).
 */
const MarkdownImage = memo(function MarkdownImage({
  src,
  alt,
  currentPath,
}: {
  src?: string;
  alt?: string;
  currentPath?: string;
}) {
  const isExternal = !src || /^(https?:|data:)/i.test(src);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isExternal) return; // render src as-is
    let alive = true;
    setDataUrl(null);
    setFailed(false);
    const st = useViewerStore.getState();
    void (async () => {
      const resolved = await window.api.file.resolveLink({
        currentPath,
        href: src!,
        tabId: st.currentFile?.tabId,
        rootPath: st.currentFile?.rootPath,
      });
      if (!alive) return;
      if (!resolved.ok) {
        setFailed(true);
        return;
      }
      const res = await window.api.file.read(resolved.tabId, resolved.relPath, resolved.rootPath);
      if (!alive) return;
      if (res.error) {
        setFailed(true);
        return;
      }
      if (res.image) {
        setDataUrl(`data:${res.image.mimeType};base64,${res.image.base64}`);
        return;
      }
      if (res.isBinary) {
        setFailed(true); // over the preview size cap (or unsupported binary) — same visible outcome
        return;
      }
      setFailed(true); // text file referenced as an image
    })().catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [src, currentPath, isExternal]);

  if (isExternal) return <img src={src} alt={alt ?? ""} loading="lazy" />;
  if (dataUrl) return <img src={dataUrl} alt={alt ?? ""} loading="lazy" />;
  if (failed) return <span className="markdown-img-failed" title={src}>🖼 图片加载失败</span>;
  return <span className="markdown-img-loading">🖼 图片加载中…</span>;
});

const Markdown = memo(function Markdown({ content, plainCode = false, disableStrikeThrough = false, className, onContextMenu, currentPath }: MarkdownProps) {
  // Terminal/TUI transcripts frequently use tilde characters as literal
  // numeric-range decoration (for example `0.05~0.1`). GFM's default
  // singleTilde mode interprets that as strikethrough and can draw a line
  // through nearby text. Disable the syntax at the parser seam rather than
  // escaping the text, so the displayed/copyable content remains byte-faithful.
  const markdownContent = content;
  return (
    <div className={`markdown-body${className ? ` ${className}` : ""}`} onContextMenu={onContextMenu}>
      <ReactMarkdown
        remarkPlugins={[disableStrikeThrough ? [remarkGfm, { singleTilde: false }] : remarkGfm]}
        rehypePlugins={plainCode ? [] : [rehypeHighlight]}
        components={{
          // Open links externally instead of navigating inside Electron.
          a: ({ node, ...props }) => (
            <a
              {...props}
              onClick={async (e) => {
                e.preventDefault();
                if (!props.href) return;
                const resolved = await window.api.file.resolveLink({
                  currentPath,
                  href: props.href,
                  tabId: useViewerStore.getState().currentFile?.tabId,
                  rootPath: useViewerStore.getState().currentFile?.rootPath,
                });
                if (resolved.ok) {
                  await useViewerStore.getState().openFile(resolved.relPath, false, { tabId: resolved.tabId, rootPath: resolved.rootPath });
                } else {
                  openExternalSafe(props.href);
                }
              }}
            />
          ),
          img: ({ node, ...props }) => (
            <MarkdownImage src={props.src} alt={props.alt} currentPath={currentPath} />
          ),
        }}
      >
        {markdownContent}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;