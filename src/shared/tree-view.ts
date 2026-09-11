/**
 * tree-view.ts — pure display-layer helpers shared by the session tree
 * dialog (TreeDialog.tsx) and its tests: per-entry visibility, search-text
 * extraction and compact timestamps. Mirrors the visibility rules of pi's
 * TUI TreeSelectorComponent.applyFilter so both views agree on what a row
 * is. No React / Electron runtime — safe to unit test in node.
 *
 * Structural typing: the node/entry shapes here are the minimal subset the
 * logic reads, so both the renderer's richer TreeEntry interfaces and the
 * shared tree-build TreeEntry satisfy them without casts.
 */

/** Minimal entry shape the visibility/search logic needs. */
export interface TreeViewEntryLike {
  id: string;
  type: string;
  parentId?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
  command?: string;
  content?: unknown;
  customType?: string;
  summary?: string;
  name?: string;
  modelId?: string;
  thinkingLevel?: string;
  label?: string;
}

/** Minimal node shape (entry + optional label; children not needed here). */
export interface TreeViewNodeLike {
  entry: TreeViewEntryLike;
  label?: string;
}

/** Minimal flattened row (any flat list whose node satisfies TreeViewNodeLike). */
export interface TreeFlatLike {
  node: TreeViewNodeLike;
}

export type TreeFilterMode = "default" | "user-only" | "no-tools" | "labeled-only" | "all";

function normalizeText(s: string): string {
  return s.replace(/[\n\t]/g, " ").trim();
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }
  return "";
}

/** Entry types hidden by the default (标准) view — bookkeeping only. */
function isSettingsEntry(e: TreeViewEntryLike): boolean {
  return e.type === "label" || e.type === "custom" || e.type === "model_change" || e.type === "thinking_level_change" || e.type === "session_info";
}

/** Searchable text: role/label/summary/type keywords + content, like the TUI. */
export function searchableText(node: TreeViewNodeLike): string {
  const e = node.entry;
  const parts: string[] = [];
  if (node.label) parts.push(node.label);
  const msg = e.message;
  if (e.type === "message") {
    if (msg?.role) parts.push(msg.role);
    if (msg?.content) parts.push(textOfContent(msg.content));
    if (msg?.role === "bashExecution" && e.command) parts.push(e.command);
  } else {
    if (e.customType) parts.push(e.customType);
    if (typeof e.content === "string") parts.push(e.content);
    else if (e.content) parts.push(textOfContent(e.content));
    if (e.type === "branch_summary" && e.summary) parts.push("branch summary", e.summary);
    if (e.type === "session_info") {
      parts.push("title");
      if (e.name) parts.push(e.name);
    }
    if (e.type === "model_change") parts.push("model", e.modelId ?? "");
    if (e.type === "thinking_level_change") parts.push("thinking", e.thinkingLevel ?? "");
    if (e.type === "label") parts.push("label", e.label ?? "");
    if (e.type === "compaction") parts.push("compaction");
  }
  return parts.join(" ");
}

/**
 * Apply visibility + search over the flat list (order preserved), mirroring
 * the TUI's applyFilter: bookkeeping entries hidden in the default view,
 * tool-call-only assistant rows hidden (unless error/aborted/current leaf),
 * multi-token AND search.
 */
export function applyVisibility<T extends TreeFlatLike>(
  flat: T[],
  filterMode: TreeFilterMode,
  query: string,
  leafId: string | null,
): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: T[] = [];
  for (const f of flat) {
    const e = f.node.entry;
    const isCurrentLeaf = e.id === leafId;
    // Hide assistant rows that carry only tool calls (no text) unless
    // error/aborted/current — reduces noise in long agent turns.
    if (e.type === "message" && e.message?.role === "assistant" && !isCurrentLeaf) {
      const hasText = normalizeText(textOfContent(e.message.content)).length > 0;
      const stop = e.message.stopReason;
      const isErrorOrAborted = (stop != null && stop !== "stop" && stop !== "toolUse") || e.message.errorMessage != null;
      if (!hasText && !isErrorOrAborted) continue;
    }
    let passes = true;
    if (filterMode === "user-only") passes = e.type === "message" && e.message?.role === "user";
    else if (filterMode === "no-tools") passes = !isSettingsEntry(e) && !(e.type === "message" && e.message?.role === "toolResult");
    else if (filterMode === "labeled-only") passes = f.node.label !== undefined;
    else if (filterMode === "all") passes = true;
    else passes = !isSettingsEntry(e);
    if (!passes) continue;
    if (tokens.length > 0 && !tokens.every((t) => searchableText(f.node).toLowerCase().includes(t))) continue;
    out.push(f);
  }
  return out;
}

/** Compact per-row timestamp: HH:MM today, M/D HH:MM this year, else yy/M/D. */
export function formatEntryTime(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return `${String(d.getFullYear()).slice(-2)}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
