/**
 * The keys the APP manages inside pi's OWN settings.json
 * (`<agentHome>/settings.json`) — and nothing else in that file.
 *
 * Two keys today, each covering one thing the app promises the user:
 *
 *   - `packages`: the official packages the app needs present. ADR 0013 retired
 *     the hand-written delegation extension and made `npm:pi-subagents` the
 *     runner for the shipped sub-agent briefs, so the app now guarantees that
 *     package instead of maintaining its own engine. pi's package manager
 *     installs a configured-but-missing package while it resolves settings at
 *     startup, so one entry here IS the mechanism — no installer spawn.
 *   - `subagents.agentOverrides.<role>.model`: the user's 「子代理模型」 pin.
 *     `pi-subagents` resolves a child's model as: per-run override →
 *     `agentOverrides.<name>.model` → the agent brief's frontmatter `model` →
 *     `subagents.defaultModel` → the parent session model — and it never looks
 *     at `PI_MODEL`/`PI_PROVIDER`. Those env vars were the RETIRED hand-written
 *     engine's contract; injecting them (and shipping an extension that kept
 *     them in sync) is what this module replaced.
 *
 * Why one module for both: they are the same operation on the same file, and
 * that file is mostly the user's. Every writer goes through {@link updatePiSettings}
 * — read recoverably → mutate exactly one key → atomic write — so no key of
 * theirs is ever dropped, an unparseable file is left alone (json-store moves the
 * bytes aside and blocks the write), and a repeat call is a no-op.
 *
 * Scope: the LOCAL agent home. WSL/remote homes have their own settings.json,
 * which the app does not ferry (ADR 0009) — `buildOfficialPackagesClause` covers
 * the package half on those machines via `pi install`; the sub-agent model pin
 * has no remote path yet (see ADR 0013).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { isWriteBlocked, readJsonRecoverable, writeJsonAtomic } from "./json-store";
import type { SubagentModelSettings } from "./settings";

/**
 * `npm:` sources pi install accepts verbatim. Kept as data so the local merge
 * and the remote install trailer cannot drift apart.
 */
export const OFFICIAL_AGENT_PACKAGES = ["npm:pi-subagents"] as const;

/** The sub-agent roles the 「子代理模型」 pin applies to. */
export const SUBAGENT_ROLES = ["analyst", "reviewer", "scout"] as const;

/** pi's own agent home. Mirrors theme-sync.agentDir(); kept local so this module
 *  does not pull in the pty/electron graph for its pure parts. `PI_CODING_AGENT_DIR`
 *  is pi's override for it. */
export function agentHomeDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read pi's settings.json, let `mutate` change a copy, write it back atomically
 * when it reports a change. Returns whether the file was written.
 *
 * The one place that touches this file, so the invariants hold for every key:
 * the user's other keys survive, a file we cannot parse is never overwritten
 * (json-store blocks the write and keeps the bytes), and a mutation that changes
 * nothing does not rewrite the file (no mtime churn, no `.bak` per startup).
 * Never throws: callers run on the startup path.
 */
