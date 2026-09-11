/**
 * Classification of a remote CONNECT failure (as opposed to a path error, see
 * sftp-errors.ts).
 *
 * The distinction drives two very different behaviors:
 *  - AUTH failure  → the user must supply a password: the sidebar dot flips to
 *    "需要登录" and the login dialog opens. Retrying on a timer is pointless
 *    until a credential changes, so the cooling-off period is long.
 *  - TRANSPORT failure (unreachable host, refused port, timeout, dead router)
 *    → retrying is worth it soon, but NOT from every caller at once.
 *
 * Both cases feed the SFTP circuit breaker in index.ts. Without it, one broken
 * server was retried by every session-hydration batch, the 4s title poll and
 * the 6s tree poll, each attempt paying a full TCP + auth round trip — a
 * connect storm that made the whole app (and the machine) crawl while the UI
 * said "正在加载…".
 */

/** True when ssh2 says every credential we offered was rejected. */
export function isSshAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const level = (error as { level?: unknown }).level;
  if (level === "client-authentication") return true;
  const message = error instanceof Error ? error.message : "";
  // ssh2-sftp-client rewraps the error as "<method>: <message>" and keeps the
  // text; only match phrasings that are unambiguous about authentication.
  return /all configured authentication methods failed|permission denied|authentication failed|auth fail|no supported authentication|failed to connect to agent|agent unavailable|agent not found/i.test(message);
}

/** True when the failure means "the path does not exist" — never an auth or
 *  transport problem, so it must not open the breaker. */
export function isSftpPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === 2 || code === "2" || code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : "";
  return /(^|:\s*)No such file(\b|$)/i.test(message);
}

/** One-line reason for a failed remote connect, safe to show in the sidebar. */
export function describeConnectFailure(error: unknown): string {
  if (!error) return "连接失败";
  const message = error instanceof Error ? error.message : String(error);
  if (isSshAuthError(error)) return "认证失败：需要密码或密钥未授权";
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) return "连接超时（服务器无响应）";
  if (/ECONNREFUSED/i.test(message)) return "端口拒绝连接";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "无法解析主机名";
  if (/ECONNRESET|EPIPE|socket hang up/i.test(message)) return "连接被重置";
  // ssh2-sftp-client prefixes "<method>: " — drop it, the caller says enough.
  return message.replace(/^[a-z]+:\s*/i, "").slice(0, 160) || "连接失败";
}
