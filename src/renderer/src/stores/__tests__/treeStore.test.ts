// Tree store: the noCache bypass is the auto-follow freshness contract —
// treeStore.refresh (force-fresh) must request an uncached listing so pi's
// writes (which never hit main's mutation handlers) show up immediately,
// while plain loadTree keeps using the main-process TTL cache.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore, sortFileNodes, mergeRelistedNodes, __resetTreeRefreshClock } from "../treeStore";
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

  it("expands an SSH directory in place without changing its browse root", async () => {
    const api = makeApi();
    api.file.listDirChildren.mockResolvedValue([
      { name: "main.ts", path: "/srv/project/src/main.ts", type: "file" },
    ] as FileNode[]);
    useTabsStore.setState({
      tabs: [{ id: "remote-1", title: "remote", isRemote: true } as any],
      activeTab: "remote-1",
      isRemote: true,
      cwd: "/srv/project",
      remoteDir: "/srv/project",
    });
    useTreeStore.setState({
      tree: [{ name: "src", path: "/srv/project/src", type: "directory", children: undefined }],
      expanded: new Set(["/srv/project/src"]),
      treeOrigin: { tabId: "remote-1", dirPath: "/srv/project", isRemote: true },
    });

    await useTreeStore.getState().expandDir("/srv/project/src");

    expect(api.file.listDirChildren).toHaveBeenCalledWith(undefined, "remote-1", "/srv/project/src", undefined);
    expect(useTreeStore.getState().tree[0]?.children?.map((node) => node.path)).toEqual(["/srv/project/src/main.ts"]);
    expect(useTreeStore.getState().treeOrigin?.dirPath).toBe("/srv/project");
    expect(useTabsStore.getState().remoteDir).toBe("/srv/project");
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

describe("mergeRelistedNodes (structural sharing)", () => {
  // Regression context: the 6s remote/WSL poll re-lists the root and every
  // expanded dir, so brand-new FileNode objects arrived even when nothing had
  // changed. Replacing `tree` with them changed every row's memo props and
  // re-rendered the whole "当前项目文件" column every 6s (the reported flicker).
  const listing = (): FileNode[] => [
    { name: "src", path: "src", type: "directory", children: [{ name: "a.ts", path: "src/a.ts", type: "file" }] },
    { name: "README.md", path: "README.md", type: "file" },
  ];

  it("returns the SAME array for an identical re-listing (no re-render)", () => {
    const prev = listing();
    // A re-listing is freshly parsed JSON — equal content, different objects.
    expect(mergeRelistedNodes(prev, listing())).toBe(prev);
  });

  it("keeps loaded children when a shallow listing arrives", () => {
    const prev = listing();
    // `file:list` returns directories with `children: undefined`; a re-listing
    // of the PARENT must not blank an already-expanded subtree (that would
    // flash "…加载中" and discard the user's expansion).
    const shallow: FileNode[] = [
      { name: "src", path: "src", type: "directory", children: undefined },
      { name: "README.md", path: "README.md", type: "file" },
    ];
    expect(mergeRelistedNodes(prev, shallow)).toBe(prev);
  });

  it("takes the new listing when a file was added", () => {
    const prev = listing();
    const next: FileNode[] = [...listing(), { name: "b.ts", path: "b.ts", type: "file" }];
    const merged = mergeRelistedNodes(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged.map((n) => n.path)).toEqual(["src", "README.md", "b.ts"]);
  });

  it("detects a rename at the same row count", () => {
    const prev = listing();
    const next: FileNode[] = [
      { name: "src", path: "src", type: "directory", children: [{ name: "a.ts", path: "src/a.ts", type: "file" }] },
      { name: "RENAMED.md", path: "RENAMED.md", type: "file" },
    ];
    const merged = mergeRelistedNodes(prev, next);
    expect(merged.map((n) => n.path)).toEqual(["src", "RENAMED.md"]);
  });

  it("reuses the unchanged rows and only replaces the changed one", () => {
    const prev = listing();
    const next: FileNode[] = [
      { name: "src", path: "src", type: "directory", children: [{ name: "a.ts", path: "src/a.ts", type: "file" }] },
      { name: "NEW.md", path: "NEW.md", type: "file" },
    ];
    const merged = mergeRelistedNodes(prev, next);
    const src = merged.find((n) => n.path === "src")!;
    // Same identity → its subtree (and every row under it) never re-renders.
    expect(src).toBe(prev[0]);
    expect(src.children).toBe(prev[0]!.children);
    expect(merged.find((n) => n.path === "NEW.md")).toBe(next[1]);
  });

  it("reuses a directory whose nested subtree is unchanged", () => {
    const prev = listing();
    const next: FileNode[] = [
      { name: "src", path: "src", type: "directory", children: [{ name: "a.ts", path: "src/a.ts", type: "file" }] },
      { name: "README.md", path: "README.md", type: "file" },
    ];
    expect(mergeRelistedNodes(prev, next)[0]).toBe(prev[0]);
  });

  it("propagates a nested change up to the parent node", () => {
    const prev = listing();
    const next: FileNode[] = [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          { name: "a.ts", path: "src/a.ts", type: "file" },
          { name: "b.ts", path: "src/b.ts", type: "file" },
        ],
      },
      { name: "README.md", path: "README.md", type: "file" },
    ];
    const merged = mergeRelistedNodes(prev, next);
    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0]!.children!.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("background re-listing does not churn identities", () => {
  it("expandDir(refreshLoaded) keeps the tree identity when nothing changed", async () => {
    const api = makeApi();
    const loaded: FileNode[] = [{ name: "src", path: "src", type: "directory", children: [{ name: "a.ts", path: "src/a.ts", type: "file" }] }];
    api.file.listDirChildren.mockResolvedValue([{ name: "a.ts", path: "src/a.ts", type: "file" }] as FileNode[]);
    useTreeStore.setState({ tree: loaded, expanded: new Set(["src"]), treeOrigin: { rootPath: "/proj", isRemote: false } });
    const before = useTreeStore.getState().tree;
    // refreshLoaded=true: the 6s poll's path — re-lists an ALREADY loaded dir.
    await useTreeStore.getState().expandDir("src", false, true);
    expect(useTreeStore.getState().tree).toBe(before);
    expect(useTreeStore.getState().tree[0]).toBe(before[0]);
  });

  it("loadTree keeps the expanded Set identity when the first dir is already expanded", async () => {
    const api = makeApi();
    api.file.list.mockResolvedValue([
      { name: "src", path: "src", type: "directory", children: undefined },
      { name: "README.md", path: "README.md", type: "file" },
    ] as FileNode[]);
    api.file.listDirChildren.mockResolvedValue([] as FileNode[]);
    useTreeStore.setState({ tree: [], expanded: new Set(["src"]), treeOrigin: { rootPath: "/proj", isRemote: false } });
    const before = useTreeStore.getState().expanded;
    await useTreeStore.getState().loadTree(undefined, "t1", "/proj", { isRemote: false });
    // A fresh Set here used to invalidate every TreeBranch's props on each poll.
    expect(useTreeStore.getState().expanded).toBe(before);
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
