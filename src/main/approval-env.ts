/**
 * Approval-gate launch env.
 *
 * The gate is an extension (src/main/extensions/pipi-approval-gate.ts) that pi
 * loads, and it has no settings file of its own — so the app hands it its
 * policy through the process environment, exactly the way subagent-model.ts
 * does, and for the same two reasons: a directly spawned child gets real env
 * vars, while a WSL distro or a remote host can only be reached by exporting
 * them in front of the command string.
 *
 * ABSENT env means OFF (see the extension): the same file is also deployed to
 * the user's own agent dir, where the plain `pi` CLI loads it. A CLI user must
 * never get dialogs they did not ask for, so "the app is not driving this
 * process" has to read as off. The price is that a missed injection would
 * silently disable the gate — hence the completeness test in
 * src/main/__tests__/approval-gate.test.ts, which scans the sources and fails
 * if any spawn site bypasses the combiner in pi-env.ts.
 */
import {
  APPROVAL_POLICY_ENV,
  APPROVAL_TIMEOUT_ENV,
  DEFAULT_APPROVAL_TIMEOUT_SECONDS,
} from "../shared/approval";
import { getSettings, type ApprovalSettings } from "./settings";

/** The configured policy, or "off" when settings cannot be read. Mirrors the
 *  extension's own fallback: a process we cannot describe is a process we must
 *  not interrogate. */
export function getApprovalSettings(): ApprovalSettings {
  try {
    return getSettings().approval;
  } catch {
    return { policy: "off", timeoutSeconds: DEFAULT_APPROVAL_TIMEOUT_SECONDS };
  }
}

/** Env vars for a directly spawned pi process. Spread into the child's env —
 *  never into the app's `process.env`, which would leak into unrelated children. */
export function approvalEnv(): Record<string, string> {
  return approvalEnvFor(getApprovalSettings());
}

/** Pure form of {@link approvalEnv} (exported for tests).
 *
 *  Injected even when the policy is "off". Saying so explicitly is what keeps a
 *  stale variable inherited from a parent process from re-enabling the gate. */
export function approvalEnvFor(settings: ApprovalSettings): Record<string, string> {
  return {
    [APPROVAL_POLICY_ENV]: settings.policy,
    [APPROVAL_TIMEOUT_ENV]: String(Math.round(settings.timeoutSeconds * 1000)),
  };
}

/** Prefix for a WSL/SSH shell command string (see subagentShellPrefix). */
export function approvalShellPrefix(): string {
  return approvalShellPrefixFor(getApprovalSettings());
}

/**
 * Pure form of {@link approvalShellPrefix} (exported for tests).
 *
 * Unlike subagentShellPrefixFor this does NOT base64-encode: both values come
 * from a closed charset (the policy is one of three bare words, the timeout is
 * digits), so the result contains no single quote that could terminate the
 * outer `bash -ic '<cmd>'` wrap. A test asserts that.
 */
export function approvalShellPrefixFor(settings: ApprovalSettings): string {
  return Object.entries(approvalEnvFor(settings))
    .map(([key, value]) => `export ${key}=${value}; `)
    .join("");
}
