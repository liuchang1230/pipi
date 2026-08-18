/**
 * Theme provisioning for pi.
 *
 * Writes the app-controlled themes into pi's custom themes directory
 * (`~/.pi/agent/themes/`) and points pi's settings at them via the
 * auto-mapping `theme: "pipi-light/pipi-dark"` (pi syntax: light/dark).
 *
 * Why custom names instead of the built-in "dark"/"light":
 *  - pi's theme watcher (hot reload) only watches custom theme names.
 *  - `--theme`/discovery-registered themes take precedence over built-ins.
 *
 * Why auto mapping + COLORFGBG: pi resolves the active theme from
 * settings; in auto mode the terminal light/dark detection result picks
 * the half — and that detection reads the COLORFGBG env var, which the
 * app sets on every spawn. So the app owns the mode, not the terminal.
 *
 * Live switching of a RUNNING pi is NOT done here: the renderer pushes
 * pi's native terminal color-scheme report (CSI ?997 n) through the pty
 * (TerminalPane), which pi's autoSync listener applies immediately — no
 * file writes on toggle.
 *
 * Remote (password-authed) servers are provisioned at connect via SFTP.
 * Key-based remotes and WSL distros are not provisioned (the app cannot
 * reach their ~/.pi/agent without credentials) — their pi keeps its own
 * config and the live report only works if that config is already an auto
 * mapping.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type SftpClient from "ssh2-sftp-client";
import { TERMINAL_THEMES, type ThemeMode } from "../shared/terminal-theme";
import { remoteAgentDir } from "./pty";

/** pi auto-mapping: light theme before the slash, dark after. */
export const AUTO_THEME_SETTING = "pipi-light/pipi-dark";

export function agentDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function themesDir(): string {
  return join(agentDir(), "themes");
}

export function settingsPath(): string {
  return join(agentDir(), "settings.json");
}

/** Env vars pi reads during theme detection; inject into the pty spawn. */
export function themeEnv(mode: ThemeMode): Record<string, string> {
  return { COLORFGBG: TERMINAL_THEMES[mode].colorfgbg };
}

/** Write both theme JSONs into pi's custom themes dir. Returns written paths. */
export function ensureLocalThemeFiles(): string[] {
  const dir = themesDir();
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const mode of ["dark", "light"] as ThemeMode[]) {
    const theme = TERMINAL_THEMES[mode];
    const file = join(dir, `${theme.piName}.json`);
    const content = JSON.stringify(theme.pi, null, 2) + "\n";
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (existing !== content) {
      writeFileSync(file, content, "utf8");
      written.push(file);
    }
  }
  return written;
}

/**
 * Best-effort parse of a settings.json. Returns undefined when the file is
 * missing. When it exists but is NOT valid JSON (partial write, concurrent
 * pi flush, manual edit), the original bytes are preserved to a timestamped
 * `.corrupt-*` sibling so nothing is silently lost, then we return an empty
 * object so the theme key can be merged on top of a fresh file.
 */
function readSettingsBestEffort(
  file: string,
  raw: (p: string) => string | Buffer
): Record<string, unknown> | undefined {
  let content: string;
  try {
    content = raw(file).toString("utf8");
  } catch {
    return undefined; // file does not exist (yet)
  }
  if (content.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    try {
      copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    console.warn(
      `[theme] ${file} is not valid JSON; original bytes kept at ${file}.corrupt-*, writing fresh settings`
    );
    return {};
  }
}

/**
 * Merge the auto theme mapping into `~/.pi/agent/settings.json`,
 * preserving every other key. Returns true when the file changed.
 */
export function ensureLocalSettingsTheme(): boolean {
  const file = settingsPath();
  const settings =
    readSettingsBestEffort(file, (p) => readFileSync(p, "utf8")) ?? {};
  if (settings.theme === AUTO_THEME_SETTING) return false;
  settings.theme = AUTO_THEME_SETTING;
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}

export interface RemoteThemeSyncResult {
  ok: boolean;
  error?: string;
  uploaded: string[];
}

/**
 * Upload the same theme files + settings merge to a remote server over an
 * already-connected sftp session. `homeDir` is the remote home (from the
 * sftp realPath). Non-fatal per-file: a failure on one file doesn't abort
 * the rest, and the caller may still open the tab with remote defaults.
 */
export async function syncThemesViaSftp(
  client: SftpClient,
  homeDir: string,
  agentDirRemote?: string
): Promise<RemoteThemeSyncResult> {
  const uploaded: string[] = [];
  const base = remoteAgentDir({ agentDir: agentDirRemote }, homeDir);
  const themesRemote = `${base}/themes`;
  try {
    await client.mkdir(themesRemote, true);
    for (const mode of ["dark", "light"] as ThemeMode[]) {
      const theme = TERMINAL_THEMES[mode];
      const remotePath = `${themesRemote}/${theme.piName}.json`;
      // put() treats a string as a LOCAL file path → pass a Buffer for raw content.
      await client.put(Buffer.from(JSON.stringify(theme.pi, null, 2) + "\n", "utf8"), remotePath);
      uploaded.push(remotePath);
    }
  } catch (error) {
    return {
      ok: false,
      error: `theme files: ${error instanceof Error ? error.message : String(error)}`,
      uploaded,
    };
  }

  // Merge settings.json on the remote (preserve everything else).
  try {
    const settingsRemote = `${base}/settings.json`;
    let settings: Record<string, unknown> | undefined;
    let raw: string | Buffer | undefined;
    try {
      raw = (await client.get(settingsRemote)) as string | Buffer | undefined;
    } catch {
      raw = undefined; // no settings.json yet → create a minimal one
    }
    if (raw !== undefined) {
      const content = (Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)).trim();
      if (content.length > 0) {
        try {
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            settings = parsed as Record<string, unknown>;
          }
        } catch {
          // Corrupt remote settings: preserve the bytes remotely, then write fresh.
          try {
            await client.rename(settingsRemote, `${settingsRemote}.corrupt-${Date.now()}`);
          } catch {
            /* best effort */
          }
          console.warn(`[theme] remote ${settingsRemote} is not valid JSON; preserved and rewritten`);
        }
      }
    }
    const merged: Record<string, unknown> = settings ?? {};
    if (merged.theme !== AUTO_THEME_SETTING) {
      merged.theme = AUTO_THEME_SETTING;
      // put() treats a string as a LOCAL file path → pass a Buffer for raw content.
      await client.put(Buffer.from(JSON.stringify(merged, null, 2) + "\n", "utf8"), settingsRemote);
      uploaded.push(settingsRemote);
    }
  } catch (error) {
    return {
      ok: false,
      error: `settings: ${error instanceof Error ? error.message : String(error)}`,
      uploaded,
    };
  }
  return { ok: true, uploaded };
}
