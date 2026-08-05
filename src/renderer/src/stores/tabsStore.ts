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
        if ((remote as { isWsl?: boolean }).isWsl) {
          await window.api.tab.create({
            cwd: s.cwd || ".",
            wsl: { distro: remote.host, path: s.remoteDir || remote.path },
          });
        } else {
          await window.api.tab.create({
            cwd: s.cwd || ".",
            remote: {
              host: remote.host,
              user: remote.user,
              port: remote.port,
              path: s.remoteDir || remote.path,
              password: remote.password,
            },
          });
        }
        return;
      }
    }
    await window.api.tab.create({ cwd: s.cwd || "D:/其余文件/项目/agent" });
  },
  closeTab: async (id) => {
    await window.api.tab.close(id);
  },
  selectTab: async (id) => {
    await window.api.tab.activate(id);
  },
}));
