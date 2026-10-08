// When a remote transport may be re-opened without asking the user
// (docs/diagnosis/2026-10-05.md: "SSH 连接错误：read ECONNRESET" mid-turn, ~5
// times per 16h of use). The policy is pure so every branch is pinned here —
// getting it wrong is expensive in both directions: retrying a pi the user
// intentionally ended resurrects work, and NOT retrying a LAN blip strands the
// pane on a dead banner, which is the report that started this.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { RECONNECT_DELAYS_MS, RECONNECT_MAX_ATTEMPTS, reconnectDelayMs, shouldAutoReconnect } from "../rpc-session";

const remoteOk = { remote: true, authFailed: false, exited: false, attempt: 0 };

describe("shouldAutoReconnect", () => {
  it("retries a dropped remote transport", () => {
    // -1 is what Ssh2Transport reports for `end`/`close`/error: the pipe died,
    // pi was SIGHUP'd with it, and the session file on the server survives.
    expect(shouldAutoReconnect(-1, remoteOk)).toBe(true);
    expect(shouldAutoReconnect(-1, { ...remoteOk, attempt: RECONNECT_MAX_ATTEMPTS - 1 })).toBe(true);
  });

  it("never retries a local or WSL pi that exited by itself", () => {
    // A real exit code means pi RAN and ended — a crash to surface (local/WSL)
    // or a session the user quit. Re-spawning it would hide the bug.
    expect(shouldAutoReconnect(0, remoteOk)).toBe(false);
    expect(shouldAutoReconnect(1, remoteOk)).toBe(false);
    expect(shouldAutoReconnect(-1, { ...remoteOk, remote: false })).toBe(false);
    expect(shouldAutoReconnect(0, { ...remoteOk, remote: false })).toBe(false);
  });

  it("gives up instead of looping", () => {
    expect(shouldAutoReconnect(-1, { ...remoteOk, attempt: RECONNECT_MAX_ATTEMPTS })).toBe(false);
  });

  it("leaves auth and deliberate shutdown alone", () => {
    // A rejected password needs the login dialog, not a retry storm that locks
    // the account; an exited session is a user-initiated close (or a reconnect
    // already replaced by a newer session object).
    expect(shouldAutoReconnect(-1, { ...remoteOk, authFailed: true })).toBe(false);
    expect(shouldAutoReconnect(-1, { ...remoteOk, exited: true })).toBe(false);
  });
});

describe("reconnectDelayMs", () => {
  it("escalates and then holds at the ceiling", () => {
    expect(RECONNECT_DELAYS_MS[0]).toBe(1000);
    for (let attempt = 1; attempt < RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      expect(reconnectDelayMs(attempt + 1)).toBeGreaterThan(reconnectDelayMs(attempt));
    }
    // Out-of-range attempts clamp instead of returning undefined (which would
    // turn into a 0ms setTimeout — a hot retry loop against a dead link).
    expect(reconnectDelayMs(RECONNECT_MAX_ATTEMPTS)).toBe(RECONNECT_DELAYS_MS.at(-1));
    expect(reconnectDelayMs(RECONNECT_MAX_ATTEMPTS + 40)).toBe(RECONNECT_DELAYS_MS.at(-1));
    expect(reconnectDelayMs(0)).toBe(RECONNECT_DELAYS_MS[0]);
    // The whole budget stays short enough to feel automatic.
    const total = RECONNECT_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(90_000);
  });
});
