/**
 * Ship app-internal pi content into an agent dir's extensions/ and agents/ so
 * every pi spawned by a tab picks it up via auto-discovery (see pi's
 * docs/extensions.md), on the local machine, in WSL, and on remote servers.
 *
 * Two destinations, two ownership postures (both live in content-sync.ts):
 *
 *   - extensions/: the 5 app-owned extension sources are code WE maintain and
 *     the user is not invited to edit, so they are shipped with
 *     `policy: "overwrite"` — an out-of-date copy is a bug, and a diverged copy
 *     is an unsupported state.
 *   - extensions/delegation/ + agents/: the delegation capability layer
 *     (analyst / reviewer / scout) is text the user is expected to tune, so it
 *     keeps the default `preserve` policy: their edits win, are logged, and are
 *     never overwritten. It needs a journal for the same reason the skills tree
 *     does — see content-sync.ts.
 *
 * Why the delegation layer ships at all (ADR 0005): the shipped `code-review`
 * skill tells the model to run both axes as one `reviewer` call with two
 * `tasks`, and pi core deliberately ships no sub-agents — the app would
 * otherwise hand every user a skill whose step 4 cannot run, silently, in one
 * context. The skill text no longer assumes it WILL run (ADR 0004 补记四): it
 * names the mechanism, states what to do without it, and requires the report to
 * say which mode ran, so a machine that never got this sync degrades out loud.
 *
 * RPC-backed remote/WSL chat tabs navigate the session tree through the
 * pipi-tree-nav extension command (upstream pi's rpc-mode has no native
 * `navigate_tree` RPC), so the extension must exist on the machine that runs
 * pi, not just the app's local install — hence the four transports.
 *
 * Source of truth: src/main/extensions/ and src/main/agents/, embedded at build
 * time via Vite `?raw` imports (no packaging/asar concerns).
 *
 * The ssh (key-auth) path sends a content-free command and carries the payload
 * on stdin, because a command line that grows with the shipped content hits
 * Windows' 32,767-char CreateProcess limit and `spawn` then throws
 * ENAMETOOLONG synchronously. See ssh-exec.ts + content-sync.ts.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type SftpClient from "ssh2-sftp-client";
import { remoteAgentDir } from "./pty";
import {
  buildSshContentCommand,
  ensureContent,
  sftpContentIo,
  syncContent,
  syncContentViaSsh,
  type ShippedFile,
  type SshScriptRunner,
} from "./content-sync";
import staticIndicatorSource from "./extensions/pipi-static-indicator.ts?raw";
import treeNavSource from "./extensions/pipi-tree-nav.ts?raw";
import modelSyncSource from "./extensions/pipi-model-sync.ts?raw";
import subagentModelSource from "./extensions/pipi-subagent-model.ts?raw";
import approvalGateSource from "./extensions/pipi-approval-gate.ts?raw";
import delegationIndexSource from "./extensions/delegation/index.ts?raw";
import delegationAgentsSource from "./extensions/delegation/agents.ts?raw";
import delegationDeclarationsSource from "./extensions/delegation/declarations.ts?raw";
import delegationEngineSource from "./extensions/delegation/engine.ts?raw";
import delegationRenderSource from "./extensions/delegation/render.ts?raw";
import analystAgentSource from "./agents/analyst.md?raw";
import reviewerAgentSource from "./agents/reviewer.md?raw";
import scoutAgentSource from "./agents/scout.md?raw";

const AGENT_HOME = join(homedir(), ".pi", "agent");
export const EXTENSIONS_DIR = join(AGENT_HOME, "extensions");
export const AGENTS_DIR = join(AGENT_HOME, "agents");
/** The remote roots, as POSIX expressions the REMOTE shell expands. Key-auth
 *  provisioning is skipped when the remote uses an agentDir override (index.ts),
 *  so `$HOME` is always the right root there. */
const REMOTE_EXTENSIONS_DIR = "$HOME/.pi/agent/extensions";
const REMOTE_AGENTS_DIR = "$HOME/.pi/agent/agents";

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

/** The delegation capability layer, as `extensions/delegation/*.ts` — pi's
 *  discovery rule for a directory extension is `extensions/<name>/index.ts`. */
