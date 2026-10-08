/**
 * Every environment variable the app hands to a pi process, in one place.
 *
 * These used to be spread at each spawn site individually, which made "did the
 * new feature reach all nine paths?" a grep-and-hope question — and a missed
 * site fails SILENTLY (the feature just never activates; nothing errors).
 * Both delivery forms live here so adding a feature means editing one file:
 *
 *   piEnv()         env object for a directly spawned child (local pty, local
 *                   `pi --mode rpc` child, in-process SDK worker thread)
 *   piShellPrefix() shell prefix for WSL / SSH, where no env crosses the
 *                   boundary and the values must be exported in front of the
 *                   command (see approvalShellPrefix for the quoting rules)
 *
 * One feature is left: the approval policy. The sub-agent model pin used to ride
 * here too (PI_MODEL/PI_PROVIDER, which only the retired hand-written delegation
 * engine ever read); it now lives in pi's own settings.json, where the official
 * `pi-subagents` package resolves it (ADR 0013, see pi-settings.ts).
 */
import { approvalEnv, approvalShellPrefix } from "./approval-env";

/** Spread into a directly spawned pi child's env.
 *  NEVER into the app's own `process.env` — that would leak into unrelated children. */
export function piEnv(): Record<string, string> {
  return { ...approvalEnv() };
}

/** Prefix a WSL/SSH command string so the far-side pi sees the same values. */
export function piShellPrefix(): string {
  return approvalShellPrefix();
}
