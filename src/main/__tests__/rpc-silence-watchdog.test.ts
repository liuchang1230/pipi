/**
 * Post-boot RPC liveness watchdog — pure policy, no transport/spawn runtime.
 *
 * Real behavior (verified against a production debug log): a command written
 * into a silently dropped SSH pipe reports `writable === true`, pi never
 * answers, and no exit event ever fires — the renderer sat on "已发送，等待 Pi
 * 开始处理…" for as long as the user waited. The boot-time watchdogs stop
 * applying once pi has spoken, so this clock covers the whole session.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { SEND_SILENCE_MS, SilenceWatchdog } from "../rpc-session";

const T0 = 1_700_000_000_000;

describe("SilenceWatchdog", () => {
  it("reports nothing while no command is waiting for an answer", () => {
    const w = new SilenceWatchdog();
    expect(w.take(T0)).toBeNull();
    expect(w.take(T0 + 10 * SEND_SILENCE_MS)).toBeNull();
  });

  it("stays quiet below the limit and reports the silent duration at it", () => {
    const w = new SilenceWatchdog();
    w.arm(T0);
    expect(w.take(T0 + SEND_SILENCE_MS - 1)).toBeNull();
    expect(w.take(T0 + SEND_SILENCE_MS)).toBe(SEND_SILENCE_MS);
  });

  it("disarms after reporting — a dead tab must not spam every window", () => {
    const w = new SilenceWatchdog();
    w.arm(T0);
    expect(w.take(T0 + SEND_SILENCE_MS)).toBe(SEND_SILENCE_MS);
    expect(w.take(T0 + 2 * SEND_SILENCE_MS)).toBeNull();
  });

  it("any byte from pi disarms the window", () => {
    const w = new SilenceWatchdog();
    w.arm(T0);
    w.noteBytes();
    expect(w.take(T0 + SEND_SILENCE_MS)).toBeNull();
  });

  it("keeps the FIRST unanswered write as the clock (later writes don't extend it)", () => {
    const w = new SilenceWatchdog();
    w.arm(T0);
    w.arm(T0 + 80_000); // a second command during the same silence window
    expect(w.take(T0 + SEND_SILENCE_MS)).toBe(SEND_SILENCE_MS);
  });

  it("re-arms after a healthy exchange", () => {
    const w = new SilenceWatchdog();
    w.arm(T0);
    w.noteBytes();
    w.arm(T0 + 5_000);
    expect(w.take(T0 + 5_000 + SEND_SILENCE_MS)).toBe(SEND_SILENCE_MS);
  });
});
