/**
 * SessionIndex — the single module that owns "list the sessions of a cwd",
 * across every target that stores sessions on a plain filesystem the app can
 * read directly (local disk, WSL distro via \\wsl$ UNC).
 *
 * Previously session listing logic was split across five implementations:
 *   - `listSessions` (sync, uncached, unbounded) behind `session:list`
 *   - `pollLocalSessionsOnce` (snapshot incremental) in index.ts
 *   - `wslScanSessionDir` (its own snapshot cache) in index.ts
 *   - the remote cache + hydration pipeline in index.ts
 *   - the auto-follow / title watchers (their own stat scans)
 *
 * Every caller (the click path: `session:list` + `session:list-remote` WSL
 * branch + the 4s poll + the active-tab session cache) now crosses the same
 * seam:
 *
 *   cached(target, cwd)  — sync peek (TTL-guarded), used by the activation
 *                          payload so the renderer can skip a round-trip
 *   refresh(target, cwd) — async incremental parse (only files whose
 *                          mtime/size changed), cooperative line-by-line so a
 *                          multi-MB jsonl never blocks the event loop
 *   startPolling/stop    — the 4s poll, owned here instead of in index.ts
 *   onChange(cb)         — change subscription (emitted only on real changes)
 *
 * The target is a discriminated union: `{kind:"local"}` or
 * `{kind:"wsl", distro}`. The local adapter reads under `agentDir`; the WSL
 * adapter resolves the distro's home directory (async, injectable — tests
 * never spawn wsl.exe) and maps the cwd through `wslToWinPath`. Both adapters
 * sit on `node:fs/promises`, so snapshot incrementality, cooperative parsing
 * and change emission are one shared implementation.
 * (SSH/SFTP sessions keep their own remote cache + hydration pipeline — a
 * different transport, not this seam.)
 */
import { existsSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd, parseSessionTextAsync, type SessionEntry } from "./session-list";

const POLL_INTERVAL_MS = 4000;
/** session:list / activation payload serve from cache when fresher than this. */
const CACHE_TTL_MS = 8000;

/** Which session "world" a cwd belongs to. WSL sessions are plain files under
 *  \\wsl$\<distro>\…, readable with the same fs calls as the local disk. */
export type SessionTarget = { kind: "local" } | { kind: "wsl"; distro: string };

export function localTarget(): SessionTarget {
  return { kind: "local" };
}

export function wslTarget(distro: string): SessionTarget {
  return { kind: "wsl", distro };
}

/** Stable cache key component for a target (root-aware, mirrors the lazy
 *  tree's `${root}\u0000${relDir}` key so two distros never collide). */
export function targetKey(target: SessionTarget): string {
  return target.kind === "local" ? "local" : `wsl\u0000${target.distro}`;
}

const LOCAL_KEY_PREFIX = "local\u0000";

/** Injectable WSL home resolver (tests substitute; production resolves via
 *  wsl.exe — async, never blocking the main-process event loop). */
export type WslHomeResolver = (distro: string) => Promise<string>;

/** Injectable WSL path mapper: (distro, home) → the distro-world root that
 *  `dirFor` appends ".pi/agent/sessions/<enc>" to. Production builds the
 *  \\wsl$ UNC path of the home dir; tests substitute a temp dir (no wsl.exe,
 *  no UNC). */
export type WslPathMapper = (distro: string, home: string) => string;

const defaultWslPathMapper: WslPathMapper = (distro, home) => wslToWinPathCompat(distro, home);

interface DirSnapshotEntry {
  path: string;
  mtime: number;
  size: number;
}

type SessionListener = (sessions: SessionEntry[]) => void;
type AnyChangeListener = (target: SessionTarget, cwd: string, sessions: SessionEntry[]) => void;

export class SessionIndex {
  private snapshots = new Map<string, DirSnapshotEntry[]>();
  private lists = new Map<string, SessionEntry[]>();
  private refreshedAt = new Map<string, number>();
  private listeners = new Map<string, Set<SessionListener>>();
  private anyListeners = new Set<AnyChangeListener>();
  private inflight = new Map<string, Promise<SessionEntry[]>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polledCwd: string | null = null;
  private polledTarget: SessionTarget = { kind: "local" };
  private agentDir = join(homedir(), ".pi", "agent");
  private resolveWslHome: WslHomeResolver = async () => {
    throw new Error("SessionIndex WSL resolver not configured — call setWslHomeResolver()");
  };
  private mapWslPaths: WslPathMapper = defaultWslPathMapper;

  setAgentDir(agentDir: string): void {
    if (this.agentDir === agentDir) return;
    this.agentDir = agentDir;
    // Only local snapshots depend on agentDir; WSL caches are per-distro.
    for (const key of [...this.snapshots.keys()]) {
      if (!key.startsWith(LOCAL_KEY_PREFIX)) continue;
      this.snapshots.delete(key);
      this.lists.delete(key);
      this.refreshedAt.delete(key);
      this.inflight.delete(key);
    }
  }

