// Server-grouping logic for the sidebar's 远程服务器 section. SSH servers
// are derived from three sources — saved connections (remote-history.json),
// remote project folders (projects.json) and open tabs — and deduped by the
// same (user, host, port, agentDir) key the main process uses for its tab
// registry and remote caches, so "connected" and project membership always
// agree with the rest of the app.
//
// Pure module: no store imports (the two key helpers live here and are
// re-exported by sessionsStore for existing call sites). Fully unit-testable.
import type {
  ProjectGroup,
  ProjectListItem,
  RemoteFileDiagnostics,
  RemoteHistoryItem,
  RemoteHydrationState,
  RemoteServerGroup,
  ServerStatus,
  SessionItem,
  TabInfo,
} from "./types";

export const buildRemoteKey = (host?: string, user?: string, port?: number, agentDir?: string) =>
  `${user ?? ""}@${host ?? ""}:${port ?? 22}${agentDir ? `[${agentDir}]` : ""}`;

export const remoteSessionCacheKey = (tabId: string, remoteCwd: string, agentDir = "") =>
  `${tabId}:${agentDir}:${remoteCwd}`;

interface ServerSeed {
  host: string;
  user: string;
  port: number;
  agentDir?: string;
  password?: string;
  path?: string;
}

function serverLabel(host: string, user: string, port: number, agentDir?: string): string {
  const base = `${user}@${host}`;
  const portSuffix = port === 22 ? "" : `:${port}`;
  return agentDir ? `${base}${portSuffix} · ${agentDir}` : `${base}${portSuffix}`;
}

/** A connection-only shell tab vs a pi session tab. Main assigns the
 * classification when it creates the tab; presentation never parses titles. */
function isConnectionTab(t: TabInfo): boolean {
  return t.kind === "connection";
}

/** The tab the sidebar's 「终端」 button should focus for a server, or null when
 *  a NEW shell tab must be spawned.
 *
 *  Only a healthy connection shell tab qualifies. pi session tabs are skipped
 *  even though they share the remoteKey: a session tab renders the CHAT view,
 *  so reusing it would answer a click on 「终端」 with a conversation instead of
 *  a terminal. A FAILED shell tab is skipped too (ssh already exited before the
 *  ready marker, so activating it silently no-ops) — the caller then spawns a
 *  fresh shell, which is also the only surface where a password can be typed.
 *  Among several candidates a confirmed (ready) shell wins over one still
 *  coming up. */
export function pickServerTerminalTab(tabs: TabInfo[], remoteKey: string): TabInfo | null {
  let best: TabInfo | null = null;
  for (const t of tabs) {
    if (!t.isRemote || t.isWsl || t.remoteKey !== remoteKey) continue;
    if (!isConnectionTab(t) || t.sshState === "failed") continue;
    if (!best || (best.sshState !== "ready" && t.sshState === "ready")) best = t;
  }
  return best;
}

export interface GroupRemoteServersParams {
  projects: ProjectListItem[];
  remoteHistory: RemoteHistoryItem[];
  tabs: TabInfo[];
  projectSessions: Record<string, SessionItem[]>;
  remoteSessions: Record<string, SessionItem[]>;
  projectErrors: Record<string, string | undefined>;
  projectDiagnostics: Record<string, RemoteFileDiagnostics | undefined>;
  remoteHydration: RemoteHydrationState;
  /** Live connection state from the probe registry, keyed by remoteKey.
   *  Tab-independent: a server the user just probed reads "connected" here
   *  even though no connection tab exists for it. */
  remoteStatus?: Record<string, {
    status: ServerStatus;
    needPassword?: boolean;
    /** Live profile from the last successful probe. Carries the password the
     *  user just typed (in-memory only — persisted only when "remember" is
     *  checked), so it must override stale saved passwords from history/
     *  projects for every follow-up read. */
    profile?: { host?: string; user?: string; port?: number; agentDir?: string; password?: string };
  }>;
}

