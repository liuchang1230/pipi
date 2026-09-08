/** Compare only the SET of session files (paths), ignoring mtime drift.
 *  Consumers use this to decide "did the file set change" — mtime churn on
 *  an actively-written session must not re-emit / re-render the list.
 *  Structural minimum of a session entry — call sites pass full SessionEntry
 *  objects (typed as { path }-compatible), so no main-process import here:
 *  this module is shared with the renderer tsconfig project. */
export function sameSessionPaths(a: ReadonlyArray<{ path: string }>, b: ReadonlyArray<{ path: string }>): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a.map((s) => s.path));
  return b.every((s) => setA.has(s.path));
}
