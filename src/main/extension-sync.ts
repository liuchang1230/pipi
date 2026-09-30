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
 *
 * The ssh (key-auth) path splits its work in two on purpose — an ARGV half that
 * is content-free and a STDIN half that carries the base64 payload — because a
 * command line that grows with the shipped content hits Windows' 32,767-char
 * CreateProcess limit and `spawn` then throws ENAMETOOLONG synchronously. See
 * ssh-exec.ts; buildSshInstallCommand/buildSshInstallScript are that split.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type SftpClient from "ssh2-sftp-client";
import { remoteAgentDir } from "./pty";
import staticIndicatorSource from "./extensions/pipi-static-indicator.ts?raw";
import treeNavSource from "./extensions/pipi-tree-nav.ts?raw";
import modelSyncSource from "./extensions/pipi-model-sync.ts?raw";
import subagentModelSource from "./extensions/pipi-subagent-model.ts?raw";
import approvalGateSource from "./extensions/pipi-approval-gate.ts?raw";

const AGENT_HOME = join(homedir(), ".pi", "agent");
const EXTENSIONS_DIR = join(AGENT_HOME, "extensions");

export interface ShippedExtension {
  fileName: string;
  content: string;
}

export const SHIPPED_EXTENSIONS: ShippedExtension[] = [
  { fileName: "pipi-static-indicator.ts", content: staticIndicatorSource },
  { fileName: "pipi-tree-nav.ts", content: treeNavSource },
  { fileName: "pipi-model-sync.ts", content: modelSyncSource },
  { fileName: "pipi-subagent-model.ts", content: subagentModelSource },
  { fileName: "pipi-approval-gate.ts", content: approvalGateSource },
];

/**
 * Files that EARLIER app versions shipped and that we no longer ship. They must be
 * DELETED on upgrade, not merely ignored: pi auto-loads every .ts under extensions/,
 * so a retired extension left on disk keeps running (the app would just stop
 * rendering its UI — the prompts, briefs and tool guards would still fire). Same for
 * an agent definition or prompt template nobody references any more.
 *
 * A file is removed ONLY when we recognize it as ours: its bytes are the ones we
 * shipped (`sha256`), or it carries EVERY marker (`markers`). Anything else — a file
 * the user wrote or edited — is left alone and logged. Markers are space-free so the
 * remote one-liner can pass them through `base64 -d` unquoted.
 */
export interface RetiredFile {
  dir: "extensions" | "agents" | "prompts";
  fileName: string;
  sha256: string;
  markers: string[];
}

export const RETIRED_FILES: RetiredFile[] = [
  {
    dir: "extensions",
    fileName: "pipi-mode-switch.ts",
    sha256: "a3244720443fa75b0dbe88413b94d50876ae4fb42badd60ef24bc366c5177c8e",
    markers: ["pipi-mode-switch", "pipi-mode"],
  },
  {
    dir: "agents",
    fileName: "planner.md",
    sha256: "cf304fd6a3b42fbba08e61b45af37d7d4228d848004895008b43a2b4958ac64c",
    markers: ["READ-ONLY", "specialist"],
  },
  {
    dir: "prompts",
    fileName: "scout-and-plan.md",
    sha256: "eaed55dbd1e23f3b66fd703e01bd6aaf16d8c8cbec2b98105b9ece78aa805353",
    markers: ["先侦察再规划"],
  },
];

/** Is this file one we shipped and have since retired? */
export function shouldRetire(content: string, spec: RetiredFile): boolean {
  if (createHash("sha256").update(content, "utf8").digest("hex") === spec.sha256) return true;
  return spec.markers.every((m) => content.includes(m));
}

/**
 * Delete files we no longer ship. Best-effort like the sync itself: a failure is
 * logged, never fatal (the app must still start). `agentHome` is overridable for
 * tests. Returns the paths actually deleted.
 */
