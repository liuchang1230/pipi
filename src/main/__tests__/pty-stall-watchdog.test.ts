// ConPTY stall watchdog decision — pure logic, no Electron/node-pty runtime.
// Real behavior: Windows conhost's pipe can freeze after a long lock/sleep
// (output stalls, input is swallowed); the first keystroke after a long
// zero-output idle arms a short echo probe, and silence → tab restart.
import { describe, expect, it } from "vitest";
import { shouldArmStallProbe, isPtyTabAlive, type TabInfo } from "../pty";

const now = 1_700_000_000_000; // realistic epoch ms
const IDLE = 20 * 60 * 1000;

describe("shouldArmStallProbe", () => {
  it("arms on the first input after a long zero-output idle in a pi tab", () => {
    expect(shouldArmStallProbe(false, false, now - 21 * 60 * 1000, now, IDLE)).toBe(true);
  });

  it("is strict: exactly at the idle boundary does NOT arm", () => {
    expect(shouldArmStallProbe(false, false, now - IDLE, now, IDLE)).toBe(false);
    expect(shouldArmStallProbe(false, false, now - IDLE - 1, now, IDLE)).toBe(true);
  });

  it("does NOT arm while output has been flowing recently", () => {
    expect(shouldArmStallProbe(false, false, now - 5 * 1000, now, IDLE)).toBe(false);
  });

  it("does NOT arm a second time while a probe is already pending", () => {
    expect(shouldArmStallProbe(false, true, now - 30 * 60 * 1000, now, IDLE)).toBe(false);
  });

  it("never arms for plain-shell tabs (silent shell may run a long command)", () => {
    expect(shouldArmStallProbe(true, false, now - 60 * 60 * 1000, now, IDLE)).toBe(false);
  });

  it("never arms when the pty never produced output (no lastOutputAt clock)", () => {
    expect(shouldArmStallProbe(false, false, undefined, now, IDLE)).toBe(false);
    expect(shouldArmStallProbe(false, false, 0, now, IDLE)).toBe(false);
  });
});

describe("isPtyTabAlive (tab:alive liveness semantics)", () => {
  const tab = (pty?: unknown): TabInfo => ({ id: "t", cwd: "/", sessionPath: "", title: "", pty: pty as never }) as unknown as TabInfo;

  it("is alive while the process runs (exitCode undefined)", () => {
    expect(isPtyTabAlive(tab({ exitCode: undefined }))).toBe(true);
  });

  it("is NOT alive once the process exited (exitCode set — crashed ssh.exe)", () => {
    expect(isPtyTabAlive(tab({ exitCode: 255 }))).toBe(false);
    expect(isPtyTabAlive(tab({ exitCode: 0 }))).toBe(false);
  });

  it("is NOT alive for pty-less tabs (RPC/SDK — handled by the caller's fallback)", () => {
    expect(isPtyTabAlive(tab(undefined))).toBe(false);
  });
});
