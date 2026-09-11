/**
 * Project label for a tab ("where does this session run"), shared by the tab
 * bar and the chat header.
 *
 * Why a module: the honest source of the directory differs per tab kind. A
 * local tab's `cwd` IS its project, but for remote/WSL tabs `cwd` is the LOCAL
 * path the app would use for a new tab — the project lives in `remoteDir`
 * (shipped by main; see `tabProjectDir` in src/main/index.ts). Getting that
 * backwards labels every remote session with a Windows folder name.
 */
import type { TabInfo } from "./stores/types";

export interface ProjectLabel {
  /** Compact name for a chip or tab prefix (the folder name, or the host when
   *  the directory is unknown/~). */
  short: string;
  /** Full identity for tooltips/copy: a path, or `user@host:/path`. */
  full: string;
}

/** Last path segment, tolerant of Windows and POSIX separators. */
function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
}

/** Host part of a remote/WSL tab label (`user@host` / `WSL <distro>`). */
function hostLabel(tab: TabInfo): string {
  if (tab.isWsl) return tab.wslDistro ? `WSL ${tab.wslDistro}` : "WSL";
  const user = tab.remoteUser?.trim();
  const host = tab.remoteHost?.trim();
  if (user && host) return `${user}@${host}`;
  return host || user || "远程";
}

/**
 * Null when the tab has nothing meaningful to show (no record yet, or a local
 * tab without a cwd) — callers render nothing rather than a placeholder that
 * would look like real information.
 */
export function projectLabelForTab(tab: TabInfo | null | undefined): ProjectLabel | null {
  if (!tab) return null;
  if (tab.isRemote || tab.isWsl) {
    const host = hostLabel(tab);
    const dir = tab.remoteDir?.trim();
    if (!dir || dir === "~") return { short: host, full: host };
    return { short: baseName(dir), full: `${host}:${dir}` };
  }
  const cwd = tab.cwd?.trim();
  if (!cwd) return null;
  return { short: baseName(cwd), full: cwd };
}
