/**
 * App settings persisted to userData/settings.json.
 *
 * Currently holds auto-follow preferences for the right-panel viewer.
 * Keep this module self-contained: read → merge defaults → write.
 */
import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonRecoverable, writeJsonAtomic } from "./json-store";

export interface AutoFollowSettings {
  enabled: boolean;
  followReads: boolean;
}

/** Model used by delegated subagents (analyst / reviewer / scout). Absent =
 *  the subagent inherits the main session's model. Purely an app-side launch
 *  default: it is injected as PI_PROVIDER/PI_MODEL into every pi process the
 *  app spawns, which is exactly what the agent extensions read. */
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
}

const DEFAULTS: AppSettings = {
  autoFollow: { enabled: true, followReads: true },
};

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function cloneDefaults(): AppSettings {
  return { autoFollow: { ...DEFAULTS.autoFollow } };
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
  };
  writeJsonAtomic(settingsPath(), next);
  return next;
}
