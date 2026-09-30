/**
 * Approval-gate vocabulary shared by main (settings + env injection), the
 * renderer (settings UI) and the extension that actually asks.
 *
 * The extension CANNOT import this module: it is copied verbatim into
 * ~/.pi/agent/extensions/ and runs inside pi, which has no access to app code.
 * It therefore carries its own copy of the env var names, and
 * src/main/__tests__/approval-gate.test.ts asserts the two agree — so renaming
 * a constant here can never silently turn the gate off (fail-open).
 */

/** What the gate does. "destructive" is the default: only irreversible
 *  operations cost a question. */
export type ApprovalPolicy = "off" | "destructive" | "all";

export const APPROVAL_POLICY_ENV = "PIPI_APPROVAL_POLICY";
export const APPROVAL_TIMEOUT_ENV = "PIPI_APPROVAL_TIMEOUT_MS";

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "destructive";
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 120;
export const MIN_APPROVAL_TIMEOUT_SECONDS = 10;
export const MAX_APPROVAL_TIMEOUT_SECONDS = 3600;

export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["off", "destructive", "all"];

/** The app-side approval settings: stored in settings.json, sent over IPC, and
 *  projected into the environment the extension reads. */
export interface ApprovalSettings {
  policy: ApprovalPolicy;
  /** Seconds an unanswered prompt waits before it counts as a denial. */
  timeoutSeconds: number;
}

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  policy: DEFAULT_APPROVAL_POLICY,
  timeoutSeconds: DEFAULT_APPROVAL_TIMEOUT_SECONDS,
};

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicy, string> = {
  off: "关闭（不询问）",
  destructive: "只在不可逆操作前询问",
  all: "每次执行命令/改文件前都询问",
};

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return value === "off" || value === "destructive" || value === "all";
}

/**
 * Coerce anything (settings file, IPC payload, env var) to a usable policy.
 *
 * `fallback` is a parameter because the same garbage means opposite things in
 * the two places it is read: a corrupt value in settings.json must mean "the
 * default", while a corrupt value in the ENVIRONMENT must mean "off" (the app
 * is not driving this process, so it must not pop dialogs at a CLI user).
 */
export function normalizeApprovalPolicy(value: unknown, fallback: ApprovalPolicy): ApprovalPolicy {
  if (typeof value !== "string") return fallback;
  const s = value.trim().toLowerCase();
  return isApprovalPolicy(s) ? s : fallback;
}

/** Clamp to [MIN, MAX] seconds; anything unusable → `fallback`. */
export function normalizeApprovalTimeoutSeconds(
  value: unknown,
  fallback = DEFAULT_APPROVAL_TIMEOUT_SECONDS,
): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(MAX_APPROVAL_TIMEOUT_SECONDS, Math.max(MIN_APPROVAL_TIMEOUT_SECONDS, Math.round(n)));
  return clamped;
}
