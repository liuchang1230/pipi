// Tab / active-tab state. Every pane that displays tab data subscribes here
// via selectors; an activation event is applied atomically (applyActive) so
// the renderer performs ONE state update instead of five cascading ones.
// Tab lifecycle (create/close/activate) lives here as store actions so the
// terminal pane needs no callback props for them.
import { create } from "zustand";
import type { TabInfo } from "./types";

export interface ActiveTabPayload {
  id: string | null;
  cwd: string;
  isRemote?: boolean;
  remoteDir?: string | null;
  remoteLabel?: string;
}

interface TabsState {
  tabs: TabInfo[];
  activeTab: string | null;
  isRemote: boolean;
  cwd: string;
  remoteDir: string | null;
  remoteLabel: string;
  setTabs: (tabs: TabInfo[]) => void;
  setActiveTab: (id: string | null) => void;
  setIsRemote: (v: boolean) => void;
  setCwd: (cwd: string) => void;
  setRemoteDir: (dir: string | null) => void;
  setRemoteLabel: (label: string) => void;
  /** Show a newly-created/known tab immediately; main's tabs:update remains authoritative. */
  showTabImmediately: (tab: TabInfo, active?: Omit<ActiveTabPayload, "id">) => void;
  /** Apply an activation event in one atomic set (one subscriber notification). */
  applyActive: (payload: ActiveTabPayload) => void;
  /** New blank tab, inheriting the active tab's remote/WSL context. */
  createTab: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  selectTab: (id: string) => Promise<void>;
}

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  activeTab: null,
  isRemote: false,
  cwd: "",
  remoteDir: null,
  remoteLabel: "",
  setTabs: (tabs) => set({ tabs }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setIsRemote: (isRemote) => set({ isRemote }),
  setCwd: (cwd) => set({ cwd }),
  setRemoteDir: (remoteDir) => set({ remoteDir }),
  setRemoteLabel: (remoteLabel) => set({ remoteLabel }),
  showTabImmediately: (tab, active) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tab.id);
      const tabs = idx >= 0 ? [...s.tabs] : [...s.tabs, tab];
      if (idx >= 0) tabs[idx] = { ...tabs[idx], ...tab };
      const nextIsRemote = active?.isRemote ?? !!tab.isRemote;
      const nextCwd = active?.cwd ?? tab.cwd;
      return {
        tabs,
        activeTab: tab.id,
        cwd: nextCwd,
        isRemote: nextIsRemote,
        remoteDir: active?.remoteDir !== undefined ? active.remoteDir : nextIsRemote ? nextCwd : null,
        remoteLabel: active?.remoteLabel ?? (nextIsRemote ? s.remoteLabel : ""),
      };
    }),
  applyActive: ({ id, cwd, isRemote, remoteDir, remoteLabel }) =>
    set((s) => ({
      activeTab: id,
      cwd,
      isRemote: isRemote ?? s.isRemote,
      remoteDir: remoteDir !== undefined ? remoteDir : s.remoteDir,
      remoteLabel: remoteLabel !== undefined ? remoteLabel : s.remoteLabel,
    })),
  createTab: async () => {
    const s = get();
    if (s.isRemote && s.activeTab) {
      const remote = await window.api.remote.getInfo(s.activeTab);
      if (remote) {
        const remotePath = s.remoteDir || remote.path || s.cwd || ".";
        if ((remote as { isWsl?: boolean }).isWsl) {
          const id = await window.api.tab.create({
            cwd: s.cwd || ".",
            wsl: { distro: remote.host, path: remotePath },
          });
          get().showTabImmediately(
            { id, cwd: remotePath, title: remote.host, isRemote: true, isWsl: true, wslDistro: remote.host, pi: true, mode: "rpc" },
            { cwd: remotePath, isRemote: true, remoteDir: remotePath, remoteLabel: `🐧 ${remote.host}` },
          );
        } else {
          const id = await window.api.tab.create({
            cwd: s.cwd || ".",
            remote: {
              host: remote.host,
              user: remote.user,
              port: remote.port,
              path: remotePath,
              password: remote.password,
              agentDir: (remote as { agentDir?: string }).agentDir,
            },
          });
          get().showTabImmediately(
            { id, cwd: remotePath, title: remote.host, isRemote: true, pi: true, mode: "rpc" },
            { cwd: remotePath, isRemote: true, remoteDir: remotePath, remoteLabel: `${remote.user}@${remote.host}` },
          );
        }
        return;
      }
    }
    const cwd = s.cwd || "D:/其余文件/项目/agent";
    const id = await window.api.tab.create({ cwd });
    const title = cwd.replace(/\\/g, "/").split("/").pop() || cwd;
    // Local tabs default to the terminal view (pty TUI); tabs:update confirms
    // the mode. The chat view is one click away via the TabBar button.
    get().showTabImmediately(
      { id, cwd, title, pi: true, mode: "sdk" }, { cwd, isRemote: false, remoteDir: null, remoteLabel: "" });
  },
  closeTab: async (id) => {
    await window.api.tab.close(id);
  },
  selectTab: async (id) => {
    const ok = await window.api.tab.activate(id);
    if (ok) set({ activeTab: id });
  },
}));