  /** Wire the WSL home resolver (production: index.ts's getWslHomeAsync;
   *  tests: a canned map). */
  setWslHomeResolver(resolver: WslHomeResolver): void {
    this.resolveWslHome = resolver;
  }

  /** Override the WSL path mapping (tests only: join a temp dir instead of
   *  building a \\wsl$ UNC path). */
  setWslPathMapperForTests(mapper: WslPathMapper): void {
    this.mapWslPaths = mapper;
  }

  /** Sync peek. Returns undefined when the cache is stale or absent. */
  cached(target: SessionTarget, cwd: string): SessionEntry[] | undefined {
    const key = this.keyFor(target, cwd);
    const refreshedAt = this.refreshedAt.get(key);
    if (refreshedAt === undefined || Date.now() - refreshedAt > CACHE_TTL_MS) {
      return undefined;
    }
    return this.lists.get(key);
  }

  /** Async refresh of one cwd. Re-reads only changed files; emits on change.
   *  Concurrent calls for the same (target, cwd) share one in-flight parse so
   *  an older snapshot can never overwrite a newer one. */
  async refresh(target: SessionTarget, cwd: string): Promise<SessionEntry[]> {
    const key = this.keyFor(target, cwd);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.doRefresh(target, cwd);
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    }
  }

  private async doRefresh(target: SessionTarget, cwd: string): Promise<SessionEntry[]> {
    const key = this.keyFor(target, cwd);
    let dir: string;
    try {
      dir = await this.dirFor(target, cwd);
    } catch {
      // Target unresolvable (e.g. distro home lookup failed): keep the
      // previous list, don't clear it.
      return this.lists.get(key) ?? [];
    }
    let snap: DirSnapshotEntry[];
    try {
      if (!existsSync(dir)) {
        const oldList = this.lists.get(key);
        this.snapshots.set(key, []);
        this.lists.set(key, []);
        this.refreshedAt.set(key, Date.now());
        this.emitIfChanged(target, cwd, oldList, []);
        return [];
      }
      const names = await readdir(dir);
      const entries: DirSnapshotEntry[] = [];
      for (const f of names) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(dir, f);
        try {
          const s = await stat(full);
          entries.push({ path: full, mtime: s.mtimeMs, size: s.size });
        } catch {
          // File vanished between readdir and stat — skip it this scan.
        }
      }
      snap = entries;
    } catch {
      // Dir vanished or locked — keep the previous list, don't clear it.
      return this.lists.get(key) ?? [];
    }
    // Capture the PREVIOUS snapshot before overwriting it below.
    const prevSnap = this.snapshots.get(key);
    this.snapshots.set(key, snap);

    // Reuse cached entries for unchanged files; re-parse only the rest.
    const prevEntries = new Map((this.lists.get(key) ?? []).map((e) => [e.path, e]));
    const changedPaths = new Set<string>();
    for (const f of snap) {
      const old = prevSnap?.find((x) => x.path === f.path);
      if (!old || old.mtime !== f.mtime || old.size !== f.size) {
        changedPaths.add(f.path);
      }
    }

    const next: SessionEntry[] = [];
    for (const f of snap) {
      const cachedEntry = prevEntries.get(f.path);
      if (cachedEntry && !changedPaths.has(f.path)) {
        next.push(cachedEntry);
        continue;
      }
      let parsed: SessionEntry | null = null;
      try {
        const content = await readFile(f.path, "utf8");
        parsed = await parseSessionTextAsync(content, f.path, { mtime: f.mtime, size: f.size });
      } catch {
        parsed = null;
      }
      // Parse failure (file transiently locked mid-write): keep the previous
      // entry instead of dropping the session from the sidebar for one poll.
      next.push(parsed ?? cachedEntry ?? {
        path: f.path,
        sessionId: "",
        mtime: f.mtime,
        size: f.size,
        messageCount: 0,
        firstMessage: "",
        name: null,
      });
    }
    next.sort((a, b) => b.mtime - a.mtime);
    const oldList = this.lists.get(key);
    this.lists.set(key, next);
    this.refreshedAt.set(key, Date.now());
    this.emitIfChanged(target, cwd, oldList, next);
    return next;
  }

  /** Drop a cwd from the index (project removed / renamed). */
  remove(target: SessionTarget, cwd: string): void {
    const key = this.keyFor(target, cwd);
    this.snapshots.delete(key);
    this.lists.delete(key);
    this.refreshedAt.delete(key);
    this.listeners.delete(key);
  }

  /** Forget a session FILE's cache so the next session:list re-scans
   *  (deleted/renamed sessions must not resurrect from the cache). Accepts
   *  both local paths and \wsl$ UNC paths - the owning target is derived
   *  from the path prefix; the owning cwd is found by matching the encoded
   *  dir segment ("sessions/<enc>") against cached keys via encodeCwd.
   *  (Decoding the segment would be lossy: Windows drive-letter decoding is
   *  not an inverse of encodeCwd.) */
  invalidateFile(filePath: string): void {
    const normalized = filePath.replace(/\\/g, "/");
    const segments = normalized.split("/");
    const sessionsIdx = segments.lastIndexOf("sessions");
    if (sessionsIdx < 0 || sessionsIdx + 1 >= segments.length) return;
    const encoded = segments[sessionsIdx + 1];
    const wslMatch = normalized.match(/^\/\/wsl\$\/([^/]+)/i);
    for (const key of [...this.lists.keys()]) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      if (wslMatch) {
        if (parsed.target.kind !== "wsl" || parsed.target.distro !== wslMatch[1]) continue;
      } else if (parsed.target.kind !== "local") {
        continue;
      }
      if (encodeCwd(parsed.cwd) !== encoded) continue;
      this.remove(parsed.target, parsed.cwd);
    }
  }

  /** Split a cache key back into its target + cwd (the inverse of keyFor;
   *  \u0000 never occurs in distro names or cwds). */
  private parseKey(key: string): { target: SessionTarget; cwd: string } | null {
    if (key.startsWith("local\u0000")) return { target: localTarget(), cwd: key.slice(6) };
    if (key.startsWith("wsl\u0000")) {
      const rest = key.slice(4);
      const i = rest.indexOf("\u0000");
      if (i < 0) return null;
      return { target: wslTarget(rest.slice(0, i)), cwd: rest.slice(i + 1) };
    }
    return null;
  }

  onChange(target: SessionTarget, cwd: string, listener: SessionListener): () => void {
    const key = this.keyFor(target, cwd);
    const set = this.listeners.get(key) ?? new Set<SessionListener>();
    this.listeners.set(key, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Subscribe to changes for ANY (target, cwd) — index.ts forwards to the
   *  renderer, routing WSL lists to the remote-updated channel. */
  onAnyChange(listener: AnyChangeListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /** The 4s poll for one active (target, cwd). */
  startPolling(target: SessionTarget, cwd: string): void {
    this.stopPolling();
    this.polledTarget = target;
    this.polledCwd = cwd;
    void this.refresh(target, cwd);
    this.pollTimer = setInterval(() => {
      void this.refresh(target, cwd);
    }, POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polledTarget = { kind: "local" };
    this.polledCwd = null;
  }

  /** The polling scope: index.ts's change forwarder routes WSL lists to the
   *  right IPC channel by checking which (target, cwd) is being polled. */
  getPolledScope(): { target: SessionTarget; cwd: string } | null {
    if (this.polledCwd === null) return null;
    return { target: this.polledTarget, cwd: this.polledCwd };
  }

  private keyFor(target: SessionTarget, cwd: string): string {
    return `${targetKey(target)}\u0000${cwd}`;
  }

  /** Map (target, cwd) → session directory. Local: <agentDir>/sessions/<enc>.
   *  WSL: <mapper(distro, resolvedCwd)>\.pi\agent\sessions\<enc(resolved cwd)>
   *  (UNC in production; a plain dir in tests via the injected mapper). */
  private async dirFor(target: SessionTarget, cwd: string): Promise<string> {
    if (target.kind === "local") {
      return join(this.agentDir, "sessions", encodeCwd(cwd));
    }
    const home = await this.resolveWslHome(target.distro);
    const resolvedCwd = resolveWslPathCompat(home, cwd);
    const root = this.mapWslPaths(target.distro, home);
    return join(root, ".pi", "agent", "sessions", encodeCwd(resolvedCwd));
  }

  private emitIfChanged(target: SessionTarget, cwd: string, prev: SessionEntry[] | undefined, next: SessionEntry[]): void {
    const changed =
      !prev ||
      prev.length !== next.length ||
      prev.some((e, i) => {
        const n = next[i];
        return !n || e.path !== n.path || e.mtime !== n.mtime || e.size !== n.size || e.messageCount !== n.messageCount;
      });
    if (!changed) return;
    const set = this.listeners.get(this.keyFor(target, cwd));
    if (set) {
      for (const cb of set) {
        try {
          cb(next);
        } catch {
          /* listener must not break the poll */
        }
      }
    }
    for (const cb of this.anyListeners) {
      try {
        cb(target, cwd, next);
      } catch {
        /* listener must not break the poll */
      }
    }
  }
}

function resolveWslPathCompat(home: string, linuxPath: string): string {
  const p = linuxPath.trim();
  if (p === "~" || p === "") return home;
  if (p.startsWith("~/")) return home + "/" + p.slice(2);
  return p;
}

function wslToWinPathCompat(distro: string, linuxPath: string): string {
  const parts = linuxPath.trim().replace(/\//g, "\\").replace(/^\\/, "");
  return `\\\\wsl$\\${distro}\\${parts}`.replace(/\\+$/, "");
}
