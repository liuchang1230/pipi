/** Pure diff helpers shared by DiffView, tool cards and the changes panel. */

export function isDiffish(text: string): boolean {
  return text.startsWith("diff --git") || /^[+-]{3} \S/m.test(text) || /^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(text);
}

/** One `edits[]` entry: the exact text replaced and its replacement. */
export interface EditPair {
  oldText: string;
  newText: string;
}

/** A normalized `edit` tool call: target path (when known) + usable pairs. */
export interface EditArgs {
  path?: string;
  edits: EditPair[];
}

/**
 * Read an `edits` argument as a list of objects.
 *
 * Model-authored arguments are NOT trustworthy: an edit call can fail pi's
 * validation (`edits.0.oldText: must have required properties oldText`) and
 * still be persisted in the session file, so transcript hydration replays
 * malformed arguments verbatim (real case: `{"edits":[{"newText":"…"}]}`).
 * Every consumer therefore degrades instead of throwing — a throw inside a
 * render pass would blank the whole window (R1 white screen).
 *
 * Accepts what pi accepts: an array, a single entry object, or a JSON string
 * holding either.
 */
function toEditObjects(value: unknown): Record<string, unknown>[] {
  let v: unknown = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) v = [v];
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e));
}

function pairsOf(entries: Record<string, unknown>[]): EditPair[] {
  const out: EditPair[] = [];
  for (const e of entries) {
    // Empty oldText is rejected by pi (never applied, only ever a failed call),
    // and main's edit history would splice it in at the file start.
    if (typeof e.oldText === "string" && e.oldText.length > 0 && typeof e.newText === "string") {
      out.push({ oldText: e.oldText, newText: e.newText });
    }
  }
  return out;
}

/** The usable oldText/newText pairs of an `edits` argument; malformed entries drop out. */
export function normalizeEdits(value: unknown): EditPair[] {
  return pairsOf(toEditObjects(value));
}

/**
 * Normalize a whole `edit` tool call's arguments. Also understands pi's legacy
 * single-edit shorthand `{ path, oldText, newText }` and per-entry `path`.
 */
export function parseEditArgs(args: unknown): EditArgs {
  const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const entries = toEditObjects(a.edits);
  const edits = pairsOf(entries);
  if (typeof a.oldText === "string" && a.oldText.length > 0 && typeof a.newText === "string") {
    edits.push({ oldText: a.oldText, newText: a.newText });
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const path = str(a.path) ?? str(a.filePath) ?? entries.map((e) => e.path).find((p): p is string => !!str(p));
  return { path, edits };
}

/**
 * Build a synthetic unified diff for edit-tool args (oldText → newText pairs),
 * so tool cards can show a diff before/without a result.
 */
export function editsToDiff(path: unknown, edits: unknown): string {
  const pairs = normalizeEdits(edits);
  if (!pairs.length) return "";
  const p = typeof path === "string" && path ? path : "file";
  const parts: string[] = [`--- a/${p}`, `+++ b/${p}`];
  for (const e of pairs) {
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
