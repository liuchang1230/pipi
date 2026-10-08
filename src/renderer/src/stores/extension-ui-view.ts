// extension-ui-view: what the user actually sees of pi's extension UI surface.
//
// Pure functions, so the decisions are testable without a DOM (this repo has no
// render-test harness — the renderer's tests are pure modules and stores).
// Four decisions live here:
//   - 扩展文本先剥 ANSI 再上屏（它们按 TUI 写，`theme.fg` 给的是带 SGR 的字符
//     串，DOM 不解释转义——用户看到的就是 `[38;5;241m◆ [39m[38;5;244m3
//     checkpoints[39m`，见 shared/ansi.ts）；
//   - a widget is PLAIN TEXT lines (pi's TUI wraps them in Text components, it
//     does not parse markdown), and only the first WIDGET_LINE_CAP are drawn
//     until the user expands it. pi truncates too ("... (widget truncated)") but
//     throws the rest away; we keep them behind a control;
//   - a status declared with empty text is not drawn (extensions clear a status
//     by setting ""), but it is still declared;
//   - order is the extension's declaration order, never sorted: the extension
//     put the context counter before the queue depth on purpose.
import { WIDGET_LINE_CAP, type ExtensionUiSurface, type ExtensionUiWidget, type WidgetPlacement } from "../../../shared/extension-ui";
import { stripAnsi } from "../../../shared/ansi";

export interface StatusEntry {
  key: string;
  /** Text to draw (may be clipped) — `title` in the DOM carries `full`. */
  text: string;
  full: string;
}

export interface WidgetView {
  key: string;
  /** Lines drawn while collapsed (at most `cap`). */
  lines: string[];
  /** Lines behind the expand control (at most `WIDGET_REST_MAX`). */
  rest: string[];
  /** Lines beyond `cap + WIDGET_REST_MAX`, never rendered. A widget arrives
   *  from an extension, i.e. from code we did not write: keeping every declared
   *  line in the DOM turns one bad loop into thousands of nodes. Non-zero is
   *  reported in the zone so the truncation is visible, not silent. */
  hidden: number;
}

/** Longest a single status text may be before the row clips it. */
export const STATUS_TEXT_MAX = 80;

/** How many over-cap lines stay reachable behind the expand control. */
export const WIDGET_REST_MAX = 200;

export function statusEntries(surface: ExtensionUiSurface): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const [key, raw] of Object.entries(surface.status)) {
    // 扩展是按 TUI 写的：`theme.fg("dim", …)` 给出的是带 SGR 的字符串，DOM 不
    // 解释转义，原样上屏就是那串 `[38;5;241m…[39m`。剥完再判空（一个纯 ANSI
    // 的 status 就是「声明了但为空」，不该画）。
    const full = stripAnsi(raw).replace(/\s+/g, " ").trim();
    if (!full) continue;
    out.push({ key, text: full.length > STATUS_TEXT_MAX ? `${full.slice(0, STATUS_TEXT_MAX - 1)}…` : full, full });
  }
  return out;
}

export function widgetViews(surface: ExtensionUiSurface, placement: WidgetPlacement): WidgetView[] {
  const out: WidgetView[] = [];
  for (const [key, widget] of Object.entries(surface.widgets)) {
    // Placement may be absent (upstream's argument is optional) — same default
    // pi applies: aboveEditor.
    if ((widget.placement ?? "aboveEditor") !== placement) continue;
    const view = widgetView(key, widget);
    if (view) out.push(view);
  }
  return out;
}

/** null when the widget has no lines at all: an empty array means "declared but
 *  empty", which draws nothing (pi renders an empty container). Lines keep their
 *  count (a widget's line numbers matter) but lose ANSI codes — see stripAnsi. */
export function widgetView(key: string, widget: ExtensionUiWidget, cap: number = WIDGET_LINE_CAP): WidgetView | null {
  if (widget.lines.length === 0) return null;
  const lines = widget.lines.map(stripAnsi);
  return {
    key,
    lines: lines.slice(0, cap),
    rest: lines.slice(cap, cap + WIDGET_REST_MAX),
    hidden: Math.max(0, lines.length - cap - WIDGET_REST_MAX),
  };
}

/** The extension's title, or null when it declared none (empty = none). */
export function titleOf(surface: ExtensionUiSurface): string | null {
  const title = stripAnsi(surface.title).trim();
  return title ? title : null;
}

export type EditorTextAction = { kind: "fill"; text: string } | { kind: "hint"; text: string };

/** What to do with an extension's `set_editor_text`.
 *
 * Same contract as `chatStore.restoreInput`: an empty composer is filled, a
 * composer holding a draft is never overwritten — the text waits behind a
 * clickable hint instead. One input box, one contract. `null` = the extension
 * offered nothing (pi may send `set_editor_text` with no text), so nothing is
 * drawn: an empty hint bar would look like a bug. */
export function editorTextAction(currentInput: string, text: string | undefined): EditorTextAction | null {
  if (!text) return null;
  return currentInput.trim() ? { kind: "hint", text } : { kind: "fill", text };
}
