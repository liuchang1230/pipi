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

export interface TabHoverInfo {
  /** The full session label: pi's session name, or the first user message as
   *  pi recorded it. The tab strip truncates this to ~140px. */
  title: string;
  /** Where the session runs — `user@host:/path` for remote/WSL, the cwd for a
   *  local tab. Unknown for a record main has not filled in yet. */
  path: string | null;
}

/**
 * Hover card for a tab: the untruncated label plus the location it runs in.
 * The tab strip can only afford a ~140px label, so with several sessions of one
 * project open the strip alone does not say WHICH conversation a tab is; the
 * full label (up to 100 chars on the session-list path) is only readable here.
 * Null when there is nothing to say — callers render no card rather than an
 * empty box.
 */
export function tabHoverInfo(
  tab: TabInfo | null | undefined,
  project: ProjectLabel | null = projectLabelForTab(tab),
): TabHoverInfo | null {
  if (!tab) return null;
  const title = tab.title.trim() || project?.short || "";
  if (!title) return null;
  return { title, path: project?.full ?? null };
}
