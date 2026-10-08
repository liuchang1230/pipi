/**
 * App settings persisted to userData/settings.json.
 *
 * Holds auto-follow preferences for the right-panel viewer and the approval
 * gate that decides which tool calls have to be confirmed (docs/adr/0003).
 * Keep this module self-contained: read → merge defaults → write.
 */
import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalSettings } from "../shared/approval";
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_APPROVAL_SETTINGS,
  normalizeApprovalPolicy,
  normalizeApprovalTimeoutSeconds,
} from "../shared/approval";
import { normalizePackageMirror, type PackageMirrorSettings } from "../shared/package-mirror";

/** The configured sub-agent model pin, or null to follow the session's model.
 *  Lives here rather than in pi-settings.ts so that module (whose pure parts are
 *  unit-tested) stays free of electron. */
export function getSubagentModelSetting(): SubagentModelSettings | null {
  try {
    return getSettings().subagents ?? null;
  } catch {
    // Reading settings must NEVER block a spawn or a startup step (app not
    // ready, unreadable settings.json, …). Fall back to "follow the session".
    return null;
  }
}

// The shape lives in src/shared/approval.ts so preload + renderer can name it
// without importing this module (which pulls in electron `app`).
export type { ApprovalSettings };
import { readJsonRecoverable, writeJsonAtomic } from "./json-store";

export interface AutoFollowSettings {
  enabled: boolean;
  followReads: boolean;
}

/** Model used by delegated subagents (analyst / reviewer / scout). Absent =
 *  the subagent inherits the main session's model. Written into pi's OWN
 *  settings.json as `subagents.agentOverrides.<role>.model`, which is where the
 *  official `pi-subagents` package resolves a child's model (ADR 0013 — it never
 *  read PI_PROVIDER/PI_MODEL, the retired hand-written engine's contract). */
export interface SubagentModelSettings {
  provider?: string;
  model: string;
}

export interface AppSettings {
  autoFollow: AutoFollowSettings;
  /** null/absent = follow the main agent's model. */
  subagents?: SubagentModelSettings | null;
  onboarding?: { seenAt?: number; completedAt?: number };
  /** Backend selection for local pi tabs: "rpc" forces the old child-process
   *  backend; unset/undefined uses the in-process SDK worker. */
  pipi?: { backend?: "rpc" };
  /** Ask before irreversible tool calls (docs/adr/0003-approval-gate.md).
   *  Absent in an old settings.json → the default policy, deliberately: the
   *  gate is the feature, so "unknown" must not mean "off". */
  approval: ApprovalSettings;
  /** Mirror the user's locally-installed pi extension packages onto
   *  remote/WSL targets. Absent = off (the ADR 0009 default, deliberately). */
  packageMirror?: PackageMirrorSettings;
}

const DEFAULTS: AppSettings = {
  autoFollow: { enabled: true, followReads: true },
  approval: { ...DEFAULT_APPROVAL_SETTINGS },
};

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function cloneDefaults(): AppSettings {
  return { autoFollow: { ...DEFAULTS.autoFollow }, approval: { ...DEFAULTS.approval } };
}

export function getSettings(): AppSettings {
  // A corrupt settings.json keeps its bytes as .corrupt-<ts> and blocks writes
  // (json-store) instead of being silently replaced by the defaults.
  const { value } = readJsonRecoverable<Partial<AppSettings>>(
    settingsPath(),
    {},
    (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<AppSettings>) : null),
  );
  const r = value;
  if (Object.keys(r).length === 0) return cloneDefaults();
  const af = r.autoFollow;
  return {
    ...r,
    autoFollow: {
      enabled: typeof af?.enabled === "boolean" ? af.enabled : DEFAULTS.autoFollow.enabled,
      followReads: typeof af?.followReads === "boolean" ? af.followReads : DEFAULTS.autoFollow.followReads,
    },
    subagents: normalizeSubagents(r.subagents),
    onboarding: r.onboarding,
    approval: normalizeApproval(r.approval),
    packageMirror: normalizePackageMirror(r.packageMirror),
  };
}

/** Keep only a usable policy + timeout; anything else means the default. */
function normalizeApproval(value: unknown): ApprovalSettings {
  const v = (value ?? {}) as { policy?: unknown; timeoutSeconds?: unknown };
  return {
    policy: normalizeApprovalPolicy(v.policy, DEFAULT_APPROVAL_POLICY),
    timeoutSeconds: normalizeApprovalTimeoutSeconds(v.timeoutSeconds),
  };
}

/** Keep only a usable {provider, model}; anything else means "follow main". */
function normalizeSubagents(value: unknown): SubagentModelSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { provider?: unknown; model?: unknown };
  const model = typeof v.model === "string" ? v.model.trim() : "";
  if (!model) return undefined;
  const provider = typeof v.provider === "string" ? v.provider.trim() : "";
  return provider ? { provider, model } : { model };
}

/** Merge a partial patch into persisted settings (unknown fields keep defaults). */
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const prev = getSettings();
  // Spread prev first so unknown top-level keys from newer versions survive.
  const next: AppSettings = {
    ...prev,
    ...patch,
    autoFollow: {
      enabled: typeof patch.autoFollow?.enabled === "boolean" ? patch.autoFollow.enabled : prev.autoFollow.enabled,
      followReads: typeof patch.autoFollow?.followReads === "boolean" ? patch.autoFollow.followReads : prev.autoFollow.followReads,
    },
    // null explicitly clears it (back to "follow the main model"); undefined
    // keeps the previous value. JSON.stringify then drops the key entirely.
    subagents: patch.subagents === undefined ? prev.subagents : (normalizeSubagents(patch.subagents) ?? undefined),
    onboarding: patch.onboarding ? { ...prev.onboarding, ...patch.onboarding } : prev.onboarding,
    // Merged field-by-field so a partial patch cannot silently reset the
    // timeout to a default the user never chose.
    approval: normalizeApproval({ ...prev.approval, ...(patch.approval ?? {}) }),
    packageMirror: normalizePackageMirror({ ...prev.packageMirror, ...(patch.packageMirror ?? {}) }),
  };
  writeJsonAtomic(settingsPath(), next);
  return next;
}
