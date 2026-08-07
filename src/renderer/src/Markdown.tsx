/**
 * Shared Markdown renderer for chat messages and file previews.
 *
 * Uses react-markdown + remark-gfm (tables, strikethrough, task lists) +
 * rehype-highlight (syntax-highlighted code blocks). The highlight.js theme
 * is toggled via CSS `data-theme` so it follows the app theme.
 */
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
  className?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
  currentPath?: string;
}

export default function Markdown({ content, className, onContextMenu, currentPath }: MarkdownProps) {
  return (
    <div className={`markdown-body${className ? ` ${className}` : ""}`} onContextMenu={onContextMenu}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
