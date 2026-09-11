/**
 * Subagent model launch defaults.
 *
 * pi's delegated-agent extensions (analyst / reviewer / scout) resolve their
 * model as: the agent definition's `model:` frontmatter → `PI_MODEL`
 * (`PI_PROVIDER`) from their own process environment → pi's default model.
 * pi itself NEVER reads those variables (it only WRITES them into the bash
 * tool's child env), and the app never set them — so subagents silently ran
 * on pi's default model, which is normally the main session's model.
 *
 * This module turns the user's "子代理模型" setting into the env the agent
 * extensions look for. It is injected at every place the app spawns pi
 * (local pty, local RPC child, SDK worker thread, WSL/SSH commands), so a
 * subagent started from any view picks it up. Absent setting = no injection =
 * the previous "follow the main model" behavior.
 *
 * Values are validated on the way in (settings.ts strips empties), but model
 * ids legitimately contain `/`, `.`, `:`, `-`, so the shell prefix quotes
 * them rather than assuming a safe charset.
 */
import { getSettings, type SubagentModelSettings } from "./settings";

/** The configured subagent model, or null to follow the main model. */
export function getSubagentModel(): SubagentModelSettings | null {
  try {
    return getSettings().subagents ?? null;
  } catch {
    // Reading settings must NEVER block spawning pi (app not ready, unreadable
    // settings.json, …). Fall back to "follow the main model".
    return null;
  }
}

/**
 * Env vars for a directly spawned pi process (local pty / local RPC child /
 * SDK worker thread). Spread into the child's env — never into the app's
 * `process.env`, which would leak into unrelated children.
 */
export function subagentEnv(): Record<string, string> {
  return subagentEnvFor(getSubagentModel());
}

/** Pure form of {@link subagentEnv} (exported for tests). */
export function subagentEnvFor(model: SubagentModelSettings | null): Record<string, string> {
  if (!model) return {};
  return {
    ...(model.provider ? { PI_PROVIDER: model.provider } : {}),
    PI_MODEL: model.model,
  };
}

/** base64 keeps the value free of quotes/metacharacters for shell nesting. */
function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Prefix for a WSL/SSH shell command string. Windows env vars do not cross
 * into a WSL distro (unless listed in WSLENV) and never travel over
 * `ssh exec`, so the only way to hand the remote pi these values is to put
 * them in front of the command it runs.
 *
 * CRITICAL: the SSH variants embed this string INSIDE `bash -ic '<cmd>'` — a
 * single quote (even an escaped `'\''`) would terminate that outer quote and
 * corrupt the whole remote command, exactly the failure `sessionArg` avoids by
 * base64-encoding the session path. So the values are base64-decoded into
 * double-quoted variables with NO single quotes anywhere. The `export …;` form
 * also works where the prefix is spliced into a `then <prefix>pi;` branch.
 */
export function subagentShellPrefix(): string {
  return subagentShellPrefixFor(getSubagentModel());
}

/** Pure form of {@link subagentShellPrefix} (exported for tests). */
export function subagentShellPrefixFor(model: SubagentModelSettings | null): string {
  if (!model) return "";
  const decode = (value: string): string =>
    `"$(printf %s ${b64(value)} | base64 -d 2>/dev/null || printf %s ${b64(value)} | base64 -D 2>/dev/null)"`;
  return `${model.provider ? `export PI_PROVIDER=${decode(model.provider)}; ` : ""}export PI_MODEL=${decode(model.model)}; `;
}
