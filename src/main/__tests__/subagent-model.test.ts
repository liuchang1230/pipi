// The app's 「子代理模型」 setting: what the user chose, stored and read back.
//
// Where that choice is APPLIED is no longer in this module's subject. It used to
// be injected as PI_MODEL/PI_PROVIDER into every spawned pi, with the shipped
// pipi-subagent-model extension keeping them equal to the live session model —
// a contract only the retired hand-written delegation engine ever honoured. The
// official `pi-subagents` package resolves a child's model from pi's own
// settings (`subagents.agentOverrides.<role>.model`, injected by pi-settings.ts,
// see ADR 0013), so what is left to test here is the setting itself: storage,
// normalization, and the read that a startup step must never let throw.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => process.env.PIPI_TEST_USERDATA ?? "C:\\fake\\userdata"),
  },
}));

const { getSubagentModelSetting, updateSettings } = await import("../settings");

describe("the 「子代理模型」 setting", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipi-subagent-"));
    process.env.PIPI_TEST_USERDATA = dir;
  });
  afterEach(() => {
    delete process.env.PIPI_TEST_USERDATA;
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores, reads back, then clears back to follow-the-session", () => {
    expect(getSubagentModelSetting()).toBeNull();
    updateSettings({ subagents: { provider: "sf", model: "m1" } });
    expect(getSubagentModelSetting()).toEqual({ provider: "sf", model: "m1" });
    updateSettings({ subagents: null });
    expect(getSubagentModelSetting()).toBeNull();
  });

  it("normalizes a blank model to follow-the-session instead of writing garbage", () => {
    updateSettings({ subagents: { provider: "sf", model: "   " } });
    expect(getSubagentModelSetting()).toBeNull();
  });

  it("drops a provider the user cleared (a bare id is a legitimate choice)", () => {
    updateSettings({ subagents: { provider: "sf", model: "m1" } });
    updateSettings({ subagents: { model: "m1" } });
    expect(getSubagentModelSetting()).toEqual({ model: "m1" });
  });
});
