// Tree store: the noCache bypass is the auto-follow freshness contract —
// treeStore.refresh (force-fresh) must request an uncached listing so pi's
// writes (which never hit main's mutation handlers) show up immediately,
// while plain loadTree keeps using the main-process TTL cache.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore, sortFileNodes } from "../treeStore";
import { useTabsStore } from "../tabsStore";
import type { FileNode } from "../types";

function makeApi() {
  const api = {
    file: {
      list: vi.fn(async () => [] as FileNode[]),
    },
  };
  (globalThis as any).window = { api };
  return api;
}

beforeEach(() => {
  makeApi();
  useTabsStore.setState({ tabs: [{ id: "t1", title: "x" } as any], activeTab: "t1", isRemote: false, cwd: "/proj", remoteDir: null, remoteLabel: "" });
  useTreeStore.setState({
    tree: [],
    expanded: new Set<string>(),
    fileTreeStatus: "idle",
    fileTreeError: null,
    remoteTreeCache: {},
    treeOrigin: null,
  });
});

describe("treeStore noCache bypass", () => {
  it("refresh() requests a noCache listing (auto-follow freshness)", async () => {
    const api = makeApi();
    useTreeStore.setState({ treeOrigin: { tabId: "t1", isRemote: false } });
    await useTreeStore.getState().refresh();
    expect(api.file.list).toHaveBeenCalledWith("t1", undefined, undefined, true);
  });

  it("plain loadTree keeps the cache enabled (click path)", async () => {
    const api = makeApi();
    await useTreeStore.getState().loadTree(undefined, "t1", undefined, { isRemote: false });
    expect(api.file.list).toHaveBeenCalledWith("t1", undefined, undefined, undefined);
  });
});

describe("sortFileNodes", () => {
  it("directories first, then names", () => {
    const nodes: FileNode[] = [
      { name: "b.ts", path: "b.ts", type: "file" },
      { name: "a", path: "a", type: "directory", children: [] },
      { name: "a.ts", path: "a.ts", type: "file" },
    ];
    expect(sortFileNodes(nodes).map((n) => n.name)).toEqual(["a", "a.ts", "b.ts"]);
  });
});