export function retireShippedFiles(agentHome = AGENT_HOME): string[] {
  const removed: string[] = [];
  for (const spec of RETIRED_FILES) {
    const target = join(agentHome, spec.dir, spec.fileName);
    try {
      if (!existsSync(target)) continue;
      const content = readFileSync(target, "utf8");
      if (!shouldRetire(content, spec)) {
        console.log(`[extensions] keeping ${target}: not a file we shipped`);
        continue;
      }
      rmSync(target, { force: true });
      removed.push(target);
      console.log(`[extensions] retired ${target}`);
    } catch (e) {
      console.error(`[extensions] failed to retire ${spec.fileName}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return removed;
}

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
  for (const { fileName, content } of SHIPPED_EXTENSIONS) {
    try {
      mkdirSync(dir, { recursive: true });
      const target = join(dir, fileName);
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
  /** Paths removed because we no longer ship them (see RETIRED_FILES). */
  retired?: string[];
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
 * The ARGV half of the key-auth install: a deliberately content-free command
 * that reads the real work from stdin. It must stay this small — see the
 * module header and ssh-exec.ts (a ~35KB argv throws ENAMETOOLONG synchronously
 * on Windows, which is how this provisioning used to die on EVERY key-auth
 * connect once the shipped sources grew past ~24KB).
 */
export function buildSshInstallCommand(): string {
  return "sh -s";
}

/**
 * The STDIN half: the POSIX script that installs the shipped extensions into a
 * Linux server's ~/.pi/agent/extensions. Content is base64-embedded so no
 * quoting/newline escaping crosses the ssh→bash layers; the script itself
 * avoids quotes entirely ($HOME expands in the remote shell; the default
 * agent path has no spaces). Used by the key-auth remote sync — there the app
 * has no SFTP credentials, so provisioning goes over ssh.exe with BatchMode
 * instead (see syncKeyAuthExtensions in index.ts).
 */
export function buildSshInstallScript(extensions: ShippedExtension[] = SHIPPED_EXTENSIONS): string {
  const base = "$HOME/.pi/agent/extensions";
  const writes = extensions
    .map(({ fileName, content }) => {
      const b64 = Buffer.from(content, "utf8").toString("base64");
      return `echo ${b64} | base64 -d > ${base}/${fileName}`;
    })
    .join(" && ");
  return `mkdir -p ${base} && ${writes}${buildSshRetireSuffix()}\n`;
}

/**
 * The remote half of retirement: `rm -f` only when our markers are all present.
 * Quote-free (markers travel base64-encoded, and they contain no spaces) and
 * wrapped in a subshell that always succeeds, so a retire miss can never fail the
 * install command itself.
 */
function buildSshRetireSuffix(): string {
  return RETIRED_FILES.map(({ dir, fileName, markers }) => {
    const path = `$HOME/.pi/agent/${dir}/${fileName}`;
    const probes = markers
      .map((m) => `grep -q $(echo ${Buffer.from(m, "utf8").toString("base64")} | base64 -d) ${path}`)
      .join(" && ");
    return ` && ( test -f ${path} && ${probes} && rm -f ${path} && echo retired ${path} || true )`;
  }).join("");
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
  const extDir = `${base}/extensions`;
  const retired: string[] = [];
  try {
    await client.mkdir(extDir, true);
    // Retire first: a retired extension must not survive the sync that stops
    // shipping it (pi loads it from disk regardless of what the app renders).
    for (const spec of RETIRED_FILES) {
      const remotePath = `${base}/${spec.dir}/${spec.fileName}`;
      let current: string | Buffer | undefined;
      try {
        current = (await client.get(remotePath)) as string | Buffer | undefined;
      } catch {
        continue; // not present → nothing to retire
      }
      const text = Buffer.isBuffer(current) ? current.toString("utf8") : String(current ?? "");
      if (!shouldRetire(text, spec)) continue;
      try {
        // noErrorOK: a concurrent delete must not fail the whole sync.
        await client.delete(remotePath, true);
        retired.push(remotePath);
      } catch (error) {
        console.error(`[extensions] failed to retire ${remotePath}:`, error instanceof Error ? error.message : String(error));
      }
    }
    for (const { fileName, content } of SHIPPED_EXTENSIONS) {
      const remotePath = `${extDir}/${fileName}`;
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
      retired,
    };
  }
  return { ok: true, uploaded, retired };
}
