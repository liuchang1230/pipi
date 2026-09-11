// Connection targets for remote/WSL work: a live tab id, or an explicit
// connection profile. Main's file/session handlers accept either (see
// resolveTarget in main/index.ts), so browsing a server's files and sessions
// no longer requires a connection tab — an SSH tab is only created when the
// user explicitly asks for a remote terminal.
import { buildRemoteKey } from "./remote-servers";
import type { ProjectGroup, RemoteServerGroup } from "./types";

export interface RemoteProfileTarget {
  host: string;
  user: string;
  port?: number;
  path?: string;
  password?: string;
  agentDir?: string;
}

export interface WslProfileTarget {
  distro: string;
  path?: string;
}

/** Either a tab id (string) or an explicit profile — the two shapes main
 *  accepts for `file:*`, `session:*` and `remote:*` calls. */
export type TargetRef =
  | string
  | { tabId?: string; remote?: RemoteProfileTarget; wsl?: WslProfileTarget };

/** Connection profile of a sidebar project row (SSH or WSL). */
export function projectProfile(project: ProjectGroup): RemoteProfileTarget | WslProfileTarget {
  if ((project.port ?? 22) === 0 && project.host) return { distro: project.host, path: project.cwd };
  return {
    host: project.host ?? "",
    user: project.user ?? "",
    port: project.port,
    path: project.cwd,
    password: project.password,
    agentDir: project.agentDir,
  };
}

/** Target ref for a sidebar project row. Prefers the project's connection
 *  profile; falls back to its live tab when the row still owns one (WSL rows
 *  are bound to their distro tab). */
export function projectTarget(project: ProjectGroup): TargetRef {
  const profile = projectProfile(project);
  return "distro" in profile ? { wsl: profile } : { remote: profile };
}

/** Connection profile of a server node (probe + login dialog). */
export function serverProfile(server: RemoteServerGroup): RemoteProfileTarget {
  return {
    host: server.host,
    user: server.user,
    port: server.port,
    path: server.path,
    password: server.password,
    agentDir: server.agentDir,
  };
}

/** Stable cache key for a target: the profile key when it is a profile, else
 *  the tab id. Mirrors main's buildRemoteKey so sidebar/tab views agree. */
export function targetKey(target: TargetRef | undefined): string | undefined {
  if (!target) return undefined;
  if (typeof target === "string") return target;
  if (target.tabId) return target.tabId;
  if (target.remote) return buildRemoteKey(target.remote.host, target.remote.user, target.remote.port, target.remote.agentDir);
  if (target.wsl) return `wsl:${target.wsl.distro}`;
  return undefined;
}

/** Target for a tree/viewer origin (`{tabId, remote?, wsl?}`). */
export function targetOfOrigin(
  origin: { tabId?: string; remote?: RemoteProfileTarget; wsl?: WslProfileTarget } | null | undefined,
): TargetRef | undefined {
  if (!origin) return undefined;
  if (origin.remote) return { remote: origin.remote };
  if (origin.wsl) return { wsl: origin.wsl };
  return origin.tabId;
}
