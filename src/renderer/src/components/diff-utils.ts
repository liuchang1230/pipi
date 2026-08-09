/** Pure diff helpers shared by DiffView, tool cards and the changes panel. */

export function isDiffish(text: string): boolean {
  return text.startsWith("diff --git") || /^[+-]{3} \S/m.test(text) || /^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(text);
}

/**
 * Build a synthetic unified diff for edit-tool args (oldText → newText pairs),
 * so tool cards can show a diff before/without a result.
 */
export function editsToDiff(path: string | undefined, edits: Array<{ oldText: string; newText: string }>): string {
  if (!edits.length) return "";
  const p = path ?? "file";
  const parts: string[] = [`--- a/${p}`, `+++ b/${p}`];
  for (const e of edits) {
    const oldLines = e.oldText.split("\n");
    const newLines = e.newText.split("\n");
    if (oldLines[oldLines.length - 1] === "") oldLines.pop();
    if (newLines[newLines.length - 1] === "") newLines.pop();
    parts.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
    for (const l of oldLines) parts.push(`-${l}`);
    for (const l of newLines) parts.push(`+${l}`);
  }
  return parts.join("\n");
}
