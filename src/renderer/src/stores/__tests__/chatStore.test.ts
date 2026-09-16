// Chat store reducer tests: feed the store the exact event shapes pi's RPC
// mode emits (verified against a live pi --mode rpc session) and assert the
// assembled message list.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useChatStore } from "../chatStore";

const T = "tab-test";
let previousWindow: unknown;

function apply(events: Record<string, unknown>[]): void {
  for (const e of events) useChatStore.getState().applyEvent(T, e);
}

beforeEach(() => {
  previousWindow = (globalThis as { window?: unknown }).window;
  useChatStore.getState().clear(T);
  useChatStore.getState().ensure(T);
});

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = previousWindow;
});

describe("chatStore streaming assembly", () => {
  it("flushes queued deltas before an authoritative message_end snapshot", async () => {
    useChatStore.getState().applyEvent(T, { type: "message_start", message: { role: "assistant", content: [] } });
    useChatStore.getState().applyEvent(T, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    });
    useChatStore.getState().applyEvent(T, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "final" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const message = useChatStore.getState().states[T]!.messages.at(-1)!;
    expect(message.blocks[0]).toMatchObject({ kind: "text", text: "final", done: true });
  });

  it("drops queued deltas when a tab state is cleared", async () => {
    useChatStore.getState().applyEvent(T, { type: "message_start", message: { role: "assistant", content: [] } });
    useChatStore.getState().applyEvent(T, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stale" },
    });
    useChatStore.getState().clear(T);
    useChatStore.getState().ensure(T);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(useChatStore.getState().states[T]!.messages).toEqual([]);
  });
  it("assembles a thinking+text turn from real event shapes", () => {
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "写一行诗" }], timestamp: 1 } },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "写一行诗" }], timestamp: 1 } },
      { type: "message_start", message: { role: "assistant", content: [], api: "openai-completions", model: "m" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "星河" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "入砚" } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "落笔" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "处春秋" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "星河入砚" } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "落笔处春秋" } },
      { type: "message_end", message: { role: "assistant", content: [
        { type: "thinking", thinking: "星河入砚" },
        { type: "text", text: "落笔处春秋" },
      ], model: "m" } },
      { type: "agent_settled" },
    ]);

    const st = useChatStore.getState().states[T]!;
    expect(st.isStreaming).toBe(false);
    expect(st.messages).toHaveLength(2);
    expect(st.messages[0]!.role).toBe("user");
    const text = (st.messages[0]!.blocks[0] as { text: string }).text;
    expect(text).toBe("写一行诗");
    const asst = st.messages[1]!;
    expect(asst.status).toBe("done");
    expect(asst.blocks).toHaveLength(2);
    expect(asst.blocks[0]).toMatchObject({ kind: "thinking", text: "星河入砚", done: true });
    expect(asst.blocks[1]).toMatchObject({ kind: "text", text: "落笔处春秋", done: true });
  });

  it("replaces the optimistic user bubble when message_start arrives", () => {
    // Simulate the optimistic bubble sendPrompt would have added.
    useChatStore.setState((s) => ({
      states: {
        ...s.states,
        [T]: {
          ...s.states[T]!,
          messages: [
            { id: "local-1", role: "user" as const, status: "done" as const, blocks: [{ kind: "text" as const, contentIndex: 0, text: "hello", done: true }] },
          ],
        },
      },
    }));
    useChatStore.getState().applyEvent(T, {
      type: "message_start",
      // Authoritative content differs from the optimistic text — proves the
      // optimistic bubble was replaced, not duplicated.
      message: { role: "user", content: "hello world", timestamp: 1 },
    });
    let st = useChatStore.getState().states[T]!;
    expect(st.messages).toHaveLength(1);
    expect(st.messages[0]!.blocks[0]).toMatchObject({ kind: "text", text: "hello world" });
  });

  it("tracks tool execution state on the matching toolCall block", () => {
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "ls" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", name: "bash" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command"' } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: ':"ls"}' } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call_1", name: "bash", arguments: { command: "ls" } } } },
      { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { command: "ls" }, partialResult: { content: [{ type: "text", text: "file1" }] } },
      { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { command: "ls" }, partialResult: { content: [{ type: "text", text: "file1\nfile2" }] } },
      { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "file1\nfile2" }] }, isError: false },
      { type: "message_end", message: { role: "assistant", content: [
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ] } },
      { type: "agent_settled" },
    ]);

    const st = useChatStore.getState().states[T]!;
    const asst = st.messages[1]!;
    const tool = asst.blocks[0] as { kind: "tool"; name?: string; argsText: string; resultText?: string; status: string };
    expect(tool.kind).toBe("tool");
    expect(tool.name).toBe("bash");
    expect(tool.argsText).toContain('"ls"');
    // message_end rebuilds from authoritative content — toolCall block only.
    expect(tool.status).toBe("done");
  });

  it("marks streaming true on agent_start and false on agent_settled", () => {
    apply([{ type: "agent_start" }]);
    expect(useChatStore.getState().states[T]!.isStreaming).toBe(true);
    apply([{ type: "agent_settled" }]);
    expect(useChatStore.getState().states[T]!.isStreaming).toBe(false);
  });

  it("sends both agent and bash abort commands", () => {
    const rpcSend = vi.fn().mockResolvedValue(true);
    (globalThis as { window?: { api?: unknown } }).window = {
      api: { tab: { rpcSend } },
    };

    useChatStore.getState().abort(T);

    expect(rpcSend).toHaveBeenNthCalledWith(1, T, { type: "abort" });
    expect(rpcSend).toHaveBeenNthCalledWith(2, T, { type: "abort_bash" });
  });

  it("surfaces model stream errors from message_end", () => {
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "hi" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "Provider finish_reason: error", stopReason: "error" } },
    ]);

    const st = useChatStore.getState().states[T]!;
    expect(st.lastError).toBe("Provider finish_reason: error");
    // Error stays attached to the message itself (history keeps it even
    // after a later turn clears the transient banner).
    expect(st.messages[1]!.status).toBe("done");
    expect(st.messages[1]!.error).toBe("Provider finish_reason: error");
  });

  it("keeps a message error after a new turn starts", () => {
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "q1" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "Provider finish_reason: error", stopReason: "error" } },
      // User submits a new conversation — agent_start clears the banner only.
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "q2" } },
    ]);

    const st = useChatStore.getState().states[T]!;
    expect(st.lastError).toBeUndefined();
    expect(st.messages[1]!.error).toBe("Provider finish_reason: error");
    expect(st.messages[1]!.role).toBe("assistant");
  });

  it("carries errors from historical messages through initMessages", () => {
    useChatStore.getState().initMessages(T, [
      { id: "a1", role: "user", content: [{ type: "text", text: "hi" }] },
      { id: "a2", role: "assistant", content: [], errorMessage: "Provider finish_reason: error", stopReason: "error" },
      { id: "a3", role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.messages[1]!.error).toBe("Provider finish_reason: error");
    expect(st.messages[2]!.error).toBeUndefined();
  });

  it("tracks auto retry and clears the banner on a successful follow-up", () => {
    apply([
      { type: "agent_start" },
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "Provider finish_reason: error", stopReason: "error" } },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "Provider finish_reason: error" },
    ]);
    let st = useChatStore.getState().states[T]!;
    expect(st.retryInfo).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(st.lastError).toBeUndefined();

    // Retry succeeds: a clean message_end clears the error banner.
    apply([
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "agent_settled" },
    ]);
    st = useChatStore.getState().states[T]!;
    expect(st.retryInfo).toBeNull();
    expect(st.lastError).toBeUndefined();
  });

  it("shows the final error after retries are exhausted", () => {
    apply([
      { type: "agent_start" },
      { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "Provider finish_reason: error" },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "Provider finish_reason: error" },
      { type: "agent_settled" },
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.retryInfo).toBeNull();
    expect(st.lastError).toBe("Provider finish_reason: error");
  });

  it("does not show a banner when the retry was cancelled by the user", () => {
    apply([
      { type: "agent_start" },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "x" },
      { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.retryInfo).toBeNull();
    expect(st.lastError).toBeUndefined();
  });

  it("tracks compaction progress and surfaces compaction failures", () => {
    apply([{ type: "compaction_start", reason: "auto" }]);
    expect(useChatStore.getState().states[T]!.compacting).toBe(true);

    apply([{ type: "compaction_end", reason: "auto", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed: boom" }]);
    const st = useChatStore.getState().states[T]!;
    expect(st.compacting).toBe(false);
    expect(st.lastError).toBe("Compaction failed: boom");
  });
});

describe("chatStore queue tracking", () => {
  it("tracks steering and follow-up queues from queue_update", () => {
    apply([
      { type: "agent_start" },
      { type: "queue_update", steering: ["先修 bug"], followUp: ["然后总结"] },
    ]);
    let st = useChatStore.getState().states[T]!;
    expect(st.steeringQueue).toEqual(["先修 bug"]);
    expect(st.followUpQueue).toEqual(["然后总结"]);

    // queue_update replaces the whole queue on every change.
    apply([{ type: "queue_update", steering: [], followUp: ["然后总结"] }]);
    st = useChatStore.getState().states[T]!;
    expect(st.steeringQueue).toEqual([]);
    expect(st.followUpQueue).toEqual(["然后总结"]);
  });

  it("clears the queues when the agent settles", () => {
    apply([
      { type: "agent_start" },
      { type: "queue_update", steering: ["x"], followUp: ["y"] },
      { type: "agent_settled" },
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.steeringQueue).toEqual([]);
    expect(st.followUpQueue).toEqual([]);
    expect(st.isStreaming).toBe(false);
  });

  it("records session behavior fields from state_ready (get_state)", () => {
    apply([
      {
        type: "state_ready",
        model: { id: "m", name: "M", provider: "p" },
        sessionName: "s",
        thinkingLevel: "high",
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        autoCompactionEnabled: false,
      },
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.steeringMode).toBe("one-at-a-time");
    expect(st.followUpMode).toBe("all");
    expect(st.autoCompactionEnabled).toBe(false);
  });
});

describe("chatStore session-mode fallback", () => {
  it("does not clobber mode fields when a later state_ready omits them", () => {
    // First: full get_state payload (autoCompaction disabled).
    apply([
      {
        type: "state_ready",
        model: { id: "m", name: "M", provider: "p" },
        thinkingLevel: "high",
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        autoCompactionEnabled: false,
      },
    ]);
    // Then: set_model optimistic update sends state_ready without modes —
    // existing values (including the false!) must survive.
    apply([{ type: "state_ready", model: { id: "m2", name: "M2", provider: "p" }, thinkingLevel: null }]);
    const st = useChatStore.getState().states[T]!;
    expect(st.modelId).toBe("m2");
    expect(st.steeringMode).toBe("one-at-a-time");
    expect(st.followUpMode).toBe("all");
    expect(st.autoCompactionEnabled).toBe(false);
  });

  it("ignores unknown get_state fields like modelFallbackMessage", () => {
    // The SDK backend's get_state may carry pi's modelFallbackMessage (model
    // restore failure notice). ChatPane toasts it; the store must not choke
    // on or store the extra field — the state_ready patch shape is unchanged.
    apply([
      {
        type: "state_ready",
        model: { id: "fallback-default", name: "Default", provider: "p" },
        sessionName: "s",
        thinkingLevel: null,
        modelFallbackMessage: "Could not restore model p/wanted",
      } as unknown as Record<string, unknown>,
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.modelId).toBe("fallback-default");
    expect((st as unknown as Record<string, unknown>).modelFallbackMessage).toBeUndefined();
  });

  it("handles partial queue_update payloads", () => {
    apply([
      { type: "agent_start" },
      { type: "queue_update", steering: ["a", "b"], followUp: [] },
      { type: "queue_update", steering: [] }, // followUp omitted entirely
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.steeringQueue).toEqual([]);
    expect(st.followUpQueue).toEqual([]);
  });
});

// pi answers every prompt command with a response frame (preflight verdict),
// emitted BEFORE any agent event. These tests pin the contract that turns that
// frame into UI truth — without it a refused prompt left "已发送，等待 Pi 开始
// 处理…" on screen forever (see the production debug log where a prompt got no
// answer at all and the spinner ran for minutes).
describe("chatStore prompt verdict", () => {
  /** Minimal window stub for sendPrompt; captures the command sent to pi. */
  function stubSend(ok = true): { sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    (globalThis as { window?: { api?: unknown } }).window = {
      api: {
        tab: {
          rpcSend: (_t: string, cmd: Record<string, unknown>) => {
            sent.push(cmd);
            return Promise.resolve(ok);
          },
        },
      },
    };
    return { sent };
  }

  it("tags the prompt with an id and shows pi's acceptance", async () => {
    const { sent } = stubSend();
    await useChatStore.getState().sendPrompt(T, "你好");
    const cmd = sent[0]!;
    expect(cmd.type).toBe("prompt");
    expect(typeof cmd.id).toBe("string");
    expect(useChatStore.getState().states[T]!.turn.phase).toBe("submitting");

    apply([{ type: "response", command: "prompt", success: true, id: cmd.id }]);
    const st = useChatStore.getState().states[T]!;
    // Accepted ≠ streaming: the turn is pi's now, but no agent event has
    // arrived, and the UI must say so honestly.
    expect(st.turn.phase).toBe("accepted");
    expect(st.pendingPromptId).toBeUndefined();
    expect(st.restoreInput).toBeUndefined();
  });

  it("drops the optimistic bubble and hands the text back when pi refuses", async () => {
    const { sent } = stubSend();
    await useChatStore.getState().sendPrompt(T, "一段很长的提示词");
    expect(useChatStore.getState().states[T]!.messages).toHaveLength(1);

    apply([{
      type: "response",
      command: "prompt",
      success: false,
      id: sent[0]!.id,
      error: 'No API key found for provider "deepseek".',
    }]);

    const st = useChatStore.getState().states[T]!;
    // pi never saw the message: it must not stay in the transcript, and the
    // user must not have to retype it.
    expect(st.messages).toHaveLength(0);
    expect(st.restoreInput).toBe("一段很长的提示词");
    expect(st.pendingPromptId).toBeUndefined();
    expect(st.lastError).toContain("No API key");
    expect(st.turn.phase).toBe("failed");

    // Read-and-clear: ChatView refills the composer exactly once.
    expect(useChatStore.getState().consumeRestoreInput(T)).toBe("一段很长的提示词");
    expect(useChatStore.getState().consumeRestoreInput(T)).toBeUndefined();
  });

  it("restores the composer when the command never left the app", async () => {
    stubSend(false);
    await useChatStore.getState().sendPrompt(T, "离线时输入的话");
    const st = useChatStore.getState().states[T]!;
    expect(st.messages).toHaveLength(0);
    expect(st.restoreInput).toBe("离线时输入的话");
    expect(st.turn.phase).toBe("failed");
  });

  it("leaves a running turn alone when a steer is merely queued", async () => {
    apply([{ type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } }]);
    const { sent } = stubSend();
    await useChatStore.getState().sendPrompt(T, "补充一句");
    expect(sent[0]!.streamingBehavior).toBe("steer");

    apply([{ type: "response", command: "prompt", success: true, id: sent[0]!.id }]);
    const st = useChatStore.getState().states[T]!;
    // "Queued into the running turn" is not a new phase — the visible turn is
    // still streaming.
    expect(st.turn.phase).not.toBe("accepted");
    expect(st.isStreaming).toBe(true);
  });

  it("keeps a running turn's phase when only a steer is refused", async () => {
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "部分输出" } },
    ]);
    const streamingPhase = useChatStore.getState().states[T]!.turn.phase;
    const { sent } = stubSend();
    await useChatStore.getState().sendPrompt(T, "插入的一句");
    apply([{ type: "response", command: "prompt", success: false, id: sent[0]!.id, error: "already processing" }]);

    const st = useChatStore.getState().states[T]!;
    // The agent is still working: only the queued message failed, so the turn
    // must not be relabelled "failed" (the error banner carries the news).
    expect(st.turn.phase).toBe(streamingPhase);
    expect(st.lastError).toBe("already processing");
    expect(st.restoreInput).toBe("插入的一句");
    expect(st.isStreaming).toBe(true);
  });

  it("ignores other prompts' verdicts (model-sync injections)", async () => {
    const { sent } = stubSend();
    await useChatStore.getState().sendPrompt(T, "我的问题");
    apply([{ type: "response", command: "prompt", success: false, id: "sync-abc-123", error: "unrelated" }]);
    const st = useChatStore.getState().states[T]!;
    expect(st.turn.phase).toBe("submitting");
    expect(sent).toHaveLength(1);
  });

  it("keeps a pending prompt visible against a stray state_ready", () => {
    // The liveness probe and the settings refresh both send get_state; a
    // snapshot must not repaint an unanswered prompt as "已就绪".
    useChatStore.getState().applyEvent(T, {
      type: "state_ready",
      model: { id: "m", name: "M", provider: "p" },
      thinkingLevel: null,
    });
    expect(useChatStore.getState().states[T]!.turn.phase).toBe("ready");

    useChatStore.setState((s) => ({
      states: { ...s.states, [T]: { ...s.states[T]!, turn: { phase: "submitting" as const } } },
    }));
    useChatStore.getState().applyEvent(T, {
      type: "state_ready",
      model: { id: "m", name: "M", provider: "p" },
      thinkingLevel: null,
    });
    expect(useChatStore.getState().states[T]!.turn.phase).toBe("submitting");
  });
});

describe("pickExitErrorLine", () => {
  it("surfaces the disconnect reason in the exit banner detail", () => {
    // A dropped SSH flow reaches markExited as code -1 + this stderr line, and
    // the banner must say "连接断开" rather than a bare "异常退出".
    useChatStore.getState().markExited(T, { code: -1, stderr: "SSH 连接已断开（网络中断或 keepalive 超时）\n" });
    const st = useChatStore.getState().states[T]!;
    expect(st.exited).toBe(true);
    expect(st.exitDetail).toContain("SSH 连接已断开");
    expect(st.lastError).toContain("SSH 连接已断开");
  });

  it("returns the last useful line, skipping bash -i job-control noise", async () => {
    const { pickExitErrorLine } = await import("../chatStore");
    const stderr =
      "bash: cannot set terminal process group (904): Inappropriate ioctl for device\n" +
      "bash: no job control in this shell\n" +
      "TypeError: webidl.util.markAsUncloneable is not a function";
    expect(pickExitErrorLine(stderr)).toBe("TypeError: webidl.util.markAsUncloneable is not a function");
  });

  it("returns the only line when there is no noise", () => {
    return import("../chatStore").then(({ pickExitErrorLine }) => {
      expect(pickExitErrorLine("pi: command not found")).toBe("pi: command not found");
    });
  });

  it("returns null for empty/whitespace stderr", async () => {
    const { pickExitErrorLine } = await import("../chatStore");
    expect(pickExitErrorLine(undefined)).toBeNull();
    expect(pickExitErrorLine("  \n \n")).toBeNull();
  });

  it("falls back to the first line when every line is noise", async () => {
    const { pickExitErrorLine } = await import("../chatStore");
    expect(pickExitErrorLine("bash: no job control in this shell")).toBe("bash: no job control in this shell");
  });
});

// exit code -1 is synthesized by the transport (Ssh2Transport.reportExit), so
// "Pi 进程异常退出" blamed pi for plain network blips. The transport's own
// stderr line is the only honest witness — this decides what the banner says.
describe("exitBannerText", () => {
  it("blames the connection, not pi, when the SSH flow was reset", async () => {
    const { exitBannerText } = await import("../chatStore");
    const banner = exitBannerText(-1, "SSH 连接错误：read ECONNRESET");
    expect(banner.kind).toBe("connection");
    expect(banner.headline).toContain("连接已断开");
    expect(banner.headline).not.toContain("异常退出");
    expect(banner.detail).toBe("SSH 连接错误：read ECONNRESET");
  });

  it("recognizes every transport wording we emit, and openssh's", async () => {
    const { exitBannerText } = await import("../chatStore");
    for (const detail of [
      "SSH 连接已断开（对端关闭）",
      "SSH 连接已断开（网络中断或 keepalive 超时）",
      "SSH 连接错误：Keepalive timeout",
      "Connection reset by 192.168.10.49 port 22",
      "Timeout, server 192.168.10.49 not responding.",
    ]) {
      expect(exitBannerText(-1, detail).kind).toBe("connection");
    }
  });

  it("still reports a real pi failure as an abnormal exit", async () => {
    const { exitBannerText } = await import("../chatStore");
    const banner = exitBannerText(1, "TypeError: webidl.util.markAsUncloneable is not a function");
    expect(banner.kind).toBe("crash");
    expect(banner.headline).toContain("异常退出");
    expect(banner.detail).toContain("TypeError");
  });

  it("never shows job-control noise as the cause", async () => {
    const { exitBannerText } = await import("../chatStore");
    // The noise is the ONLY stderr of an exec-without-pty drop: the banner must
    // stay vague rather than present a non-error as the reason.
    const banner = exitBannerText(-1, "bash: cannot set terminal process group (-1): Inappropriate ioctl for device");
    expect(banner.kind).toBe("crash");
    expect(banner.detail).toBeNull();
  });

  it("treats a clean exit as clean, with no cause to show", async () => {
    const { exitBannerText } = await import("../chatStore");
    const banner = exitBannerText(0, "SSH 连接已断开（对端关闭）");
    expect(banner.kind).toBe("clean");
    expect(banner.detail).toBeNull();
  });

  it("says 'connection' in lastError too, so the two banners agree", () => {
    useChatStore.getState().markExited(T, { code: -1, stderr: "SSH 连接错误：read ECONNRESET\n" });
    const st = useChatStore.getState().states[T]!;
    expect(st.lastError).toContain("与服务器的连接已断开");
    expect(st.lastError).not.toContain("pi 进程已退出");
  });
});

// Closed tabs must not keep their transcript alive: memory used to grow with
// every session the user ever opened (clear() was only called on view switch).
describe("retainTabs", () => {
  it("drops state for tabs that no longer exist", () => {
    const store = useChatStore.getState();
    store.ensure("t1");
    store.ensure("t2");
    store.ensure("t3");
    useChatStore.getState().retainTabs(new Set(["t1", "t3"]));
    expect(Object.keys(useChatStore.getState().states).sort()).toEqual(["t1", "t3"]);
  });

  it("is a no-op (same object) when nothing was closed", () => {
    useChatStore.setState({ states: {} }); // isolate from the previous case
    useChatStore.getState().ensure("t1");
    const before = useChatStore.getState().states;
    useChatStore.getState().retainTabs(new Set(["t1"]));
    expect(useChatStore.getState().states).toBe(before);
  });
});
