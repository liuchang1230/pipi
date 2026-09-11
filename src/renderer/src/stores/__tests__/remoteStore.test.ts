// The connect path is a probe, not a tab: these pin the status mapping the
// sidebar dot and login dialog depend on.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoteStore, REMOTE_PROBE_FRESH_MS } from "../remoteStore";

type ProbeResult = { status: "ready" | "need-password" | "failed"; error?: string; key: string };

function makeApi(probe: ProbeResult) {
  const api = {
    remote: {
      probe: vi.fn(async () => probe),
      saveHistory: vi.fn(async () => []),
    },
  };
  (globalThis as any).window = { api };
  return api;
}

beforeEach(() => {
  useRemoteStore.setState({ byKey: {}, probing: {}, loginRequest: null, loginBusy: false, dismissed: {} });
});

describe("remoteStore.probe", () => {
  it("records a successful probe as connected and remembers the profile when asked", async () => {
    const api = makeApi({ status: "ready", key: "u@h:22" });
    const outcome = await useRemoteStore.getState().probe({ host: "h", user: "u", port: 22, password: "pw" }, { remember: true });
    expect(outcome).toEqual({ ok: true, needPassword: false });
    expect(useRemoteStore.getState().byKey["u@h:22"].status).toBe("connected");
    expect(useRemoteStore.getState().probing).toEqual({});
    // Remembering writes the credential store the NEXT probe reads.
    expect(api.remote.saveHistory).toHaveBeenCalledWith(expect.objectContaining({ host: "h", user: "u", password: "pw" }));
  });

  it("maps an auth failure to the login-dialog state (not a hard failure)", async () => {
    makeApi({ status: "need-password", key: "u@h:22" });
    const outcome = await useRemoteStore.getState().probe({ host: "h", user: "u" });
    expect(outcome).toEqual({ ok: false, needPassword: true, error: undefined });
    const entry = useRemoteStore.getState().byKey["u@h:22"];
    expect(entry.status).toBe("disconnected");
    expect(entry.needPassword).toBe(true);
  });

  it("maps a transport failure to failed and keeps the reason", async () => {
    makeApi({ status: "failed", error: "connect ECONNREFUSED", key: "u@h:22" });
    const outcome = await useRemoteStore.getState().probe({ host: "h", user: "u" });
    expect(outcome.ok).toBe(false);
    expect(outcome.needPassword).toBe(false);
    expect(useRemoteStore.getState().byKey["u@h:22"]).toMatchObject({ status: "failed", error: "connect ECONNREFUSED" });
  });

  it("survives a rejected probe without stranding the connecting state", async () => {
    const api = { remote: { probe: vi.fn(async () => { throw new Error("ipc gone"); }), saveHistory: vi.fn() } };
    (globalThis as any).window = { api };
    const outcome = await useRemoteStore.getState().probe({ host: "h", user: "u" });
    expect(outcome).toEqual({ ok: false, needPassword: false, error: "ipc gone" });
    expect(useRemoteStore.getState().probing).toEqual({});
    expect(useRemoteStore.getState().byKey["u@h:22"].status).toBe("failed");
  });
});

describe("remoteStore.probeIfNeeded", () => {
  it("skips the round trip for a profile that connected moments ago", async () => {
    const api = makeApi({ status: "ready", key: "u@h:22" });
    await useRemoteStore.getState().probe({ host: "h", user: "u" });
    const outcome = await useRemoteStore.getState().probeIfNeeded({ host: "h", user: "u" });
    expect(outcome).toEqual({ ok: true, needPassword: false });
    expect(api.remote.probe).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the freshness window lapses", async () => {
    const api = makeApi({ status: "ready", key: "u@h:22" });
    await useRemoteStore.getState().probe({ host: "h", user: "u" });
    await useRemoteStore.getState().probeIfNeeded({ host: "h", user: "u" }, { freshMs: 0 });
    expect(api.remote.probe).toHaveBeenCalledTimes(2);
  });

  it("never skips a profile whose last probe did not connect", async () => {
    const api = makeApi({ status: "need-password", key: "u@h:22" });
    await useRemoteStore.getState().probe({ host: "h", user: "u" });
    await useRemoteStore.getState().probeIfNeeded({ host: "h", user: "u" });
    expect(api.remote.probe).toHaveBeenCalledTimes(2);
  });

  it("exports a sane freshness window", () => {
    expect(REMOTE_PROBE_FRESH_MS).toBeGreaterThan(0);
  });
});

