// SSH connection status per server, keyed by connection profile (remoteKey).
//
// Connecting is a PROBE, not a tab: main runs one ssh2 auth round trip and
// reports ready / need-password / failed. The sidebar dot renders this state
// next to the address, and "need-password" is what opens the login dialog —
// no terminal tab is involved anywhere in the connect path.
import { create } from "zustand";
import { buildRemoteKey } from "./remote-servers";
import type { ServerStatus } from "./types";
import type { RemoteProfileTarget } from "./remote-target";

export interface RemoteStatusEntry {
  status: ServerStatus;
  /** Auth failed for lack of a usable credential: the login dialog owns it. */
  needPassword?: boolean;
  error?: string;
  checkedAt: number;
  /** Profile main reported with the state (no password) — enough to open the
   *  login dialog without looking the server up in the sidebar. */
  profile?: RemoteProfileTarget;
}

/** State event emitted by main (SFTP breaker or probe). */
export interface RemoteStatusEvent {
  remoteKey: string;
  status: ServerStatus;
  needPassword?: boolean;
  error?: string;
  profile?: { host: string; user: string; port?: number; agentDir?: string };
}

export interface RemoteProbeOutcome {
  ok: boolean;
  needPassword: boolean;
  error?: string;
}

export interface RemoteLoginRequest {
  remote: RemoteProfileTarget;
  error?: string;
  /** Stable matching key: the event's remoteKey for main-driven requests, the
   *  profile key for click-driven ones. Stored (not recomputed) so dismissal
   *  and auto-close can never disagree with the producer's key format. */
  key: string;
}

interface RemoteStoreState {
  byKey: Record<string, RemoteStatusEntry>;
  probing: Record<string, boolean>;
  /** Open login dialog request (null = closed). Raised by main's status
   *  events AND by the click path, so there is exactly one dialog. */
  loginRequest: RemoteLoginRequest | null;
  loginBusy: boolean;
  /** Servers whose login dialog the user dismissed: never re-open unasked
   *  until that server connects again (a background poll must not wage a
   *  modal war). */
  dismissed: Record<string, boolean>;
  setStatus: (key: string, entry: RemoteStatusEntry | null) => void;
  /** Probe one server (no tab). Records the resulting status either way. */
  probe: (remote: RemoteProfileTarget, options?: { remember?: boolean }) => Promise<RemoteProbeOutcome>;
  /** Probe unless this profile was proven connected moments ago. Expansion and
   *  row clicks go through this: a stale/wrong saved password must still
   *  surface the login dialog (never assume "it connected last time"). */
  probeIfNeeded: (remote: RemoteProfileTarget, options?: { remember?: boolean; freshMs?: number }) => Promise<RemoteProbeOutcome>;
  /** Drop a server's status (server deleted / history removed). */
  forget: (key: string) => void;
  /** Apply a state event pushed by main (SFTP breaker / probe). */
  applyStatusEvent: (ev: RemoteStatusEvent) => void;
  /** Show the login dialog (click path). */
  requestLogin: (remote: RemoteProfileTarget, error?: string) => void;
  /** Close it without connecting (remembers the dismissal). */
  dismissLogin: () => void;
  /** Try the typed password: probe + remember. Resolves true on success. */
  submitLogin: (password: string, remember: boolean) => Promise<boolean>;
}

/** How long a successful probe is trusted before re-probing on the click path. */
export const REMOTE_PROBE_FRESH_MS = 60_000;

const profileKey = (remote: RemoteProfileTarget): string =>
  buildRemoteKey(remote.host, remote.user, remote.port, remote.agentDir);

