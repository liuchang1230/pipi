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

const EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

export interface ShippedExtension {
  fileName: string;
  content: string;
}

export const SHIPPED_EXTENSIONS: ShippedExtension[] = [
  { fileName: "pipi-static-indicator.ts", content: staticIndicatorSource },
  { fileName: "pipi-tree-nav.ts", content: treeNavSource },
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
export function buildSshInstallCommand(extensions: ShippedExtension[] = SHIPPED_EXTENSIONS): string {
  const base = "$HOME/.pi/agent/extensions";
  const writes = extensions
    .map(({ fileName, content }) => {
      const b64 = Buffer.from(content, "utf8").toString("base64");
      return `echo ${b64} | base64 -d > ${base}/${fileName}`;
    })
    .join(" && ");
  return `mkdir -p ${base} && ${writes}`;
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
  try {
    await client.mkdir(extDir, true);
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
    };
  }
  return { ok: true, uploaded };
}
