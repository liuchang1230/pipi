// Subagent-model launch defaults — pure formatting + settings round-trip.
//
// The delegated-agent extensions (analyst/reviewer/scout) resolve their model
// from PI_PROVIDER/PI_MODEL in their own process env when the agent .md has no
// `model:`. The app never set those, so subagents silently ran on pi's default
// (usually the main) model. These tests pin the injection format: env vars for
// directly spawned pi, a quoted shell prefix for WSL/SSH (Windows env does not
// travel over ssh/WSL), and the "follow main" = no injection rule.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => process.env.PIPI_TEST_USERDATA ?? "C:\\fake\\userdata"),
  },
}));

const { subagentEnvFor, subagentShellPrefixFor, subagentEnv, getSubagentModel } = await import("../subagent-model");
const { updateSettings } = await import("../settings");

describe("subagentEnvFor", () => {
  it("emits both provider and model when set", () => {
    expect(subagentEnvFor({ provider: "siliconflow", model: "deepseek-ai/DeepSeek-V3" })).toEqual({
      PI_PROVIDER: "siliconflow",
      PI_MODEL: "deepseek-ai/DeepSeek-V3",
    });
  });

  it("emits only PI_MODEL when the provider is unknown", () => {
    expect(subagentEnvFor({ model: "glm-4.6" })).toEqual({ PI_MODEL: "glm-4.6" });
  });

  it("emits nothing for null (follow the main model)", () => {
    expect(subagentEnvFor(null)).toEqual({});
  });
});

describe("subagentShellPrefixFor", () => {
  const decodeOf = (value: string): string =>
    `"$(printf %s ${Buffer.from(value, "utf8").toString("base64")} | base64 -d 2>/dev/null || printf %s ${Buffer.from(value, "utf8").toString("base64")} | base64 -D 2>/dev/null)"`;

  it("stays quote-free so the SSH `bash -ic '…'` nesting survives", () => {
    const prefix = subagentShellPrefixFor({ provider: "sf", model: "deepseek-ai/DeepSeek-V3" });
    // The remote command is embedded inside an outer single-quoted string;
    // one `'` would terminate it and corrupt the whole command.
    expect(prefix).not.toContain("'");
    expect(prefix).toBe(`export PI_PROVIDER=${decodeOf("sf")}; export PI_MODEL=${decodeOf("deepseek-ai/DeepSeek-V3")}; `);
  });

  it("omits PI_PROVIDER when not configured", () => {
    expect(subagentShellPrefixFor({ model: "kimi-k3" })).toBe(`export PI_MODEL=${decodeOf("kimi-k3")}; `);
  });

  it("carries a single quote through base64 instead of breaking out", () => {
    const prefix = subagentShellPrefixFor({ model: "a'b" });
    expect(prefix).not.toContain("'");
    expect(prefix).toContain(`"$(printf %s ${Buffer.from("a'b", "utf8").toString("base64")}`);
  });

  it("is empty for null (no injection, previous behavior)", () => {
    expect(subagentShellPrefixFor(null)).toBe("");
  });
});

describe("settings round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipi-subagent-"));
    process.env.PIPI_TEST_USERDATA = dir;
  });
  afterEach(() => {
    delete process.env.PIPI_TEST_USERDATA;
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores, reads back, then clears back to follow-main", () => {
    expect(getSubagentModel()).toBeNull();
    updateSettings({ subagents: { provider: "sf", model: "m1" } });
    expect(getSubagentModel()).toEqual({ provider: "sf", model: "m1" });
    expect(subagentEnv()).toEqual({ PI_PROVIDER: "sf", PI_MODEL: "m1" });
    updateSettings({ subagents: null });
    expect(getSubagentModel()).toBeNull();
    expect(subagentEnv()).toEqual({});
  });

  it("normalizes a blank model to follow-main instead of injecting garbage", () => {
    updateSettings({ subagents: { provider: "sf", model: "   " } });
    expect(getSubagentModel()).toBeNull();
  });
});