export const useRemoteStore = create<RemoteStoreState>()((set, get) => ({
  byKey: {},
  probing: {},
  loginRequest: null,
  loginBusy: false,
  dismissed: {},
  requestLogin: (remote, error) =>
    set((s) => {
      const key = profileKey(remote);
      return { loginRequest: { remote, error, key }, dismissed: { ...s.dismissed, [key]: false } };
    }),
  dismissLogin: () => {
    const request = get().loginRequest;
    set((s) => ({
      loginRequest: null,
      dismissed: request ? { ...s.dismissed, [request.key]: true } : s.dismissed,
    }));
  },
  submitLogin: async (password, remember) => {
    const request = get().loginRequest;
    if (!request) return false;
    set({ loginBusy: true });
    try {
      const remote = { ...request.remote, password };
      const outcome = await get().probe(remote, { remember });
      if (outcome.ok) {
        // Successfully logged in. `probe(..., { remember })` already persisted
        // the password when the user opted in; a one-off login leaves history
        // untouched (saveRemoteHistory is non-destructive anyway).
        set({ loginRequest: null, loginBusy: false });
        return true;
      }
      // Keep the dialog open with the reason the retry failed.
      set({ loginRequest: { ...request, error: outcome.error || "认证失败，请重新输入密码" }, loginBusy: false });
      return false;
    } catch (error) {
      set({ loginBusy: false, loginRequest: { ...request, error: error instanceof Error ? error.message : "登录失败" } });
      return false;
    }
  },
  setStatus: (key, entry) =>
    set((s) => {
      const byKey = { ...s.byKey };
      if (entry) byKey[key] = entry;
      else delete byKey[key];
      return { byKey };
    }),
  forget: (key) => get().setStatus(key, null),
  applyStatusEvent: (ev) => {
    const key = ev.remoteKey;
    // A probe in flight owns the entry: its own result (with the status the
    // user just triggered) must not be overwritten by a breaker event that
    // raced it.
    if (!get().probing[key]) {
      set((s) => {
        const prev = s.byKey[key]?.profile;
        // The profile password is the last credential a successful probe
        // verified (typed one-off logins live only here, never on disk unless
        // "remember"). Keep it across "connected"/transport events so a login
        // isn't forgotten mid-session; drop it only on an auth failure, which
        // proves that credential is stale.
        const keepPassword = !ev.needPassword && !!prev?.password;
        const profile = ev.profile
          ? {
              host: ev.profile.host,
              user: ev.profile.user,
              port: ev.profile.port,
              agentDir: ev.profile.agentDir,
              ...(keepPassword ? { password: prev?.password } : {}),
            }
          : prev;
        return {
          byKey: {
            ...s.byKey,
            [key]: {
              status: ev.status,
              needPassword: ev.needPassword,
              error: ev.error,
              checkedAt: Date.now(),
              profile,
            },
          },
        };
      });
    }
    if (ev.status === "connected") {
      // Connected again: close a dialog for this profile and re-arm the
      // one-shot dismissal so a future failure prompts again.
      const request = get().loginRequest;
      if (request && request.key === key) set({ loginRequest: null });
      set((s) => {
        if (!s.dismissed[key]) return {};
        const dismissed = { ...s.dismissed };
        delete dismissed[key];
        return { dismissed };
      });
      return;
    }
    // The point of this event: main discovered that this server needs a
    // password (or is unreachable) regardless of which path noticed. Ask the
    // user instead of letting reads fail silently into "正在加载…".
    if (!ev.needPassword || !ev.profile) return;
    if (get().probing[key] || get().dismissed[key] || get().loginRequest) return;
    set({
      loginRequest: {
        remote: { host: ev.profile.host, user: ev.profile.user, port: ev.profile.port, agentDir: ev.profile.agentDir },
        error: ev.error,
        key,
      },
    });
  },
  probeIfNeeded: async (remote, options) => {
    const entry = get().byKey[profileKey(remote)];
    const freshMs = options?.freshMs ?? REMOTE_PROBE_FRESH_MS;
    if (entry?.status === "connected" && Date.now() - entry.checkedAt < freshMs) {
      return { ok: true, needPassword: false };
    }
    return get().probe(remote, options);
  },
  probe: async (remote, options) => {
    const key = profileKey(remote);
    set((s) => ({
      probing: { ...s.probing, [key]: true },
      byKey: { ...s.byKey, [key]: { status: "connecting", checkedAt: Date.now() } },
    }));
    try {
      const res = await window.api.remote.probe({
        host: remote.host,
        user: remote.user,
        port: remote.port,
        password: remote.password,
        agentDir: remote.agentDir,
        // `path` is irrelevant for auth, and the probe must not be influenced
        // by whichever directory the sidebar happens to be browsing.
      });
      if (res.status === "ready") {
        set((s) => {
          const probing = { ...s.probing };
          delete probing[key];
          return { probing, byKey: { ...s.byKey, [key]: { status: "connected", checkedAt: Date.now(), profile: { host: remote.host, user: remote.user, port: remote.port, agentDir: remote.agentDir, password: remote.password } } } };
        });
        if (options?.remember) {
          // Persist the profile (password included) so the next connect is
          // silent — same store the tab-based connect path writes.
          await window.api.remote.saveHistory({
            host: remote.host,
            user: remote.user,
            port: remote.port,
            password: remote.password,
            path: remote.path,
            agentDir: remote.agentDir,
          }).catch(() => undefined);
        }
        return { ok: true, needPassword: false };
      }
      const needPassword = res.status === "need-password";
      set((s) => {
        const probing = { ...s.probing };
        delete probing[key];
        return {
          probing,
          byKey: {
            ...s.byKey,
            [key]: {
              status: needPassword ? "disconnected" : "failed",
              needPassword,
              error: res.error,
              checkedAt: Date.now(),
              profile: { host: remote.host, user: remote.user, port: remote.port, agentDir: remote.agentDir },
            },
          },
        };
      });
      return { ok: false, needPassword, error: res.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((s) => {
        const probing = { ...s.probing };
        delete probing[key];
        return { probing, byKey: { ...s.byKey, [key]: { status: "failed", error: message, checkedAt: Date.now() } } };
      });
      return { ok: false, needPassword: false, error: message };
    }
  },
}));

/** Profile key helper for callers that need the map key without probing. */
export const remoteProfileKey = profileKey;
