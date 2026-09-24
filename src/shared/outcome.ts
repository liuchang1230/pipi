/**
 * outcome.ts — one error contract for the whole app.
 *
 * Before this, a failure could arrive three ways: a `{ok:false,error}` object,
 * a thrown Error, or — worst — as *content* (a placeholder tree row, or a
 * "⚠️ 读取失败" string handed back as a file's text). The user-visible result
 * was that the same failure sometimes showed a toast, sometimes a silent
 * placeholder, and sometimes nothing at all.
 *
 * An `AppError` carries what a person needs: a human title, the technical
 * cause, and what to do next. `Outcome<T>` makes "succeeded" and "failed"
 * mutually exclusive at the type level, so a caller cannot forget to check.
 *
 * Phase 2 scope: main and the renderer's task layer speak Outcome; the
 * `window.api` surface keeps its existing shapes (see
 * docs/robustness-plan.md §S3).
 */

export type ErrCode =
  | "timeout"
  | "offline"
  | "auth"
  | "notfound"
  | "permission"
  | "conflict"
  | "protocol"
  | "crashed"
  | "busy"
  | "cancelled"
  | "internal";

export interface AppErrorTarget {
  host?: string;
  path?: string;
  tabId?: string;
}

export interface AppError {
  code: ErrCode;
  /** First line, in the user's language: what happened. */
  title: string;
  /** Technical detail: searchable, copyable to a maintainer. */
  cause: string;
  /** What the user can do next. Absent only when there is genuinely nothing. */
  hint?: string;
  /** What it happened to (server / path / tab), for grouping and retry. */
  target?: AppErrorTarget;
  /** Whether retrying the same action could plausibly work. */
  retryable: boolean;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: AppError): Outcome<T> {
  return { ok: false, error };
}

/** What each class of failure means for the user, in one place. */
const HINTS: Record<ErrCode, string> = {
  timeout: "网络或服务器响应慢。可稍后重试；若总是超时，检查该服务器上的 pi 是否在正常运行。",
  offline: "检查服务器是否可达（网络/VPN/防火墙），以及 SSH 端口是否开放。",
  auth: "登录凭据可能已失效，请重新输入密码；或确认该账号允许密钥登录。",
  notfound: "文件或目录可能已被移动或删除，刷新后再试。",
  permission: "当前账号没有访问该路径的权限，可换一个目录或调整服务器上的权限。",
  conflict: "目标已存在，请换一个名称。",
  protocol: "对方返回了无法解析的数据（常见于 pi 版本与客户端不一致），可尝试对齐版本。",
  crashed: "相关进程已退出，可重连或重新打开该会话。",
  busy: "上一轮操作还没结束，稍候会自动继续。",
  cancelled: "",
  internal: "这是客户端内部错误，可复制诊断信息并反馈。",
};

export function makeError(
  code: ErrCode,
  title: string,
  cause: string,
  opts: { hint?: string; target?: AppErrorTarget; retryable?: boolean } = {},
): AppError {
  return {
    code,
    title,
    cause,
    // `hint: ""` means "nothing useful to say" (cancelled) — keep it absent.
    hint: opts.hint ?? HINTS[code] ?? undefined,
    target: opts.target,
    retryable: opts.retryable ?? (code !== "cancelled" && code !== "internal" && code !== "protocol"),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Classify an arbitrary thrown value. Deliberately message-driven: the values
 * reaching here come from ssh2, node:fs, the pi protocol and our own code, and
 * the honest signal is what they say — the numeric errno differs per platform.
 */
export function classifyError(error: unknown): ErrCode {
  const text = errorText(error).toLowerCase();
  const code = (error as { code?: unknown } | null)?.code;
  const errno = typeof code === "string" ? code.toLowerCase() : "";

  if (isDeadline(error) || errno === "etimedout" || text.includes("未响应")) return "timeout";
  if (errno === "eacces" || errno === "eperm" || text.includes("eacces") || text.includes("eperm")) return "permission";
  if (errno === "enoent" || text.includes("enoent") || text.includes("no such file") || text.includes("not found")) return "notfound";
  if (errno === "eexist" || text.includes("eexist") || text.includes("已存在")) return "conflict";
  if (
    text.includes("permission denied") ||
    text.includes("authentication") ||
    text.includes("auth fail") ||
    text.includes("凭据") ||
    text.includes("密码")
  ) {
    // "Permission denied (publickey)" is auth, not filesystem permission — the
    // errno check above already separated real EACCES/EPERM.
    return "auth";
  }
  if (
    errno === "econnrefused" ||
    errno === "econnreset" ||
    errno === "ehostunreach" ||
    errno === "enetunreach" ||
    text.includes("对端关闭") ||
    text.includes("连接已断开") ||
    text.includes("disconnect") ||
    text.includes("socket hang up") ||
    text.includes("econn")
  ) {
    return "offline";
  }
  if (text.includes("json") || text.includes("unexpected token") || text.includes("无法解析")) return "protocol";
  if (errno === "eisdir" || errno === "enotdir" || text.includes("eisdir") || text.includes("enotdir")) return "internal";
  return "internal";
}

function isDeadline(error: unknown): boolean {
  return error instanceof Error && (error.name === "DeadlineError" || error.constructor.name === "DeadlineError");
}

/**
 * Turn anything thrown into an AppError, preferring a code/classification over
 * a generic message. `title` is the caller's context ("读取远程文件失败"), since
 * "ECONNRESET" cannot tell the user which action failed.
 */
export function toAppError(
  error: unknown,
  context: { title: string; target?: AppErrorTarget; retryable?: boolean } = { title: "操作失败" },
): AppError {
  const code = classifyError(error);
  return makeError(code, context.title, errorText(error), { target: context.target, retryable: context.retryable });
}

/** One line for logs and diagnostics. */
export function describeAppError(error: AppError): string {
  const where = error.target ? ` [${[error.target.host, error.target.path].filter(Boolean).join(":")}]` : "";
  return `${error.code}: ${error.title} — ${error.cause}${where}`;
}
