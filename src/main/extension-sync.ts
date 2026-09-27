/**
 * Ship app-bundled pi extensions to ~/.pi/agent/extensions/ so every pi
 * spawned by a tab picks them up via auto-discovery (see docs/extensions.md).
 *
 * The same files are also provisioned to REMOTE (password-authed SFTP) and
 * WSL agent dirs — RPC-backed remote/WSL chat tabs navigate the session tree
 * through the pipi-tree-nav extension command (upstream pi's rpc-mode has no
 * native `navigate_tree` RPC), so the extension must exist on the machine
 * that runs pi, not just the app's local install.
 *
 * Source of truth: the files in src/main/extensions/, embedded at build time
 * via Vite `?raw` imports (no packaging/asar concerns).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type SftpClient from "ssh2-sftp-client";
import { remoteAgentDir } from "./pty";
import staticIndicatorSource from "./extensions/pipi-static-indicator.ts?raw";
import treeNavSource from "./extensions/pipi-tree-nav.ts?raw";
import modelSyncSource from "./extensions/pipi-model-sync.ts?raw";
import subagentModelSource from "./extensions/pipi-subagent-model.ts?raw";
import modeSwitchSource from "./extensions/pipi-mode-switch.ts?raw";
import plannerAgentSource from "./agents/planner.md?raw";
import scoutAndPlanPromptSource from "./prompts/scout-and-plan.md?raw";

const AGENT_HOME = join(homedir(), ".pi", "agent");
const EXTENSIONS_DIR = join(AGENT_HOME, "extensions");

export interface ShippedExtension {
  fileName: string;
  content: string;
}

/**
 * A file the app provisions into pi's agent home. Three kinds, all discovered by
 * pi from the SAME home dir:
 *   extensions/ — code (commands, hooks, UI)
 *   agents/      — subagent definitions (`~/.pi/agent/agents/*.md`)
 *   prompts/     — prompt templates (`~/.pi/agent/prompts/*.md`, typed as /name)
 *
 * Shipping the agent + prompt from the app (rather than assuming the user
 * installed pi's subagent example) is what makes 「先侦察再规划」 available on a
 * fresh machine and on every remote server we provision.
 */
export type ShippedDir = "extensions" | "agents" | "prompts";

export interface ShippedFile extends ShippedExtension {
  dir: ShippedDir;
}

export const SHIPPED_EXTENSIONS: ShippedExtension[] = [
  { fileName: "pipi-static-indicator.ts", content: staticIndicatorSource },
  { fileName: "pipi-tree-nav.ts", content: treeNavSource },
  { fileName: "pipi-model-sync.ts", content: modelSyncSource },
  { fileName: "pipi-subagent-model.ts", content: subagentModelSource },
  { fileName: "pipi-mode-switch.ts", content: modeSwitchSource },
];

export const SHIPPED_FILES: ShippedFile[] = [
  ...SHIPPED_EXTENSIONS.map((f) => ({ ...f, dir: "extensions" as const })),
  // Planner subagent: `model:` is deliberately ABSENT so the app's pinned session
  // model applies (pipi-subagent-model.ts) — a hardcoded model here would silently
  // override the user's choice.
  { dir: "agents", fileName: "planner.md", content: plannerAgentSource },
  { dir: "prompts", fileName: "scout-and-plan.md", content: scoutAndPlanPromptSource },
];

/**
 * Best-effort sync of shipped extensions. Runs at app startup, before any
 * tab can spawn pi; only writes when content actually differs so we don't
 * churn mtimes on every launch. Failures are logged, never fatal.
 *
 * Returns the file names that were actually written (content changed), so
 * the caller can surface a chat-page notice. `dir` is overridable for tests.
 */
