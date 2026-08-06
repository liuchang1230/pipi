// Viewer store: the openFile action is the race-sensitive core of the pane
// split (seq-guarded latest-wins, ENOENT retry for auto-follow, manual-open
// pinning, error toast). These tests pin that behavior so the refactor that
// moved it out of App.tsx cannot silently regress it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerStore, isManualOpenPending } from "../viewerStore";
import { useTabsStore } from "../tabsStore";
import { useTreeStore } from "../treeStore";
import { useUiStore } from "../uiStore";
import { useLayoutStore } from "../layoutStore";

const OK_FILE = { content: "hello", bytes: 5, isBinary: false };

type ReadImpl = (tabId: string | undefined, relPath: string, rootPath?: string) => Promise<unknown>;

function makeApi(readImpl: ReadImpl) {
  const api = {
    file: { read: vi.fn(readImpl) },
  };
  (globalThis as any).window = { api };
  return api;
}

/** A promise whose resolve we control, to sequence two racing reads. */
function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  makeApi(async () => OK_FILE);
  useViewerStore.setState({ currentFile: null, fileLoading: false, followCfg: { enabled: true, followReads: true }, followDegraded: false });
  useTabsStore.setState({ activeTab: "t1", isRemote: false, cwd: "/proj", remoteDir: null, remoteLabel: "" });
  useTreeStore.setState({ tree: [], expanded: new Set(), fileTreeStatus: "idle", fileTreeError: null, remoteTreeCache: {}, treeOrigin: null });
  useUiStore.setState({ toast: null });
  useLayoutStore.setState({ leftWidth: 260, rightWidth: 420, viewerCollapsed: false });
});

describe("openFile", () => {
  it("renders a successful read into currentFile", async () => {
    const api = makeApi(async () => OK_FILE);
    await useViewerStore.getState().openFile("src/a.ts", false);
    expect(api.file.read).toHaveBeenCalledWith("t1", "src/a.ts", undefined);
    const f = useViewerStore.getState().currentFile;
    expect(f?.path).toBe("src/a.ts");
    expect(f?.content).toBe("hello");
    expect(f?.followed).toBe(false);
    expect(useViewerStore.getState().fileLoading).toBe(false);
  });

  it("resolves reads against the tree origin in preview mode (rootPath wins)", async () => {
    const api = makeApi(async () => OK_FILE);
    // Preview: treeOrigin carries the preview root; main honors rootPath over
    // any tab id, so the read must land on the preview root, not the tab.
    useTreeStore.setState({ treeOrigin: { rootPath: "/preview", isRemote: false } });
    await useViewerStore.getState().openFile("a.ts", false);
    expect(api.file.read).toHaveBeenCalledWith(expect.anything(), "a.ts", "/preview");
  });

  it("reveals a collapsed viewer when a file is opened (click means: show it)", async () => {
    useLayoutStore.setState({ viewerCollapsed: true });
    await useViewerStore.getState().openFile("a.ts", false);
    expect(useLayoutStore.getState().viewerCollapsed).toBe(false);
  });

  it("latest open wins a race (stale read must not clobber a newer one)", async () => {
    const slow = deferred();
    makeApi((_tab, relPath: string) => (relPath === "slow.ts" ? slow.promise : Promise.resolve(OK_FILE)));
    const p1 = useViewerStore.getState().openFile("slow.ts", false);
    const p2 = useViewerStore.getState().openFile("fast.ts", false);
    await p2;
    // fast already rendered…
    expect(useViewerStore.getState().currentFile?.path).toBe("fast.ts");
    // …then the stale read settles late and must NOT overwrite it.
    slow.resolve({ content: "stale", bytes: 5, isBinary: false });
    await p1;
    expect(useViewerStore.getState().currentFile?.path).toBe("fast.ts");
  });

  it("a follow that settles late never clobbers a newer manual open", async () => {
    const slow = deferred();
    makeApi((_tab, relPath: string) => (relPath === "slow.ts" ? slow.promise : Promise.resolve(OK_FILE)));
    const follow = useViewerStore.getState().openFile("slow.ts", true); // started first, settles late
    const manual = useViewerStore.getState().openFile("manual.ts", false); // newer seq, settles fast
    await manual;
    expect(useViewerStore.getState().currentFile?.path).toBe("manual.ts");
    slow.resolve({ content: "follow", bytes: 6, isBinary: false });
    await follow;
    expect(useViewerStore.getState().currentFile?.path).toBe("manual.ts");
  });

  it("exposes a manual open as in-flight until it settles", async () => {
    const slow = deferred();
    makeApi(async () => slow.promise);
    const p = useViewerStore.getState().openFile("x.ts", false);
    expect(isManualOpenPending()).toBe(true);
    slow.resolve(OK_FILE);
    await p;
    expect(isManualOpenPending()).toBe(false);
  });

  it("retries a followed read on ENOENT so a just-created file still lands", async () => {
    let calls = 0;
    makeApi(async () => {
      calls++;
      return calls < 3 ? { content: "err", bytes: 0, isBinary: false, error: "ENOENT" } : OK_FILE;
    });
    await useViewerStore.getState().openFile("new.ts", true);
    expect(calls).toBeGreaterThan(1);
    expect(useViewerStore.getState().currentFile?.content).toBe("hello");
  });

  it("surfaces a failed manual open as an error toast via uiStore", async () => {
    makeApi(async () => {
      throw new Error("磁盘错误");
    });
    await useViewerStore.getState().openFile("x.ts", false);
    expect(useUiStore.getState().toast).toEqual({ text: "磁盘错误", type: "err" });
  });

  it("leaves the current view alone on a followed miss (no clobber)", async () => {
    useViewerStore.setState({ currentFile: { path: "keep.ts", content: "keep", bytes: 4, isBinary: false, followed: true } });
    makeApi(async () => ({ content: "missing", bytes: 0, isBinary: false, error: "ENOENT" }));
    await useViewerStore.getState().openFile("gone.ts", true);
    expect(useViewerStore.getState().currentFile?.path).toBe("keep.ts");
  });
});
