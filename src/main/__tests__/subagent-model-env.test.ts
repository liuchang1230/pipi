// The fix for "subagents must use the model the user selected": pi never
// rewrites its own process env, so the delegated-agent extensions (which read
// process.env.PI_MODEL) used to keep whatever the app injected at spawn — a
// mid-session model switch never reached them.
import { describe, expect, it } from "vitest";
import { PINNED_ENV, syncSubagentModelEnv } from "../extensions/pipi-subagent-model";

describe("syncSubagentModelEnv", () => {
  it("writes the session's model into the pi process env", () => {
    const env: Record<string, string | undefined> = {};
    expect(syncSubagentModelEnv({ provider: "deepseek", id: "deepseek-chat" }, env)).toBe(true);
    expect(env.PI_MODEL).toBe("deepseek-chat");
    expect(env.PI_PROVIDER).toBe("deepseek");
  });

  it("replaces a stale spawn-time value (the actual bug)", () => {
    const env: Record<string, string | undefined> = { PI_MODEL: "old-default", PI_PROVIDER: "openai" };
    syncSubagentModelEnv({ provider: "zhipu", id: "glm-4.6" }, env);
    expect(env.PI_MODEL).toBe("glm-4.6");
    expect(env.PI_PROVIDER).toBe("zhipu");
  });

  it("keeps PI_PROVIDER untouched when the selection has no provider", () => {
    const env: Record<string, string | undefined> = { PI_PROVIDER: "keep-me" };
    syncSubagentModelEnv({ id: "some-model" }, env);
    expect(env.PI_MODEL).toBe("some-model");
    expect(env.PI_PROVIDER).toBe("keep-me");
  });

  it("reports no change when the env already matches (no needless env churn)", () => {
    const env: Record<string, string | undefined> = { PI_MODEL: "m", PI_PROVIDER: "p" };
    expect(syncSubagentModelEnv({ provider: "p", id: "m" }, env)).toBe(false);
  });

  it("does nothing without a model (e.g. an event payload of another shape)", () => {
    const env: Record<string, string | undefined> = {};
    expect(syncSubagentModelEnv(undefined, env)).toBe(false);
    expect(syncSubagentModelEnv({}, env)).toBe(false);
    expect(env.PI_MODEL).toBeUndefined();
  });

  it("defers to an explicitly pinned subagent model", () => {
    // The user chose a specific model in the dialog: the app injects the marker,
    // and following the session model must NOT override that choice.
    const env: Record<string, string | undefined> = { [PINNED_ENV]: "1", PI_MODEL: "pinned" };
    expect(syncSubagentModelEnv({ provider: "session", id: "session-model" }, env)).toBe(false);
    expect(env.PI_MODEL).toBe("pinned");
    expect(env.PI_PROVIDER).toBeUndefined();
  });
});
