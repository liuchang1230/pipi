import { describe, expect, it } from "vitest";
import { groupRemoteServers, buildRemoteKey, remoteSessionCacheKey } from "../remote-servers";
import type { ProjectListItem, RemoteHistoryItem, TabInfo } from "../types";

const empty = {
  projectSessions: {},
  remoteSessions: {},
  projectErrors: {},
  projectDiagnostics: {},
  remoteHydration: { phase: "idle" as const },
};

const history = (items: RemoteHistoryItem[]) => items;
const projects = (items: ProjectListItem[]) => items;
const tabs = (items: TabInfo[]) => items;

function sshTab(overrides: Partial<TabInfo>): TabInfo {
  return {
    id: "t1",
    cwd: ".",
    title: "root@h1 · 连接",
    isRemote: true,
    remoteKey: "root@h1:22",
    remoteHost: "h1",
    remoteUser: "root",
    remotePort: 22,
    pi: true,
    mode: "pty",
    ...overrides,
  };
}

describe("remote key helpers", () => {
  it("buildRemoteKey matches the main-process format", () => {
    expect(buildRemoteKey("h", "u", 22)).toBe("u@h:22");
    expect(buildRemoteKey("h", "u", 2222)).toBe("u@h:2222");
    expect(buildRemoteKey("h", "u", 22, "~/pi/agent")).toBe("u@h:22[~/pi/agent]");
    expect(buildRemoteKey()).toBe("@:22");
  });

  it("remoteSessionCacheKey includes agentDir", () => {
    expect(remoteSessionCacheKey("t1", "/a/b")).toBe("t1::/a/b");
    expect(remoteSessionCacheKey("t1", "/a/b", "~/x")).not.toBe(remoteSessionCacheKey("t1", "/a/b", "~/y"));
  });
});

