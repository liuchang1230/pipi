/**
 * confirm-detail.ts — how a confirmation dialog tells the user WHAT is about to
 * happen.
 *
 * The user's report: 「edit 请求编辑的时候，提供的是一堆代码命令，看不懂，请求的时候，
 * 可不可以告诉用户要做什么？通俗一点」. The dialog was printing the extension's
 * message verbatim: for edit mode that message is a shell command or a
 * path + first replaced line, i.e. exactly the pile of code they could not read.
 *
 * The fix is a two-part message, and this module is the seam that keeps both
 * halves honest:
 *
 *   <一句人话：AI 想做什么>
 *
 *   详情（供核对）:
 *   <原始命令 / 改动前后，等宽字体，供核对>
 *
 * The extension (src/main/extensions/pipi-mode-switch.ts, which pi loads as a
 * standalone file and therefore cannot import from here) writes the literal
 * marker; `CONFIRM_DETAIL_MARKER` must match it — a test reads that file and
 * fails if the two ever drift. Everything else about the message stays free
 * prose, so a foreign extension's confirm is rendered verbatim as before.
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
