/**
 * Model config hot-sync scoping (pure logic, unit-testable).
 *
 * The ModelConfigDialog saves models.json/auth.json against ONE target
 * (local / WSL distro / remote profile). Running pi processes never re-read
 * those files, so each mounted ChatView hot-syncs its live session via the
 * shipped pipi-model-sync extension — but only when the save actually
 * applies to that tab's backend. This module owns that decision.
 */
import type { TabInfo } from "./stores/types";

export type ModelSyncTarget =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  | { kind: "remote"; host: string; user: string; port: number; agentDir?: string };

/** The minimal tab slice the predicate reads (renderer TabInfo). */
export type ModelSyncTab = Pick<
  TabInfo,
  "mode" | "isRemote" | "isWsl" | "wslDistro" | "remoteHost" | "remoteUser" | "remotePort" | "remoteAgentDir"
>;

/**
 * Normalize an agentDir override for comparison: trim + strip a single
 * trailing slash. The tab side holds main's sanitized value; the dialog side
 * carries the raw form input — cosmetic differences must not skip a sync.
 */
export function normalizeAgentDir(dir: string | undefined): string {
  return (dir ?? "").trim().replace(/\/+$/, "");
}

/**
 * Does a save against `target` apply to the pi session behind `tab`?
 *
 * - local: every LOCAL chat backend — in-process SDK, and also local
 *   `pi --mode rpc` tabs (SDK backend can be disabled via PIPI_SDK_BACKEND=0
 *   or settings backend:"rpc"). Local pty TUI sessions are intentionally out
 *   of scope: the TUI rebuilds its model list per keystroke of /model.
 * - wsl: WSL chat tabs of exactly that distro (RPC inside the distro).
 * - remote: SSH chat tabs on exactly that host/user/port/agentDir profile.
 */
export function modelSyncAppliesTo(target: ModelSyncTarget, tab: ModelSyncTab | undefined): boolean {
  if (!tab) return false;
  if (target.kind === "local") {
    if (tab.mode === "sdk") return true;
    // Local RPC chat (SDK backend disabled): remote-less, WSL-less rpc tab.
    return tab.mode === "rpc" && !tab.isRemote && !tab.isWsl;
  }
  if (target.kind === "wsl") {
    return !!tab.isWsl && tab.wslDistro === target.distro;
  }
  // remote
  if (!tab.isRemote || tab.isWsl) return false;
  if (tab.remoteHost !== target.host || tab.remoteUser !== target.user) return false;
  if ((tab.remotePort ?? 22) !== target.port) return false;
  return normalizeAgentDir(tab.remoteAgentDir) === normalizeAgentDir(target.agentDir);
}
