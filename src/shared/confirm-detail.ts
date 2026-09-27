/**
 * confirm-detail.ts — how a confirmation dialog tells the user WHAT is about to
 * happen.
 *
 * A `ctx.ui.confirm(...)` request from any pi extension arrives as one string.
 * Extensions that care can split it into a plain-language headline (what the AI
 * wants to do) plus a literal marker followed by the raw detail to verify:
 *
 *   <一句人话：AI 想做什么>
 *
 *   详情（供核对）:
 *   <原始命令 / 改动前后，等宽字体，供核对>
 *
 * `splitConfirmMessage` is the seam: the headline gets the purpose-first
 * layout, the detail goes into a monospace block. A message written by a
 * foreign extension without the marker is returned verbatim as the headline,
 * so nothing is lost and nothing is invented.
 *
 * The app no longer ships any extension that requests confirmation (the
 * plan/edit modes were removed — the app is vanilla pi now), so this module
 * today only formats requests coming from user-installed extensions.
 */

/** Literal marker separating the plain sentence from the raw detail. */
export const CONFIRM_DETAIL_MARKER = "详情（供核对）";

export interface ConfirmMessageParts {
  /** The plain-language sentence (always present, never empty). */
  headline: string;
  /** The raw command / diff to verify, when the sender provided one. */
  detail?: string;
}

/**
 * Split a confirmation message into its human sentence and its raw detail.
 *
 * Only a message that actually carries the marker is split — a confirm from any
 * other extension is one paragraph of prose and must not be reformatted.
 */
export function splitConfirmMessage(message: string): ConfirmMessageParts {
  const text = (message ?? "").trim();
  if (!text) return { headline: "" };
  const markerAt = text.indexOf(CONFIRM_DETAIL_MARKER);
  if (markerAt < 0) return { headline: text };
  const headline = text.slice(0, markerAt).trim().replace(/[：:]\s*$/, "");
  const rest = text.slice(markerAt + CONFIRM_DETAIL_MARKER.length);
  const detail = rest.replace(/^[：:]\s*/, "").trim();
  return detail ? { headline, detail } : { headline };
}