const DELEGATION_FILES: ShippedFile[] = [
  { relPath: "delegation/index.ts", content: delegationIndexSource },
  { relPath: "delegation/agents.ts", content: delegationAgentsSource },
  { relPath: "delegation/declarations.ts", content: delegationDeclarationsSource },
  { relPath: "delegation/engine.ts", content: delegationEngineSource },
  { relPath: "delegation/render.ts", content: delegationRenderSource },
];

/** Everything the app installs into <agentHome>/extensions: our own single-file
 *  extensions (overwrite) plus the delegation tree (preserve). */
export const SHIPPED_EXTENSION_FILES: ShippedFile[] = [
  ...SHIPPED_EXTENSIONS.map(({ fileName, content }) => ({ relPath: fileName, content, policy: "overwrite" as const })),
  ...DELEGATION_FILES,
];

/** Everything the app installs into <agentHome>/agents. Agent definitions are
 *  prompts the user tunes (or replaces) → preserve. */
export const SHIPPED_AGENT_FILES: ShippedFile[] = [
  { relPath: "analyst.md", content: analystAgentSource },
  { relPath: "reviewer.md", content: reviewerAgentSource },
  { relPath: "scout.md", content: scoutAgentSource },
];

/**
 * Files that EARLIER app versions shipped and that we no longer ship. They must be
 * DELETED on upgrade, not merely ignored: pi auto-loads every .ts under extensions/,
 * so a retired extension left on disk keeps running (the app would just stop
 * rendering its UI — the prompts, briefs and tool guards would still fire). Same for
 * an agent definition or prompt template nobody references any more.
 *
 * This is the PRE-JOURNAL migration path only: content the journal knows about is
 * retired by the plan in content-sync.ts. A file from a version that predates the
 * journal has no entry, so it needs to be recognized by its bytes.
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
 * Best-effort sync of the shipped extensions (see content-sync.ts for the
 * policy: our own sources are overwritten, the delegation tree the user edited
 * is kept). `dir` is overridable for tests. Returns the rel paths actually
 * written, so the caller can surface a chat-page notice.
 */
export function ensureShippedExtensions(dir = EXTENSIONS_DIR): string[] {
  return ensureContent(dir, SHIPPED_EXTENSION_FILES, "extensions").written;
}

/** Same contract for agents/. Returns the rel paths actually written. */
export function ensureShippedAgents(dir = AGENTS_DIR): string[] {
  return ensureContent(dir, SHIPPED_AGENT_FILES, "agents").written;
}

export interface AgentHomeSyncResult {
  /** Rel paths written, e.g. "pipi-tree-nav.ts", "delegation/index.ts". */
  extensions: string[];
  agents: string[];
  /** Kept because the user edited them (never overwritten). */
  diverged: string[];
  /** Removed: no longer shipped, and unedited. */
  retired: string[];
}

/**
 * The whole local startup provisioning step, in one call: both roots of the
 * agent home, plus the pre-journal retirement. Synchronous on purpose — the
 * content must exist BEFORE any tab can spawn pi, which is why this runs at
 * startup rather than on first use (same contract as ensureShippedSkills).
 * Failures are logged, never fatal: the app must still start.
 */
