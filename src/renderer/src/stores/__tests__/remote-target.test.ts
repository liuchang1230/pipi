// Connection targets: the tab-independent identity the sidebar hands to
// remote/WSL file + session calls. Pure module, so these pin the shapes main's
// resolveTarget expects ({tabId} | {remote} | {wsl}).
import { describe, expect, it } from "vitest";
import { projectProfile, projectTarget, serverProfile, targetKey, targetOfOrigin } from "../remote-target";
import type { ProjectGroup, RemoteServerGroup } from "../types";

const sshProject = (overrides: Partial<ProjectGroup> = {}): ProjectGroup => ({
  key: "p1",
  label: "proj",
  cwd: "/srv/proj",
  type: "remote",
  host: "h",
  user: "u",
  port: 2222,
  password: "pw",
  agentDir: "~/pi/u",
  sessions: [],
  ...overrides,
});

const wslProject = (overrides: Partial<ProjectGroup> = {}): ProjectGroup =>
  sshProject({ host: "Ubuntu", user: "", port: 0, password: undefined, agentDir: undefined, cwd: "/w/proj", ...overrides });

const server = (overrides: Partial<RemoteServerGroup> = {}): RemoteServerGroup => ({
  key: "u@h:2222",
  host: "h",
  user: "u",
  port: 2222,
  agentDir: "~/pi/u",
  password: "pw",
  path: "/srv",
  label: "u@h:2222",
  status: "connected",
  projects: [],
  ...overrides,
});

describe("projectProfile", () => {
  it("builds an SSH profile for a normal remote project", () => {
    expect(projectProfile(sshProject())).toEqual({
      host: "h",
      user: "u",
      port: 2222,
      path: "/srv/proj",
      password: "pw",
      agentDir: "~/pi/u",
    });
  });

  it("treats port 0 as WSL (distro + path, no credentials)", () => {
    expect(projectProfile(wslProject())).toEqual({ distro: "Ubuntu", path: "/w/proj" });
  });
});

describe("projectTarget / targetKey", () => {
  it("wraps an SSH profile and keys it by the profile identity", () => {
    const target = projectTarget(sshProject());
    expect(target).toEqual({ remote: expect.objectContaining({ host: "h", user: "u", port: 2222 }) });
    expect(targetKey(target)).toBe("u@h:2222[~/pi/u]");
  });

  it("keeps a tab id addressable and prefers it for the cache key", () => {
    expect(targetKey("t-1")).toBe("t-1");
    expect(targetKey({ tabId: "t-1", remote: { host: "h", user: "u" } })).toBe("t-1");
  });

  it("keys WSL profiles distinctly so two distros never collide", () => {
    expect(targetKey(projectTarget(wslProject()))).toBe("wsl:Ubuntu");
    expect(targetKey(projectTarget(wslProject({ host: "Debian" })))).not.toBe("wsl:Ubuntu");
  });
});

describe("serverProfile", () => {
  it("carries the credentials the probe + login dialog need", () => {
    expect(serverProfile(server())).toEqual({
      host: "h",
      user: "u",
      port: 2222,
      path: "/srv",
      password: "pw",
      agentDir: "~/pi/u",
    });
  });
});

describe("targetOfOrigin", () => {
  it("prefers a profile over the tab id (a profile survives tab churn)", () => {
    expect(targetOfOrigin({ tabId: "t-1", remote: { host: "h", user: "u" } })).toEqual({ remote: { host: "h", user: "u" } });
    expect(targetOfOrigin({ tabId: "t-1" })).toBe("t-1");
    expect(targetOfOrigin({ wsl: { distro: "Ubuntu" } })).toEqual({ wsl: { distro: "Ubuntu" } });
    expect(targetOfOrigin(null)).toBeUndefined();
  });
});
