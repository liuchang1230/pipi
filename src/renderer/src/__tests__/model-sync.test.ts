// modelSyncAppliesTo — the pure predicate deciding which mounted chat tabs
// hot-sync after a model-config save. Covers the full target×tab matrix,
// including the local-rpc fallback (SDK backend disabled), port defaults and
// agentDir normalization.
import { describe, expect, it } from "vitest";
import { modelSyncAppliesTo, normalizeAgentDir, type ModelSyncTab } from "../model-sync";

const LOCAL_SDK: ModelSyncTab = { mode: "sdk" };
const LOCAL_RPC: ModelSyncTab = { mode: "rpc", isRemote: false, isWsl: false };
const LOCAL_PTY: ModelSyncTab = { mode: "pty" };
const wslTab = (distro: string): ModelSyncTab => ({ mode: "rpc", isRemote: true, isWsl: true, wslDistro: distro });
const remoteTab = (over: Partial<ModelSyncTab> = {}): ModelSyncTab => ({
  mode: "rpc",
  isRemote: true,
  isWsl: false,
  remoteHost: "srv1",
  remoteUser: "alice",
  remotePort: 22,
  ...over,
});

describe("normalizeAgentDir", () => {
  it("trims and strips trailing slashes", () => {
    expect(normalizeAgentDir("  ~/pi-agent/  ")).toBe("~/pi-agent");
    expect(normalizeAgentDir("/srv/pi///")).toBe("/srv/pi");
  });

  it("treats undefined and empty as the same default", () => {
    expect(normalizeAgentDir(undefined)).toBe("");
    expect(normalizeAgentDir("")).toBe("");
  });
});

describe("modelSyncAppliesTo — local target", () => {
  const target = { kind: "local" } as const;

  it("reaches SDK chat tabs", () => {
    expect(modelSyncAppliesTo(target, LOCAL_SDK)).toBe(true);
  });

  it("reaches local RPC chat tabs (SDK backend disabled fallback)", () => {
    expect(modelSyncAppliesTo(target, LOCAL_RPC)).toBe(true);
  });

  it("never reaches pty TUI tabs, remote or WSL tabs", () => {
    expect(modelSyncAppliesTo(target, LOCAL_PTY)).toBe(false);
    expect(modelSyncAppliesTo(target, remoteTab())).toBe(false);
    expect(modelSyncAppliesTo(target, wslTab("Ubuntu"))).toBe(false);
  });
});

describe("modelSyncAppliesTo — WSL target", () => {
  const target = { kind: "wsl", distro: "Ubuntu" } as const;

  it("reaches the matching distro's chat tab", () => {
    expect(modelSyncAppliesTo(target, wslTab("Ubuntu"))).toBe(true);
  });

  it("does not reach other distros or SSH tabs", () => {
    expect(modelSyncAppliesTo(target, wslTab("Debian"))).toBe(false);
    expect(modelSyncAppliesTo(target, remoteTab())).toBe(false);
    expect(modelSyncAppliesTo(target, LOCAL_SDK)).toBe(false);
  });
});

describe("modelSyncAppliesTo — remote target", () => {
  const target = { kind: "remote", host: "srv1", user: "alice", port: 22, agentDir: undefined } as const;

  it("matches on host/user/port", () => {
    expect(modelSyncAppliesTo(target, remoteTab())).toBe(true);
    expect(modelSyncAppliesTo(target, remoteTab({ remotePort: 2222 }))).toBe(false);
    expect(modelSyncAppliesTo(target, remoteTab({ remoteHost: "srv2" }))).toBe(false);
    expect(modelSyncAppliesTo(target, remoteTab({ remoteUser: "bob" }))).toBe(false);
  });

  it("defaults an absent tab port to 22", () => {
    expect(modelSyncAppliesTo(target, remoteTab({ remotePort: undefined }))).toBe(true);
  });

  it("compares agentDir normalized (trim + trailing slash)", () => {
    const t = { ...target, agentDir: "~/pi-agent" };
    expect(modelSyncAppliesTo(t, remoteTab({ remoteAgentDir: "~/pi-agent/" }))).toBe(true);
    expect(modelSyncAppliesTo(t, remoteTab({ remoteAgentDir: " ~/pi-agent " }))).toBe(true);
    expect(modelSyncAppliesTo(t, remoteTab({ remoteAgentDir: "~/other" }))).toBe(false);
  });

  it("treats an empty agentDir override as the default profile", () => {
    expect(modelSyncAppliesTo(target, remoteTab({ remoteAgentDir: "" }))).toBe(true);
    expect(modelSyncAppliesTo(target, remoteTab({ remoteAgentDir: "~/x" }))).toBe(false);
  });

  it("never reaches WSL or local tabs", () => {
    expect(modelSyncAppliesTo(target, wslTab("srv1"))).toBe(false);
    expect(modelSyncAppliesTo(target, LOCAL_SDK)).toBe(false);
  });
});

describe("modelSyncAppliesTo — degenerate input", () => {
  it("returns false for a missing tab", () => {
    expect(modelSyncAppliesTo({ kind: "local" }, undefined)).toBe(false);
  });
});
