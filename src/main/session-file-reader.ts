/**
 * session-file-reader.ts — read a tab's session JSONL over whichever channel
 * that target actually has.
 *
 * Why this is a named module: the channel rule is easy to get wrong and has
 * already bitten us once — the connection probe and the SFTP lease used
 * different auth material, so the sidebar showed a green "connected" while
 * every file read failed auth (see CONTEXT.md). Enumerating the cases in ONE
 * place is what keeps the callers (session tree today; chat transcript,
 * changelog and search next) from drifting apart.
 *
 * The host is injected (Ports & Adapters) so this module stays
 * transport-agnostic and is unit-testable with an in-memory host — the real
 * adapters live in index.ts, where the SFTP lease pool and `withSftp` are in
 * scope.
 */
import type { RemoteOpts } from "./pty";

/**
 * The remote fields this module must carry through.
 *
 * This is a PROJECTION of `RemoteOpts`, not an arbitrary subset: the object is
 * handed straight to the SFTP adapter, whose lease pool keys on
 * `host|user|port|path|agentDir` (`stableRemoteKey`) and whose auth uses
 * `password`. Dropping any of them silently splits the lease pool (two
 * connections to one server, two caches) or loses the credential — the same
 * class of bug as the probe-vs-SFTP auth mismatch. Expressing it in terms of
 * `RemoteOpts` turns such a change into a compile error here instead of a
 * runtime surprise.
 */
export type SessionFileRemote = Pick<
  RemoteOpts,
  "host" | "user" | "port" | "path" | "agentDir" | "password"
>;

/** Where a session file lives. `wslDistro` / `remote` are absent for local. */
export interface SessionFileTarget {
  wslDistro?: string;
  remote?: SessionFileRemote;
}

/** The injected transports. One method per channel, no tab/lease knowledge. */
export interface SessionFileHost {
  readLocal(path: string): Promise<string>;
  readWsl(distro: string, path: string): Promise<string>;
  /** Password remotes: the pooled SFTP lease. */
  readSftp(remote: SessionFileRemote, path: string): Promise<string>;
  /** Key-auth remotes: no SFTP lease exists for them, so read over ssh. */
  readSsh(remote: SessionFileRemote, path: string): Promise<string>;
}

export type SessionFileReader = (target: SessionFileTarget, path: string) => Promise<string>;

/**
 * Build a reader over an injected host.
 *
 * Channel rule (the invariant this module exists to hold):
 *  - WSL    → UNC read inside the distro
 *  - remote → SFTP when a password is present (a lease can be established),
 *             otherwise ssh — which also works when the remote pi is dead,
 *             exactly when a file fast path is most needed
 *  - local  → plain fs read
 *
 * Resolves the file's text. THROWS on failure, so callers can fall back to the
 * RPC path; the injected adapters treat an empty read as failure.
 */
export function createSessionFileReader(host: SessionFileHost): SessionFileReader {
  return async function readSessionFile(target, path) {
    if (target.wslDistro) return host.readWsl(target.wslDistro, path);
    if (target.remote) {
      return target.remote.password ? host.readSftp(target.remote, path) : host.readSsh(target.remote, path);
    }
    return host.readLocal(path);
  };
}
