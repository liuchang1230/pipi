/**
 * ssh2-sftp-client error classification.
 *
 * The client wraps every failure as `new Error("<method>: <message>")` and
 * copies `err.code` onto it (`src/utils.js` errorListener / `fmtError`).
 * A missing path arrives as SFTP status 2 (`SSH_FX_NO_SUCH_FILE`, surfaced by
 * ssh2 as the numeric code 2) with the message "No such file".
 *
 * "The directory does not exist" is ROUTINE, not a failure: a session dir is
 * created lazily by pi on first use, so a project pi has never run in reports
 * ENOENT. The LOCAL session index already treats a missing dir as an empty
 * list (`session-index.ts`), and remote paths must match that — otherwise the
 * sidebar shows "远程会话加载失败：list: No such file" for a project that
 * simply has no sessions yet.
 */

/** True when an SFTP error means "that path does not exist" (ENOENT). */
export function isSftpMissingPathError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const code = (error as { code?: unknown }).code;
  // ssh2 surfaces SSH_FX_NO_SUCH_FILE as the SFTP status number 2. Some code
  // paths hand us the string form or the client's ENOENT alias.
  if (code === 2 || code === "2" || code === "ENOENT") return true;
  if (typeof code === "string" && /NO_SUCH_FILE/i.test(code)) return true;
  // Message-only fallback for real error objects (ssh2's text for status 2),
  // kept narrow so a network/permission error containing the same words is
  // not swallowed. Plain strings are NOT inspected: a caller passing a raw
  // string gets the benefit of the doubt and the error stays visible.
  const message = error instanceof Error ? error.message : undefined;
  if (message === undefined) return false;
  return /(^|:\s*)No such file(\b|$)/i.test(message);
}