export function ensureShippedAgentHome(agentHome = AGENT_HOME): AgentHomeSyncResult {
  const extensions = ensureContent(join(agentHome, "extensions"), SHIPPED_EXTENSION_FILES, "extensions");
  const agents = ensureContent(join(agentHome, "agents"), SHIPPED_AGENT_FILES, "agents");
  const retired = retireShippedFiles(agentHome);
  return {
    extensions: extensions.written,
    agents: agents.written,
    diverged: [...extensions.diverged, ...agents.diverged],
    retired: [...extensions.retired, ...agents.retired, ...retired],
  };
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
 * The ARGV half of every key-auth remote call: a deliberately content-free
 * command that reads the real work from stdin. It must stay this small — see
 * the module header and ssh-exec.ts (a ~35KB argv throws ENAMETOOLONG
 * synchronously on Windows, which is how this provisioning used to die on
 * EVERY key-auth connect once the shipped sources grew past ~24KB).
 */
export function buildSshInstallCommand(): string {
  return buildSshContentCommand();
}

/**
 * The remote half of the PRE-JOURNAL retirement, appended to the apply trip
 * (the apply script is already going there, so the legacy cleanup costs no
 * extra round trip). `rm -f` only when our markers are all present. Quote-free
 * (markers travel base64-encoded, and they contain no spaces) and each clause
 * is wrapped in a subshell that always succeeds, so a retire miss can never
 * fail the install.
 */
export function buildSshRetireTrailer(agentHome = "$HOME/.pi/agent"): string {
  return `${RETIRED_FILES.map(({ dir, fileName, markers }) => {
    const path = `${agentHome}/${dir}/${fileName}`;
    const probes = markers
      .map((m) => `grep -q $(echo ${Buffer.from(m, "utf8").toString("base64")} | base64 -d) ${path}`)
      .join(" && ");
    return `( test -f ${path} && ${probes} && rm -f ${path} && echo retired ${path} || true )`;
  }).join("\n")}\n`;
}

/**
 * The key-auth (passwordless) ssh transport: one probe→apply sequence per root
 * of the agent home (extensions, then agents), with the legacy retire riding
 * along on the extensions apply. The caller has already bound the remote and the
 * ssh binary; `run` never throws (see ssh-exec.ts), so a failure here is a
 * result, not an exception.
 *
 * Only a fully provisioned server may be marked done by the caller: a failed
 * agents half must be retried on the next connect rather than skipped forever.
 */
export async function syncAgentHomeViaSsh(
  run: SshScriptRunner,
  timeoutMs = 20000,
): Promise<AgentHomeSyncResult & { ok: boolean; error?: string }> {
  const extensions = await syncContentViaSsh(
    run,
    {
      remoteRoot: REMOTE_EXTENSIONS_DIR,
      label: "extensions",
      displayRoot: "~/.pi/agent/extensions",
      trailer: buildSshRetireTrailer(),
    },
    SHIPPED_EXTENSION_FILES,
    timeoutMs,
  );
  const agents = extensions.ok
    ? await syncContentViaSsh(
        run,
        { remoteRoot: REMOTE_AGENTS_DIR, label: "agents", displayRoot: "~/.pi/agent/agents" },
        SHIPPED_AGENT_FILES,
        timeoutMs,
      )
    : { ok: false, written: [], diverged: [], retired: [], error: extensions.error };
  return {
    ok: extensions.ok && agents.ok,
    error: extensions.error ?? agents.error,
    extensions: extensions.written,
    agents: agents.written,
    diverged: [...extensions.diverged, ...agents.diverged],
    retired: [...extensions.retired, ...agents.retired],
  };
}

export interface RemoteExtensionsSyncResult {
  ok: boolean;
  error?: string;
  uploaded: string[];
  /** Paths removed because we no longer ship them (see RETIRED_FILES). */
  retired?: string[];
}

/**
 * Upload the shipped content to a remote server's agent home over an
 * already-connected sftp session (mirrors syncThemesViaSftp in theme-sync.ts).
 * Both roots go through the same journal rules as the local sync, so a
 * delegation file or agent definition the user tuned ON THE SERVER is kept
 * rather than clobbered. The whole upload is wrapped in one try/catch (any
 * failure returns ok:false with the paths uploaded so far), matching the theme
 * sync's failure contract.
 */
export async function syncExtensionsViaSftp(
  client: SftpClient,
  homeDir: string,
  agentDirRemote?: string,
): Promise<RemoteExtensionsSyncResult> {
  const uploaded: string[] = [];
  const base = remoteAgentDir({ agentDir: agentDirRemote }, homeDir);
  const retired: string[] = [];
  try {
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
    for (const [root, files] of [
      [`${base}/extensions`, SHIPPED_EXTENSION_FILES],
      [`${base}/agents`, SHIPPED_AGENT_FILES],
    ] as const) {
      const result = await syncContent(sftpContentIo(client, root), files);
      for (const relPath of result.written) uploaded.push(`${root}/${relPath}`);
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
