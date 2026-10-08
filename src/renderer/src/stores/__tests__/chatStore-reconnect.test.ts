// Auto-reconnect of a dropped SSH transport (docs/diagnosis/2026-10-05.md).
//
// The measured failure: a remote tab's ssh pipe dies mid-turn ("SSH 连接错误：
// read ECONNRESET"), pi is SIGHUP'd with it, and the pane used to sit on a dead
// banner until the user clicked 重新连接. Main now re-opens the SAME tab with
// backoff (rpc-session.ts RECONNECT_DELAYS_MS) and announces it with
// `rpc_reconnecting`. What the renderer does with that frame is what these tests
// pin down, because every failure mode here is silent: a phase that never
// clears looks like a hung turn, and a prompt accepted during the gap vanishes.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../chatStore";

const T = "tab-reconnect";
let previousWindow: unknown;

beforeEach(() => {
  previousWindow = (globalThis as { window?: unknown }).window;
  useChatStore.getState().clear(T);
  useChatStore.getState().ensure(T);
});

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = previousWindow;
  vi.restoreAllMocks();
});

describe("rpc_reconnecting", () => {
  it("replaces a streaming turn with the attempt count and the backoff", () => {
    const st = () => useChatStore.getState().states[T]!;
    useChatStore.getState().applyEvent(T, { type: "agent_start" });
    expect(st().isStreaming).toBe(true);

    useChatStore.getState().applyEvent(T, {
      type: "rpc_reconnecting",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 8000,
      detail: "SSH 连接已断开（对端关闭）",
    });

    expect(st().turn.phase).toBe("reconnecting");
    // Pi died with the transport: nothing will ever finish that turn, so the
    // streaming spinner has to stop lying.
    expect(st().isStreaming).toBe(false);
    expect(st().turn.detail).toContain("第 2/5 次");
    expect(st().turn.detail).toContain("8s 后");
    expect(st().turn.detail).toContain("对端关闭");
    // Not a failure: the tab is coming back, so no red banner.
    expect(st().exited).toBe(false);
  });

  it("is cleared by the reconnected pi's state_ready", () => {
    const st = () => useChatStore.getState().states[T]!;
    useChatStore.getState().applyEvent(T, { type: "rpc_reconnecting", attempt: 1, maxAttempts: 5, delayMs: 1000 });
    useChatStore.getState().applyEvent(T, { type: "app_phase", phase: "ready" });
    useChatStore.getState().applyEvent(T, { type: "state_ready", model: { id: "m", name: "M", provider: "p" }, sessionName: null, thinkingLevel: null });
    expect(st().turn.phase).toBe("ready");
  });

  it("marks the on-screen transcript stale so the reconnected pi re-hydrates it", () => {
    const st = () => useChatStore.getState().states[T]!;
    useChatStore.getState().initMessages(T, [{ role: "user", content: [{ type: "text", text: "旧消息" }], timestamp: 1 }]);
    expect(st().historyLoaded).toBe(true);
    useChatStore.getState().applyEvent(T, { type: "rpc_reconnecting", attempt: 1, maxAttempts: 5, delayMs: 1000 });
    // The canonical transcript is the session file on the server; ChatPane
    // re-reads it on the reconnected boot frame (state_ready + reconnected).
    expect(st().historyLoaded).toBe(false);
    // The messages stay on screen: a reconnect must not blank the pane.
    expect(st().messages.length).toBe(1);
  });

  it("refuses a prompt typed during the gap and gives the draft back", async () => {
    const rpcSend = vi.fn().mockResolvedValue(true);
    (globalThis as { window?: unknown }).window = { api: { tab: { rpcSend } } };
    const st = () => useChatStore.getState().states[T]!;
    useChatStore.getState().applyEvent(T, { type: "rpc_reconnecting", attempt: 1, maxAttempts: 5, delayMs: 1000 });

    await useChatStore.getState().sendPrompt(T, "第二阶段的任务");

    // The transport is dead — writing into it would lose the message silently.
    expect(rpcSend).not.toHaveBeenCalled();
    expect(st().lastError).toContain("正在自动重连");
    expect(st().restoreInput).toBe("第二阶段的任务");
    // Still "reconnecting" (not "failed"): the tab re-opens itself in seconds.
    expect(st().turn.phase).toBe("reconnecting");
  });
});

describe("giving up", () => {
  it("falls back to the exit banner once main stops retrying", () => {
    // Attempts exhausted → main emits the ordinary rpc-exit; the banner and its
    // manual 重新连接 button must still work exactly as before.
    useChatStore.getState().markExited(T, { code: -1, stderr: "SSH 连接错误：read ECONNRESET\n" });
    const st = useChatStore.getState().states[T]!;
    expect(st.exited).toBe(true);
    expect(st.lastError).toContain("ECONNRESET");
  });
});

describe("wiring", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("is emitted by main and rendered as a phase", () => {
    // Both sides match this event name by string: a rename on one side would
    // leave the pane on a dead turn with no error anywhere, so assert the
    // contract instead of trusting it.
    expect(read("../../../../main/rpc-session.ts")).toContain('type: "rpc_reconnecting"');
    expect(read("../../../../main/rpc-session.ts")).toContain("function replaceRpcSession");
    expect(read("../chatStore.ts")).toContain('type === "rpc_reconnecting"');
    expect(read("../../panes/ChatPane.tsx")).toContain("reconnecting:");
  });

  it("flags the reconnected boot so the transcript is re-read", () => {
    // Main knows the boot was a reconnect (reconnectAttempt > 0) and the
    // renderer cannot infer it reliably — without this flag the pane would keep
    // a transcript from before the drop.
    expect(read("../../../../main/rpc-session.ts")).toContain("reconnected: this.reconnectAttempt > 0");
    expect(read("../../panes/ChatPane.tsx")).toContain("event.reconnected === true");
  });

  it("only retries remote transports, and only for a transport death", () => {
    // The truth table itself lives in the pure policy (main's
    // rpc-reconnect-policy.test.ts); here just assert the class really asks it,
    // with the session's own auth/exited/attempt state.
    const src = read("../../../../main/rpc-session.ts");
    const policy = src.slice(src.indexOf("private shouldReconnect"), src.indexOf("private scheduleReconnect"));
    expect(policy).toContain("shouldAutoReconnect(code, {");
    expect(policy).toContain("authFailed: this.authFailed");
    expect(policy).toContain("attempt: this.reconnectAttempt");
  });
});