export function ensureShippedExtensions(dir = EXTENSIONS_DIR): string[] {
  const updated: string[] = [];
  // `dir` may be given explicitly (tests, custom installs): keep the historical
  // behaviour of writing the EXTENSIONS there, and derive the sibling dirs from it
  // so agents/prompts land next to them instead of in the real home.
  const explicit = dir !== EXTENSIONS_DIR;
  const root = explicit ? dir.replace(/[\/]extensions$/, "") : AGENT_HOME;
  for (const { fileName, content, dir: kind } of SHIPPED_FILES) {
    try {
      const targetDir = explicit ? (kind === "extensions" ? dir : join(root, kind)) : join(root, kind);
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, fileName);
      const current = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (current !== content) {
        writeFileSync(target, content, "utf8");
        updated.push(fileName);
        console.log(`[extensions] wrote ${target}`);
      }
    } catch (e) {
      console.error(`[extensions] failed to ship ${fileName}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return updated;
}

export interface RemoteExtensionsSyncResult {
  ok: boolean;
  error?: string;
  uploaded: string[];
}

/** Build the remote-shell command that cats a file whose path is
 *  base64-embedded — quote-free across Windows spawn → ssh.exe → bash, using
 *  the SAME pattern rpc-session.ts's sessionArg uses for --session paths in
 *  production (`printf %s '<b64>' | base64 -d` + `"$P"`). */
export function buildSshCatCommand(remotePath: string): string {
  const b64 = Buffer.from(remotePath, "utf8").toString("base64");
  return `P="$(printf %s '${b64}' | base64 -d 2>/dev/null || printf %s '${b64}' | base64 -D 2>/dev/null)"; cat "$P"`;
}

/**
 * Build the remote-shell command that installs the shipped extensions into a
 * Linux server's ~/.pi/agent/extensions. Content is base64-embedded so no
 * quoting/newline escaping crosses the ssh→bash layers; the command itself
 * avoids quotes entirely ($HOME expands in the remote shell; the default
 * agent path has no spaces). Used by the key-auth remote sync — there the
 * app has no SFTP credentials, so provisioning goes over ssh.exe with
 * BatchMode instead (see syncKeyAuthExtensions in index.ts).
 */
export function buildSshInstallCommand(files: Array<ShippedExtension & { dir?: ShippedDir }> = SHIPPED_FILES): string {
  // $HOME expands in the remote shell (the agent path has no spaces, and avoiding
  // quotes is what keeps the command safe through ssh.exe → bash layers).
  const dirs = ["extensions", "agents", "prompts"];
  const writes = files
    .map(({ fileName, content, dir }) => {
      const b64 = Buffer.from(content, "utf8").toString("base64");
      return `echo ${b64} | base64 -d > $HOME/.pi/agent/${dir ?? "extensions"}/${fileName}`;
    })
    .join(" && ");
  return `mkdir -p ${dirs.map((d) => `$HOME/.pi/agent/${d}`).join(" ")} && ${writes}`;
}

/**
 * Upload the shipped extensions to a remote server's agent extensions dir
 * over an already-connected sftp session (mirrors syncThemesViaSftp in
 * theme-sync.ts). Content-compared per file: an unchanged remote file is
 * skipped, so this is cheap enough to run on every password-authed connect
 * — an app update reaches the server on the next tab open without waiting
 * for a TTL. The whole upload is wrapped in one try/catch (any failure
 * returns ok:false with the files uploaded so far), matching the theme
 * sync's failure contract.
 */
export async function syncExtensionsViaSftp(
  client: SftpClient,
  homeDir: string,
  agentDirRemote?: string,
): Promise<RemoteExtensionsSyncResult> {
  const uploaded: string[] = [];
  const base = remoteAgentDir({ agentDir: agentDirRemote }, homeDir);
  try {
    for (const { fileName, content, dir } of SHIPPED_FILES) {
      const remoteDir = `${base}/${dir}`;
      await client.mkdir(remoteDir, true);
      const remotePath = `${remoteDir}/${fileName}`;
      let current: string | Buffer | undefined;
      try {
        current = (await client.get(remotePath)) as string | Buffer | undefined;
      } catch {
        current = undefined; // not present yet → upload
      }
      const currentText = current === undefined ? "" : Buffer.isBuffer(current) ? current.toString("utf8") : String(current);
      if (currentText === content) continue;
      // put() treats a string as a LOCAL file path → pass a Buffer for raw content.
      await client.put(Buffer.from(content, "utf8"), remotePath);
      uploaded.push(remotePath);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      uploaded,
    };
  }
  return { ok: true, uploaded };
}
