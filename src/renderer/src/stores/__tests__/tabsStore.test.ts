// Tab store: applyActive atomicity + tab lifecycle actions.
// window.api is stubbed per test so no Electron runtime is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTabsStore } from "../tabsStore";
import type { TabInfo } from "../types";

function makeApi() {
  const api = {
    tab: {
      create: vi.fn(async () => "tab-1"),
      close: vi.fn(async () => true),
      activate: vi.fn(async () => true),
    },
    remote: {
      getInfo: vi.fn(async () => null as { host: string; user: string; port?: number; path?: string; password?: string; isWsl?: boolean } | null),
    },
  };
  (globalThis as any).window = { api };
  return api;
}

const EMPTY = {
  tabs: [] as TabInfo[],
  activeTab: null as string | null,
  isRemote: false,
  cwd: "",
  remoteDir: null as string | null,
  remoteLabel: "",
};

beforeEach(() => {
  makeApi();
  useTabsStore.setState({ ...EMPTY, setTabs: useTabsStore.getState().setTabs });
});

describe("applyActive", () => {
  it("applies an activation payload in ONE subscriber notification", () => {
    let notifications = 0;
    const unsub = useTabsStore.subscribe(() => notifications++);
    useTabsStore.getState().applyActive({ id: "t1", cwd: "/proj", isRemote: true, remoteDir: "/proj", remoteLabel: "u@h" });
    unsub();
    expect(notifications).toBe(1);
    const s = useTabsStore.getState();
    expect(s.activeTab).toBe("t1");
    expect(s.cwd).toBe("/proj");
    expect(s.isRemote).toBe(true);
    expect(s.remoteDir).toBe("/proj");
    expect(s.remoteLabel).toBe("u@h");
  });

  it("keeps unspecified fields when clearing (isRemote/remoteDir fall back to prior)", () => {
    useTabsStore.setState({ isRemote: true, remoteDir: "/keep" });
    useTabsStore.getState().applyActive({ id: null, cwd: "", isRemote: false });
    const s = useTabsStore.getState();
    expect(s.activeTab).toBeNull();
    expect(s.isRemote).toBe(false);
    // remoteDir was NOT in the payload → keeps previous value (old behavior).
    expect(s.remoteDir).toBe("/keep");
  });
});

describe("createTab", () => {
  it("creates a local tab when no remote context is active", async () => {
    useTabsStore.setState({ cwd: "/local" });
    await useTabsStore.getState().createTab();
    const api = (globalThis as any).window.api;
    expect(api.tab.create).toHaveBeenCalledWith({ cwd: "/local" });
    expect(api.remote.getInfo).not.toHaveBeenCalled();
  });

  it("inherits the active tab's SSH context", async () => {
    const api = makeApi();
    api.remote.getInfo.mockResolvedValue({ host: "h", user: "u", port: 22, password: "p", path: "/remote" });
    useTabsStore.setState({ isRemote: true, activeTab: "t1", cwd: "/c", remoteDir: "/remote" });
    await useTabsStore.getState().createTab();
    expect(api.tab.create).toHaveBeenCalledWith({
      cwd: "/c",
      remote: { host: "h", user: "u", port: 22, path: "/remote", password: "p" },
    });
  });

  it("inherits the active tab's WSL context", async () => {
    const api = makeApi();
    api.remote.getInfo.mockResolvedValue({ host: "Ubuntu", user: "", isWsl: true, path: "~" });
    useTabsStore.setState({ isRemote: true, activeTab: "t2", cwd: "/c", remoteDir: null });
    await useTabsStore.getState().createTab();
    expect(api.tab.create).toHaveBeenCalledWith({ cwd: "/c", wsl: { distro: "Ubuntu", path: "~" } });
  });
});