export function updatePiSettings(
  agentHome: string,
  mutate: (settings: Record<string, unknown>) => { settings: Record<string, unknown>; changed: boolean },
): boolean {
  const file = join(agentHome, "settings.json");
  try {
    const { value } = readJsonRecoverable<Record<string, unknown>>(file, {});
    const { settings, changed } = mutate(value);
    if (!changed) return false;
    if (isWriteBlocked(file)) return false;
    writeJsonAtomic(file, settings);
    return true;
  } catch (error) {
    console.error(
      `[pi-settings] could not update ${file}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export interface PackageMerge {
  settings: Record<string, unknown>;
  /** Sources appended, in the order they were appended. Empty = no change. */
  added: string[];
}

/**
 * Pure: append `sources` to `settings.packages`, preserving every other key and
 * every entry already there (order included, duplicates included — the file is
 * the user's, and pi's loader tolerates a list it did not write).
 *
 * A `packages` value that exists but is not an array is left alone: we cannot
 * tell what the user meant by it, and clobbering it would lose their edit. The
 * caller then simply reports nothing added.
 */
export function mergePackageSources(
  settings: Record<string, unknown>,
  sources: readonly string[],
): PackageMerge {
  const packages = settings.packages;
  if (packages !== undefined && !Array.isArray(packages)) return { settings, added: [] };
  const current: unknown[] = packages ?? [];
  const added = sources.filter((source) => !current.includes(source));
  if (added.length === 0) return { settings, added: [] };
  return { settings: { ...settings, packages: [...current, ...added] }, added };
}

/**
 * Best-effort: make sure pi's settings.json lists every official package.
 * Returns the sources actually added (empty when the file already had them, when
 * it could not be parsed, or when `packages` holds something we do not own).
 * A missing settings.json is CREATED with just this key — the same posture
 * theme-sync takes for `theme`, and pi merges a partial file over its defaults.
 */
export function ensureOfficialPackages(agentHome = agentHomeDir()): string[] {
  let added: string[] = [];
  // Report `added` only when the file was really written: a blocked write (an
  // unparseable settings.json — json-store refuses and keeps the bytes) must not
  // claim the package is now configured.
  const written = updatePiSettings(agentHome, (settings) => {
    const merged = mergePackageSources(settings, OFFICIAL_AGENT_PACKAGES);
    added = merged.added;
    return { settings: merged.settings, changed: merged.added.length > 0 };
  });
  return written ? added : [];
}

/**
 * Pure: project the pin onto `subagents.agentOverrides.<role>.model`.
 *
 * Fully qualified `provider/model` wins exactly in the package's precedence, so
 * that is what is written when a provider is known; a bare id still resolves via
 * the registry. Everything else under `subagents` is preserved — `defaultModel`,
 * `agentOverrides.<other role>` (e.g. `oracle`), and other fields of the roles we
 * own (`thinking`, `defaultProvider`) — because the user may have written them.
 *
 * Clearing the pin removes exactly the three `model` fields we own and prunes the
 * containers that become empty, so an unpinned install looks untouched.
 */
export function mergeSubagentOverrides(
  settings: Record<string, unknown>,
  model: SubagentModelSettings | null,
): { settings: Record<string, unknown>; changed: boolean } {
  if (!isPlainObject(settings.subagents) && settings.subagents !== undefined) return { settings, changed: false };
  const subagents: Record<string, unknown> = { ...(settings.subagents as Record<string, unknown> | undefined) };
  if (!isPlainObject(subagents.agentOverrides) && subagents.agentOverrides !== undefined) return { settings, changed: false };
  const overrides: Record<string, unknown> = { ...(subagents.agentOverrides as Record<string, unknown> | undefined) };

  const wanted = model ? (model.provider ? `${model.provider}/${model.model}` : model.model) : null;
  let changed = false;
  for (const role of SUBAGENT_ROLES) {
    const existing = overrides[role];
    if (existing !== undefined && !isPlainObject(existing)) continue; // not ours to rewrite
    const roleSettings: Record<string, unknown> = { ...(existing as Record<string, unknown> | undefined) };
    if (wanted === null) {
      if (!("model" in roleSettings)) continue;
      delete roleSettings.model;
    } else {
      if (roleSettings.model === wanted) continue;
      roleSettings.model = wanted;
    }
    changed = true;
    if (Object.keys(roleSettings).length === 0) delete overrides[role];
    else overrides[role] = roleSettings;
  }
  if (!changed) return { settings, changed: false };

  if (Object.keys(overrides).length === 0) delete subagents.agentOverrides;
  else subagents.agentOverrides = overrides;
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(subagents).length === 0) delete next.subagents;
  else next.subagents = subagents;
  return { settings: next, changed: true };
}

/** Best-effort: write (or clear) the sub-agent model pin. Returns whether the
 *  file changed. The caller passes the app setting (`getSubagentModelSetting()`)
 *  so this module never imports electron for its pure parts. */
export function ensureSubagentModel(model: SubagentModelSettings | null, agentHome = agentHomeDir()): boolean {
  return updatePiSettings(agentHome, (settings) => mergeSubagentOverrides(settings, model));
}

/**
 * The remote/WSL half of the package guarantee: a shell clause for the existing
 * install trailer, so the official packages arrive on the same trip as the
 * content (no extra round trip) and can never fail that trip.
 *
 * `test -d` first: an already-installed package is left exactly as it is (no
 * network call on every reconnect, and no version chasing — the same posture the
 * user-package mirror takes). Silent: this runs inside another install's output.
 * `command -v pi` first: a machine that has no pi yet is a normal state, not an
 * error to report.
 */
export function buildOfficialPackagesClause(agentHome = "$HOME/.pi/agent"): string {
  const installs = OFFICIAL_AGENT_PACKAGES.map((source) => {
    const name = source.replace(/^npm:/, "").split("@")[0]!;
    return `( test -d ${agentHome}/npm/node_modules/${name} || ( command -v pi >/dev/null 2>&1 && PI_CODING_AGENT_DIR=${agentHome} pi install ${source} >/dev/null 2>&1 ) || true )`;
  });
  return `${installs.join("\n")}\n`;
}