describe("groupRemoteServers", () => {
  it("derives a server from saved history alone (unconnected)", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "h1", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "root@h1:22", host: "h1", user: "root", port: 22, status: "disconnected", label: "root@h1" });
    expect(groups[0].projects).toEqual([]);
  });

  it("merges the same server from history + project + tab into one node", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", port: 22, path: "/srv/app", password: "pw" },
      ]),
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [sshTab({ sshState: "ready" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "root@h1:22",
      status: "connected",
      tabId: "t1",
      password: "pw", // picked up from the project when history has none
      label: "root@h1",
    });
    expect(groups[0].projects).toHaveLength(1);
    expect(groups[0].projects[0]).toMatchObject({ key: "p1", cwd: "/srv/app", disabled: false });
  });

  it("keeps agentDir variants as separate servers", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([
        { id: "a", host: "h1", user: "root", port: 22, updatedAt: 1 },
        { id: "b", host: "h1", user: "root", port: 22, agentDir: "~/pi-czy/agent", updatedAt: 2 },
      ]),
      tabs: [],
    });
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key).sort()).toEqual(["root@h1:22", "root@h1:22[~/pi-czy/agent]"]);
  });

  it("marks connected and prefers the connection shell tab as the activation target", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [
        sshTab({ id: "session", title: "my session", mode: "rpc" }),
        sshTab({ id: "shell", title: "root@h1 · 连接" }),
      ],
    });
    expect(groups[0].status).toBe("connected");
    expect(groups[0].tabId).toBe("shell");
  });

  it("groups each server's projects under its own node", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "a", host: "h1", user: "root", port: 22, path: "/srv/a" },
        { id: "p2", type: "remote", name: "b", host: "h2", user: "admin", port: 2222, path: "/app/b" },
        { id: "p3", type: "remote", name: "a2", host: "h1", user: "root", port: 22, path: "/srv/a2" },
      ]),
      remoteHistory: [],
      tabs: [sshTab({ id: "t1", remoteKey: "root@h1:22", remoteHost: "h1", remoteUser: "root", sshState: "ready" })],
    });
    expect(groups).toHaveLength(2);
    const h1 = groups.find((g) => g.key === "root@h1:22")!;
    const h2 = groups.find((g) => g.key === "admin@h2:2222")!;
    expect(h1.projects.map((p) => p.key)).toEqual(["p1", "p3"]);
    expect(h1.status).toBe("connected");
    expect(h2.projects.map((p) => p.key)).toEqual(["p2"]);
    expect(h2.status).toBe("disconnected");
    expect(h2.projects[0].disabled).toBe(true);
  });

  it("formats labels: port omitted at 22, shown otherwise, agentDir appended", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([
        { id: "a", host: "h1", user: "root", port: 22, updatedAt: 1 },
        { id: "b", host: "h2", user: "admin", port: 2222, updatedAt: 1 },
        { id: "c", host: "h3", user: "deploy", port: 22, agentDir: "~/iso", updatedAt: 1 },
      ]),
      tabs: [],
    });
    const labels = groups.map((g) => g.label);
    expect(labels).toContain("root@h1");
    expect(labels).toContain("admin@h2:2222");
    expect(labels).toContain("deploy@h3 · ~/iso");
  });

  it("sorts servers by label", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([
        { id: "z", host: "z", user: "root", port: 22, updatedAt: 1 },
        { id: "a", host: "a", user: "root", port: 22, updatedAt: 1 },
        { id: "m", host: "m", user: "root", port: 22, updatedAt: 1 },
      ]),
      tabs: [],
    });
    expect(groups.map((g) => g.label)).toEqual(["root@a", "root@m", "root@z"]);
  });

  it("fills password/path gaps from history when the project lacks them", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", port: 22, path: "/srv/app" },
      ]),
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, password: "secret", path: "/srv/app", updatedAt: 1 }]),
      tabs: [],
    });
    expect(groups[0].password).toBe("secret");
    expect(groups[0].path).toBe("/srv/app");
  });

  it("ignores WSL projects and WSL tabs", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "w1", type: "wsl", name: "Ubuntu", distro: "Ubuntu", path: "~/proj" },
        { id: "r1", type: "remote", name: "app", host: "h1", user: "root", port: 22, path: "/srv/app" },
      ]),
      remoteHistory: [],
      tabs: [
        { id: "wtab", cwd: ".", title: "Ubuntu", isRemote: true, isWsl: true, wslDistro: "Ubuntu", pi: true, mode: "rpc" },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("root@h1:22");
    expect(groups[0].status).toBe("disconnected");
  });

  it("seeds a server from an open tab alone (no history/project)", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: [],
      tabs: [sshTab({ id: "t1", sshState: "ready" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "root@h1:22", host: "h1", user: "root", status: "connected", tabId: "t1" });
  });

  it("seeds an agentDir variant from a tab with remoteAgentDir", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: [],
      tabs: [sshTab({ id: "t1", remoteKey: "root@h1:22[~/iso]", remoteAgentDir: "~/iso", sshState: "ready" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("root@h1:22[~/iso]");
    expect(groups[0].agentDir).toBe("~/iso");
    expect(groups[0].status).toBe("connected");
  });

  it("falls back to a session tab when no connection shell tab exists", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [sshTab({ id: "s1", title: "my session", mode: "rpc" })],
    });
    expect(groups[0].status).toBe("connected");
    expect(groups[0].tabId).toBe("s1");
  });

  it("reports connecting while the connection tab has not confirmed yet", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      // Connection tab exists but no ready marker yet (e.g. at a password prompt).
      tabs: [sshTab({ id: "t1" })],
    });
    expect(groups[0].status).toBe("connecting");
    expect(groups[0].tabId).toBe("t1");
  });

  it("reports connected once the ready marker arrived", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [sshTab({ id: "t1", sshState: "ready" })],
    });
    expect(groups[0].status).toBe("connected");
  });

  it("reports failed when ssh exited before the ready marker", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [sshTab({ id: "t1", sshState: "failed" })],
    });
    expect(groups[0].status).toBe("failed");
  });

  it("an open pi session tab overrides a pending connection shell tab", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [
        sshTab({ id: "shell", title: "root@h1 · 连接" }), // pending
        sshTab({ id: "session", title: "my session", mode: "rpc" }), // pi is running → connected
      ],
    });
    expect(groups[0].status).toBe("connected");
    expect(groups[0].tabId).toBe("shell"); // activation target stays the shell
  });

  it("keeps projects disabled while the server is not confirmed connected", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", port: 22, path: "/srv/app" },
      ]),
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [sshTab({ id: "t1" })], // connecting — no ready marker yet
    });
    expect(groups[0].status).toBe("connecting");
    expect(groups[0].projects[0].disabled).toBe(true);
  });

  it("prefers a ready connection tab over a failed one as the activation target", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [
        sshTab({ id: "dead", sshState: "failed" }), // zombie lingers in the renderer briefly
        sshTab({ id: "live", sshState: "ready" }),
      ],
    });
    expect(groups[0].status).toBe("connected");
    expect(groups[0].tabId).toBe("live");
  });

  it("a session tab overrides a failed shell tab for connectivity", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: [],
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [
        sshTab({ id: "dead", sshState: "failed" }),
        sshTab({ id: "session", title: "my session", mode: "rpc" }),
      ],
    });
    expect(groups[0].status).toBe("connected");
  });

  it("normalizes a project with undefined port onto the history server", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", path: "/srv/app" }, // port undefined → 22
      ]),
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("root@h1:22");
    expect(groups[0].projects.map((p) => p.key)).toEqual(["p1"]);
  });

  it("does not fold a port-2222 project onto a port-22 server", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", port: 2222, path: "/srv/app" },
      ]),
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, updatedAt: 1 }]),
      tabs: [],
    });
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === "root@h1:2222")?.projects).toHaveLength(1);
    expect(groups.find((g) => g.key === "root@h1:22")?.projects).toHaveLength(0);
  });

  it("prefers the history password over a project's cached one", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", port: 22, path: "/srv/app", password: "old" },
      ]),
      remoteHistory: history([{ id: "rh", host: "h1", user: "root", port: 22, password: "new", updatedAt: 1 }]),
      tabs: [],
    });
    expect(groups[0].password).toBe("new");
  });

  it("propagates the hydration phase for the hydrating project", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", port: 22, path: "/srv/app" },
      ]),
      remoteHistory: [],
      tabs: [sshTab({ id: "t1", sshState: "ready" })],
      remoteHydration: { phase: "loading", tabId: "t1", remoteCwd: "/srv/app" },
    });
    expect(groups[0].projects[0].hydrationPhase).toBe("loading");
  });

  it("leaves hydration idle for a different tab/path", () => {
    const groups = groupRemoteServers({
      ...empty,
      projects: projects([
        { id: "p1", type: "remote", name: "app", host: "h1", user: "root", port: 22, path: "/srv/app" },
      ]),
      remoteHistory: [],
      tabs: [sshTab({ id: "t1", sshState: "ready" })],
      remoteHydration: { phase: "loading", tabId: "other", remoteCwd: "/srv/app" },
    });
    expect(groups[0].projects[0].hydrationPhase).toBe("idle");
  });
});
