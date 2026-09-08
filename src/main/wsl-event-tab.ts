// Pure decision helpers for the SessionIndex change forwarder in index.ts.
// The forwarder routes WSL lists to session:remote-updated with the tabId of
// the tab the change belongs to — with two tabs of one distro open, picking
// the wrong tab corrupts the sidebar's remoteSessions cache (keyed by tabId).
/** Minimal structural view of a tab the decision needs (keeps the helper
 *  pure and testable without importing the pty module graph). */
interface WslTabRef {
  id: string;
  wsl?: { distro: string; path?: string };
}

/**
 * Which tab a WSL session change event belongs to.
 *
 * Priority: the ACTIVE tab of the distro when the event matches the polled
 * scope (the 4s poll only runs for the active WSL tab, so this is the
 * strongest attribution); then a tab whose path equals the changed cwd
 * (click-path refreshes of a non-active project); then any tab of the
 * distro. Returns undefined when nothing matches (event dropped).
 */
export function pickWslEventTab(
  tabs: WslTabRef[],
  activeTabOfDistro: WslTabRef | undefined,
  eventMatchesPolledScope: boolean,
  distro: string,
  cwd: string,
): WslTabRef | undefined {
  if (eventMatchesPolledScope && activeTabOfDistro) return activeTabOfDistro;
  return (
    tabs.find((x) => x.wsl?.distro === distro && (x.wsl?.path || "~") === cwd) ??
    tabs.find((x) => x.wsl?.distro === distro)
  );
}