// The bug that motivated these: server needs a password, the app showed
// "connected", and every session row sat on "正在加载会话信息" forever. Main now
// reports the auth failure it discovers (SFTP breaker / probe) — the dot flips
// and the login dialog opens without the user having to click anything again.
describe("remoteStore status events (auto login prompt)", () => {
  const EV = {
    remoteKey: "u@h:22",
    status: "disconnected" as const,
    needPassword: true,
    error: "认证失败：需要密码或密钥未授权",
    profile: { host: "h", user: "u", port: 22, agentDir: "~/pi" },
  };

  it("flips the dot and opens the login dialog with the reported reason", () => {
    useRemoteStore.getState().applyStatusEvent(EV);
    expect(useRemoteStore.getState().byKey["u@h:22"]).toMatchObject({ status: "disconnected", needPassword: true });
    const request = useRemoteStore.getState().loginRequest;
    expect(request?.remote).toMatchObject({ host: "h", user: "u", port: 22, agentDir: "~/pi" });
    expect(request?.error).toContain("认证失败");
  });

  it("does not fight a probe that is still in flight", () => {
    useRemoteStore.setState({ probing: { "u@h:22": true } });
    useRemoteStore.getState().applyStatusEvent(EV);
    expect(useRemoteStore.getState().byKey["u@h:22"]).toBeUndefined();
    expect(useRemoteStore.getState().loginRequest).toBeNull();
  });

  it("keeps a typed password across a non-auth status event (one-off login survives background updates)", () => {
    // Simulate a successful one-off login: profile now carries the typed password.
    useRemoteStore.setState({ byKey: { "u@h:22": { status: "connected", checkedAt: Date.now(), profile: { host: "h", user: "u", port: 22, password: "typed-pw" } } } });
    useRemoteStore.getState().applyStatusEvent({ remoteKey: "u@h:22", status: "connected", profile: { host: "h", user: "u", port: 22 } });
    expect(useRemoteStore.getState().byKey["u@h:22"].profile?.password).toBe("typed-pw");
  });

  it("respects a dismissed dialog instead of re-prompting on every poll", () => {
    useRemoteStore.getState().applyStatusEvent(EV);
    useRemoteStore.getState().dismissLogin();
    expect(useRemoteStore.getState().loginRequest).toBeNull();
    useRemoteStore.getState().applyStatusEvent(EV);
    expect(useRemoteStore.getState().loginRequest).toBeNull();
  });

  it("re-arms the prompt once the server connects again", () => {
    useRemoteStore.getState().applyStatusEvent(EV);
    useRemoteStore.getState().dismissLogin();
    useRemoteStore.getState().applyStatusEvent({ ...EV, status: "connected", needPassword: false, error: undefined });
    expect(useRemoteStore.getState().byKey["u@h:22"].status).toBe("connected");
    useRemoteStore.getState().applyStatusEvent(EV);
    expect(useRemoteStore.getState().loginRequest).not.toBeNull();
  });

  it("keeps only one dialog at a time when several servers fail", () => {
    useRemoteStore.getState().applyStatusEvent(EV);
    useRemoteStore.getState().applyStatusEvent({ ...EV, remoteKey: "u@h2:22", profile: { host: "h2", user: "u", port: 22 } });
    expect(useRemoteStore.getState().loginRequest?.remote.host).toBe("h");
  });

  it("closes the dialog itself when that profile connects", () => {
    useRemoteStore.getState().applyStatusEvent(EV);
    useRemoteStore.getState().applyStatusEvent({ ...EV, status: "connected", needPassword: false });
    expect(useRemoteStore.getState().loginRequest).toBeNull();
  });
});

describe("remoteStore.submitLogin", () => {
  it("probes with the typed password and remembers it on success", async () => {
    const api = makeApi({ status: "ready", key: "u@h:22" });
    useRemoteStore.getState().requestLogin({ host: "h", user: "u", port: 22 });
    const ok = await useRemoteStore.getState().submitLogin("pw", true);
    expect(ok).toBe(true);
    expect(api.remote.probe).toHaveBeenCalledWith(expect.objectContaining({ host: "h", user: "u", password: "pw", port: 22 }));
    expect(api.remote.saveHistory).toHaveBeenCalledTimes(1);
    expect(useRemoteStore.getState().loginRequest).toBeNull();
    expect(useRemoteStore.getState().byKey["u@h:22"].status).toBe("connected");
  });

  it("keeps the dialog open with the new reason when the retry fails", async () => {
    makeApi({ status: "need-password", key: "u@h:22" });
    useRemoteStore.getState().requestLogin({ host: "h", user: "u" }, "第一次失败");
    const ok = await useRemoteStore.getState().submitLogin("wrong", false);
    expect(ok).toBe(false);
    expect(useRemoteStore.getState().loginRequest?.error).toBeTruthy();
    expect(useRemoteStore.getState().loginBusy).toBe(false);
  });
});
