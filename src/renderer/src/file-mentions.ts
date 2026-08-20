export interface FileMention {
  /** Relative to the chat session's working directory, always POSIX-style. */
  path: string;
  type: "file" | "directory";
}

export interface FileMentionToken {
  start: number;
  end: number;
  query: string;
}

/** The active @token at the editor caret. Supports Pi-compatible @"paths with spaces". */
export function fileMentionTokenAt(value: string, caret: number): FileMentionToken | null {
  const before = value.slice(0, caret);
  // The token must end at the caret. Without this anchor, a completed
  // `@file ` earlier in the message keeps reopening completion while typing
  // ordinary text after it.
  const match = /(^|\s)@(?:("([^"\n]*)$)|([^\s@]*))$/.exec(before);
  if (!match) return null;
  const raw = match[2] ?? match[4] ?? "";
  const query = match[3] ?? match[4] ?? "";
  return { start: caret - raw.length - 1, end: caret, query };
}

export function replaceFileMention(value: string, token: FileMentionToken, path: string): string {
  const escaped = path.includes(" ") ? `@"${path}"` : `@${path}`;
  return `${value.slice(0, token.start)}${escaped}${value.slice(token.end)} `;
}

/** Mention tokens eligible for attachment expansion on send. */
export function fileMentionPaths(value: string): string[] {
  const paths = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@(?:"([^"\n]+)"|([^\s@]+))/g)) {
    const path = match[2] ?? match[3];
    if (path && !path.includes("@")) paths.add(path);
  }
  return [...paths];
}

export function filterFileMentions(items: FileMention[], query: string): FileMention[] {
  const needle = query.toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.path.toLowerCase().includes(needle));
}
