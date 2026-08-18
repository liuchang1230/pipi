// Tree store: the noCache bypass is the auto-follow freshness contract —
// treeStore.refresh (force-fresh) must request an uncached listing so pi's
// writes (which never hit main's mutation handlers) show up immediately,
// while plain loadTree keeps using the main-process TTL cache.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore, sortFileNodes, __resetTreeRefreshClock } from "../treeStore";
import { useTabsStore } from "../tabsStore";
import type { FileNode } from "../types";

function makeApi() {
  const api = {
    file: {
      list: vi.fn(async () => [] as FileNode[]),
      listDirChildren: vi.fn(async () => [] as FileNode[]),
    },
  };
  (globalThis as any).window = { api };
  return api;
}

beforeEach(() => {
  __resetTreeRefreshClock();
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

describe("expandDir (lazy tree)", () => {
  const rootTree: FileNode[] = [
    { name: "src", path: "src", type: "directory", children: undefined },
    { name: "README.md", path: "README.md", type: "file" },
  ];

  it("fetches and injects children under the expanded node", async () => {
    const api = makeApi();
    api.file.listDirChildren.mockResolvedValue([
      { name: "a.ts", path: "src/a.ts", type: "file" },
      { name: "components", path: "src/components", type: "directory", children: undefined },
    ] as FileNode[]);
    useTreeStore.setState({
      tree: rootTree,
      expanded: new Set(["src"]),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    await useTreeStore.getState().expandDir("src");
    const tree = useTreeStore.getState().tree;
    const src = tree.find((n) => n.path === "src");
    expect(src?.children?.map((c) => c.name)).toEqual(["components", "a.ts"]); // sorted: dirs first
    expect(api.file.listDirChildren).toHaveBeenCalledWith("/proj", undefined, "src", undefined);
  });

  it("skips the fetch when children are already loaded", async () => {
    const api = makeApi();
    useTreeStore.setState({
      tree: [{ name: "src", path: "src", type: "directory", children: [] }],
      expanded: new Set(["src"]),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    await useTreeStore.getState().expandDir("src");
    expect(api.file.listDirChildren).not.toHaveBeenCalled();
  });

  it("discards the response when the dir was collapsed in flight", async () => {
    const api = makeApi();
    let resolveFetch!: (v: FileNode[]) => void;
    api.file.listDirChildren.mockReturnValue(new Promise((r) => (resolveFetch = r)));
    useTreeStore.setState({
      tree: rootTree,
      expanded: new Set(["src"]),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    const p = useTreeStore.getState().expandDir("src");
    // User collapses the dir while the listing is in flight.
    useTreeStore.setState({ expanded: new Set<string>() });
    resolveFetch([{ name: "stale.ts", path: "src/stale.ts", type: "file" } as FileNode]);
    await p;
    const src = useTreeStore.getState().tree.find((n) => n.path === "src");
    expect(src?.children).toBeUndefined(); // stale listing discarded
  });

  it("collapses the dir when the listing fails (retry on next click)", async () => {
    const api = makeApi();
    api.file.listDirChildren.mockRejectedValue(new Error("permission"));
    useTreeStore.setState({
      tree: rootTree,
      expanded: new Set(["src"]),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    await useTreeStore.getState().expandDir("src");
    expect(useTreeStore.getState().expanded.has("src")).toBe(false);
  });

  it("injects at depth > 1 (nested expansion)", async () => {
    const api = makeApi();
    api.file.listDirChildren.mockResolvedValue([
      { name: "b.ts", path: "src/components/b.ts", type: "file" },
    ] as FileNode[]);
    useTreeStore.setState({
      tree: [
        {
          name: "src",
          path: "src",
          type: "directory",
          children: [
            { name: "components", path: "src/components", type: "directory", children: undefined },
          ],
        },
      ],
      expanded: new Set(["src", "src/components"]),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    await useTreeStore.getState().expandDir("src/components");
    const components = useTreeStore
      .getState()
      .tree.find((n) => n.path === "src")!
      .children!.find((n) => n.path === "src/components")!;
    expect(components.children?.map((c) => c.path)).toEqual(["src/components/b.ts"]);
    // Siblings of the injected branch survive untouched.
    expect(useTreeStore.getState().tree.length).toBe(1);
  });

  it("a user expand does not cancel an in-flight loadTree (separate seqs)", async () => {
    const api = makeApi();
    let resolveList!: (v: FileNode[]) => void;
    api.file.list.mockReturnValue(new Promise((r) => (resolveList = r)));
    api.file.listDirChildren.mockResolvedValue([{ name: "a.ts", path: "src/a.ts", type: "file" }] as FileNode[]);
    useTreeStore.setState({
      tree: [],
      expanded: new Set(),
      treeOrigin: null,
    });
    const load = useTreeStore.getState().loadTree(undefined, "t1", undefined, { isRemote: false });
    // User expands a dir while the root listing is in flight.
    useTreeStore.setState({ tree: rootTree, expanded: new Set(["src"]), treeOrigin: { tabId: "t1", isRemote: false } });
    await useTreeStore.getState().expandDir("src");
    // The root listing lands AFTER the expand — it must still apply.
    resolveList([{ name: "LATE.md", path: "LATE.md", type: "file" } as FileNode]);
    await load;
    expect(useTreeStore.getState().tree.map((n) => n.path)).toContain("LATE.md");
  });

  it("two expands of the same dir: the newer response wins", async () => {
    const api = makeApi();
    let resolveFirst!: (v: FileNode[]) => void;
    let resolveSecond!: (v: FileNode[]) => void;
    api.file.listDirChildren
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
    useTreeStore.setState({
      tree: rootTree,
      expanded: new Set(["src"]),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    const first = useTreeStore.getState().expandDir("src");
    const second = useTreeStore.getState().expandDir("src");
    // Stale response resolves LAST but must not clobber the fresh one.
    resolveSecond([{ name: "fresh.ts", path: "src/fresh.ts", type: "file" } as FileNode]);
    await second;
    resolveFirst([{ name: "stale.ts", path: "src/stale.ts", type: "file" } as FileNode]);
    await first;
    const src = useTreeStore.getState().tree.find((n) => n.path === "src")!;
    expect(src.children?.map((c) => c.name)).toEqual(["fresh.ts"]);
  });
});

describe("refresh with lazy expanded dirs", () => {
  it("re-lists the root AND the expanded dirs (noCache)", async () => {
    const api = makeApi();
    api.file.list.mockResolvedValue([
      { name: "src", path: "src", type: "directory", children: undefined },
      { name: "README.md", path: "README.md", type: "file" },
    ] as FileNode[]);
    api.file.listDirChildren.mockResolvedValue([
      { name: "a.ts", path: "src/a.ts", type: "file" },
    ] as FileNode[]);
    useTreeStore.setState({
      tree: [{ name: "src", path: "src", type: "directory", children: [] }],
      expanded: new Set(["src"]),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    await useTreeStore.getState().refresh();
    expect(api.file.list).toHaveBeenCalledWith(undefined, undefined, "/proj", true);
    expect(api.file.listDirChildren).toHaveBeenCalledWith("/proj", undefined, "src", true);
  });

  it("clamps churn with a cooldown", async () => {
    const api = makeApi();
    useTreeStore.setState({
      tree: [],
      expanded: new Set(),
      treeOrigin: { rootPath: "/proj", isRemote: false },
    });
    await useTreeStore.getState().refresh();
    await useTreeStore.getState().refresh(); // within the cooldown → dropped
    expect(api.file.list).toHaveBeenCalledTimes(1);
  });
});
