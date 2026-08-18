/**
 * App settings persisted to userData/settings.json.
 *
 * Currently holds auto-follow preferences for the right-panel viewer.
 * Keep this module self-contained: read → merge defaults → write.
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AutoFollowSettings {
  enabled: boolean;
  followReads: boolean;
}

export interface AppSettings {
  autoFollow: AutoFollowSettings;
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
  const file = settingsPath();
  if (!existsSync(file)) return cloneDefaults();
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const r = raw as Partial<AppSettings> | null;
    const af = r?.autoFollow;
    return {
      autoFollow: {
        enabled: typeof af?.enabled === "boolean" ? af.enabled : DEFAULTS.autoFollow.enabled,
        followReads: typeof af?.followReads === "boolean" ? af.followReads : DEFAULTS.autoFollow.followReads,
      },
    };
  } catch {
    return cloneDefaults();
  }
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
  };
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}