export function groupRemoteServers(params: GroupRemoteServersParams): RemoteServerGroup[] {
  const { projects, remoteHistory, tabs } = params;

  // 1. Seed the server set from saved history + project folders (union).
  const seeds = new Map<string, ServerSeed>();
  const upsertSeed = (seed: ServerSeed) => {
    const key = buildRemoteKey(seed.host, seed.user, seed.port, seed.agentDir);
    const existing = seeds.get(key);
    if (!existing) {
      seeds.set(key, { ...seed });
      return;
    }
    if (!existing.password && seed.password) existing.password = seed.password;
    if (!existing.path && seed.path) existing.path = seed.path;
  };
  // History is written on every connect (saveRemoteHistory overwrites the
  // password), so it is treated as fresher than a project's cached copy —
  // history's password wins when both sources carry one.
  for (const h of remoteHistory) {
    upsertSeed({ host: h.host, user: h.user, port: h.port, agentDir: h.agentDir, password: h.password, path: h.path });
  }
  for (const p of projects) {
    if (p.type !== "remote" || !p.host || !p.user) continue;
    upsertSeed({ host: p.host, user: p.user, port: p.port ?? 22, agentDir: p.agentDir, password: p.password });
  }

  // 2. Open tabs mark a server's connection state. A pi session tab (rpc)
  //    proves connectivity (pi runs on that server); a connection shell tab
  //    is confirmed only via its sshState (ready marker). The node's
  //    activation target prefers the connection shell tab, ranked
  //    ready > connecting > failed (a dead tab must never win the slot).
  const connTabByKey = new Map<string, TabInfo>();
  /** A server counts as "connected by a tab" only when that tab PROVED
   *  connectivity: a pi session that booted (remoteReady) or a connection
   *  shell whose __PIPI_READY__ marker arrived. A merely-existing tab (e.g. a
   *  session stuck at auth) must stay "connecting" — otherwise the sidebar
   *  lied green while every read failed. */
  const hasReadyTabByKey = new Map<string, boolean>();
  const connRank = (t: TabInfo): number => (t.sshState === "ready" ? 2 : t.sshState === "failed" ? 0 : 1);
  for (const t of tabs) {
    if (!t.isRemote || t.isWsl || !t.remoteKey || !t.remoteHost || !t.remoteUser) continue;
    if (!seeds.has(t.remoteKey)) {
      upsertSeed({ host: t.remoteHost, user: t.remoteUser, port: t.remotePort ?? 22, agentDir: t.remoteAgentDir });
    }
    if (isConnectionTab(t)) {
      // Connection shell tab wins the activation target over any session tab;
      // among shell tabs, the healthier one wins.
      const prev = connTabByKey.get(t.remoteKey);
      if (!prev || !isConnectionTab(prev) || connRank(t) > connRank(prev)) connTabByKey.set(t.remoteKey, t);
      if (t.sshState === "ready") hasReadyTabByKey.set(t.remoteKey, true);
    } else {
      if (t.remoteReady === true) hasReadyTabByKey.set(t.remoteKey, true);
      if (!connTabByKey.has(t.remoteKey)) connTabByKey.set(t.remoteKey, t);
    }
  }

  function serverStatus(key: string, tab: TabInfo | undefined): ServerStatus {
    const registry = params.remoteStatus?.[key];
    if (registry) {
      // A live ready tab still proves connectivity even when the last probe
      // failed (the probe may have used a stale credential).
      if (registry.status !== "connected" && hasReadyTabByKey.get(key)) return "connected";
      return registry.status;
    }
    if (hasReadyTabByKey.get(key)) return "connected";
    if (tab?.sshState === "failed") return "failed";
    if (tab) return "connecting";
    return "disconnected";
  }

  // 3. Hang each server's project folders under its node.
  const groups: RemoteServerGroup[] = [];
  for (const [key, seed] of seeds) {
    const tab = connTabByKey.get(key);
    const status = serverStatus(key, tab);
    // The last successful probe's password is the freshest credential we have
    // (the user just typed it). It must win over history/project copies that
    // may be stale — otherwise a successful one-off login is followed by a
    // need-password prompt on every subsequent session/file read.
    const livePassword = params.remoteStatus?.[key]?.profile?.password;
    const projectsForServer = projects
      .filter(
        (p) =>
          p.type === "remote" && !!p.path && !!p.host && !!p.user &&
          buildRemoteKey(p.host, p.user, p.port, p.agentDir) === key,
      )
      .map((p): ProjectGroup => {
        const isHydratingTarget = params.remoteHydration.tabId === tab?.id && params.remoteHydration.remoteCwd === p.path;
        // The SAME project is cached under EITHER the app's tab id or the
        // readable profile key, depending on which path listed it
        // (sessionsStore.toggleProject writes `tabId ?? remoteKey`, while
        // openRemoteSession writes `remoteKey`). Looking up a single key
        // silently MISSES and the row flashes back to "加载中…" even though the
        // sessions were fetched — so try both, newest-first as written.
        const profileKey = buildRemoteKey(p.host, p.user, p.port, p.agentDir);
        const cacheIds = tab ? [tab.id, profileKey] : [profileKey];
        const cachedSessions =
          cacheIds
            .map((id) => params.remoteSessions[remoteSessionCacheKey(id, p.path!, p.agentDir ?? "")])
            .find((list) => !!list && list.length > 0) ?? [];
        const sessions = params.projectSessions[p.id] ?? cachedSessions;
        return {
          key: p.id,
          label: p.name,
          cwd: p.path!,
          type: "remote",
          tabId: tab?.id,
          remoteKey: key,
          host: p.host,
          user: p.user,
          port: p.port,
          password: livePassword ?? p.password ?? seed.password,
          agentDir: p.agentDir,
          sessions,
          disabled: status !== "connected",
          error: params.projectErrors[p.id],
          hydrationPhase: isHydratingTarget ? params.remoteHydration.phase : "idle",
          diagnostics: params.projectDiagnostics[p.id],
        };
      });
    groups.push({
      key,
      host: seed.host,
      user: seed.user,
      port: seed.port,
      agentDir: seed.agentDir,
      password: livePassword ?? seed.password,
      path: seed.path,
      label: serverLabel(seed.host, seed.user, seed.port, seed.agentDir),
      status,
      needPassword: params.remoteStatus?.[key]?.needPassword,
      tabId: tab?.id,
      projects: projectsForServer,
    });
  }

  return groups.sort((a, b) => a.label.localeCompare(b.label));
}
