/**
 * Compact one-line summaries for collapsed tool cards in the chat view.
 *
 * Goal: the collapsed head row itself answers "what did this tool do and how
 * did it end" (command / path / diffstat + ✓ duration · lines / ✗ exit code)
 * so users don't need to expand every card; failures auto-expand instead.
 *
 * Pure functions — no React, no store access — so they are unit-testable.
 */
import { editsToDiff, isDiffish } from "./diff-utils";

export interface ToolSummary {
  /** Main object of the call: command, file path, task text… */
  object?: string;
  /** Dim directory prefix of a path-style object. */
  objectDir?: string;
  /** Size-ish display for the object: "743 行" (read), "36 行" (write). */
  size?: string;
  /** Diffstat for edit/patch tools. */
  stat?: { adds: number; dels: number };
  /** Wall duration parsed from the result text (when the tool prints one). */
  durationMs?: number;
  /** Process exit code for bash-like tools. */
  exitCode?: number;
  /** Non-empty output line count of the result. */
  lines?: number;
  /** True → the UI should auto-expand the result area (errors, failed bash). */
  alert: boolean;
}

/** Collapse all whitespace and truncate with an ellipsis. */
export function clampLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Split a path into a dim directory prefix and the visible base name. */
export function prettyPath(p?: string): { dir?: string; base: string } | null {
  if (!p) return null;
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return { base: p };
  return { dir: p.slice(0, i + 1), base: p.slice(i + 1) || p };
}

/** "+24 −8" style diffstat from a unified/synthetic diff. */
export function diffStat(diff: string): { adds: number; dels: number } | null {
  if (!diff) return null;
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return adds || dels ? { adds, dels } : null;
}

/** "850ms" / "3.2s" / "3m 40s" for display. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Extract exit code / duration / output size from a bash-like result text.
 *
 * Ground truth from pi's bash tool (verified in pi 0.85.1 bundle):
 * - success → plain stdout, NO exit code and NO duration in the text;
 * - non-zero exit → tool throws, result text = output + "Command exited with code N";
 * - timeout → "Command timed out after N seconds"; abort → "Command aborted".
 * So duration is only parsed from the timeout line — never from arbitrary
 * command output (which may contain unrelated "in 2.5s" strings).
 */
export function parseBashResult(text: string): {
  exitCode?: number;
  durationMs?: number;
  lines?: number;
  timedOut?: boolean;
} {
  const out: { exitCode?: number; durationMs?: number; lines?: number; timedOut?: boolean } = {};
  const exit = text.match(/\b(?:exit(?:\s+code)?[:=]?|exited with code)\s*(\d+)/i);
  if (exit) out.exitCode = Number(exit[1]);
  const timeout = text.match(/\bCommand timed out after (\d+(?:\.\d+)?) seconds/i);
  if (timeout) {
    out.timedOut = true;
    out.durationMs = Number(timeout[1]) * 1000;
  }
  const lines = text.split("\n").filter((l) => l.trim()).length;
  if (lines > 0) out.lines = lines;
  return out;
}

function safeArgs(argsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsText || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Build the head-row summary for a tool call.
 * `resultText` is the display text already extracted by chatStore (diff-aware).
 */
export function summarizeTool(
  name: string | undefined,
  argsText: string,
  resultText: string,
  isError: boolean | undefined,
): ToolSummary | null {
  const args = safeArgs(argsText);
  const hasResult = resultText.trim().length > 0;

  if (name === "bash") {
    const command = str(args.command);
    const r = hasResult ? parseBashResult(resultText) : {};
    const failed = isError || r.timedOut || (r.exitCode !== undefined && r.exitCode !== 0);
    return {
      object: command,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      lines: r.lines,
      alert: !!failed,
    };
  }

  if (name === "edit") {
    const path = str(args.path);
    const pp = prettyPath(path);
    let stat: ToolSummary["stat"] | undefined;
    const edits = args.edits;
    if (Array.isArray(edits) && edits.length) {
      stat =
        diffStat(editsToDiff(path, edits as Array<{ oldText: string; newText: string }>)) ?? undefined;
    }
    if (!stat && hasResult) stat = diffStat(resultText) ?? undefined;
    return { object: pp?.base, objectDir: pp?.dir, stat, alert: !!isError };
  }

  if (name === "apply_patch" || name === "patch") {
    const patch = str(args.patch);
    const stat = (patch && diffStat(patch)) || (hasResult ? diffStat(resultText) : null) || undefined;
    return { object: "补丁", stat, alert: !!isError };
  }

  if (name === "read") {
    const pp = prettyPath(str(args.path));
    const lines = hasResult ? resultText.split("\n").filter((l) => l.trim()).length : undefined;
    return {
      object: pp?.base,
      objectDir: pp?.dir,
      size: lines ? `${lines} 行` : undefined,
      alert: !!isError,
    };
  }

  if (name === "write" || name === "write_file") {
    const pp = prettyPath(str(args.file_path) ?? str(args.path));
    const content = str(args.content);
    // "a\nb\n" is 2 physical lines, not 3.
    const contentLines = content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : undefined;
    return {
      object: pp?.base,
      objectDir: pp?.dir,
      size: contentLines !== undefined ? `${contentLines} 行` : undefined,
      alert: !!isError,
    };
  }

  // Generic: scout/analyst/reviewer/grep/find… show the primary intent arg.
  const intent = str(args.task) ?? str(args.prompt) ?? str(args.query) ?? str(args.pattern) ?? str(args.url) ?? str(args.path);
  const lines = hasResult ? resultText.split("\n").filter((l) => l.trim()).length : undefined;
  if (!intent && !lines && !isError && !hasResult) return null;
  return {
    object: intent ? clampLine(intent, 120) : undefined,
    lines,
    alert: !!isError,
  };
}
