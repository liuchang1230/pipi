/**
 * Shared Markdown renderer for chat messages and file previews.
 *
 * Uses react-markdown + remark-gfm (tables, strikethrough, task lists) +
 * rehype-highlight (syntax-highlighted code blocks). The highlight.js theme
 * is toggled via CSS `data-theme` so it follows the app theme.
 */
import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// Import the light theme globally. Dark-mode overrides live in styles.css
// under [data-theme="dark"] so they scope correctly without theme-specific JS.
import "highlight.js/styles/github.css";

interface MarkdownProps {
  content: string;
  className?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export default function Markdown({ content, className, onContextMenu }: MarkdownProps) {
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
              onClick={(e) => {
                e.preventDefault();
                if (props.href) {
                  import("electron").then(({ shell }) => shell.openExternal(props.href!));
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
