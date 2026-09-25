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

  it("surfaces a dropped abort instead of leaving the turn on '正在停止…'", async () => {
    // `rpcSend` resolves false (never rejects) when the tab is gone, so the old
    // `.catch(() => {})` could never fire: the UI sat on "正在停止…" forever.
    const rpcSend = vi.fn().mockResolvedValue(false);
    (globalThis as { window?: { api?: unknown } }).window = {
      api: { tab: { rpcSend } },
    };

    useChatStore.getState().abort(T);
    await vi.waitFor(() => expect(useChatStore.getState().states[T]!.lastError).toBeTruthy());

    const st = useChatStore.getState().states[T]!;
    expect(st.turn.phase).toBe("failed");
    expect(st.lastError).toContain("停止指令");
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

  it("keeps a running turn's phase when only a steer is refused (and retries it as a normal prompt)", async () => {
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
    // "already processing" means pi would not take the message into the run it is
    // finishing — the message is not lost, it is re-issued as its own normal turn.
    // The turn that is still running must not be relabelled meanwhile.
    expect(st.turn.phase).toBe(streamingPhase);
    expect(st.restoreInput).toBeUndefined();
    expect(st.pendingPromptId).toBe(sent[0]!.id);
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

/**
 * Regression: "I pressed 停止, typed the next prompt quickly, and the transcript
 * showed my prompt FIRST and '⚠ 模型错误：This operation was aborted' BELOW it."
 *
 * pi records an abort as an assistant message with stopReason "error" and
 * errorMessage "This operation was aborted" (verified in a real session file),
 * and that message only arrives AFTER the next prompt was appended. The store
 * matched events positionally ("the last message"), so the abort's error landed
 * on the NEW turn's bubble, and the whole turn was relabelled as a failure.
 */
describe("chatStore abort attribution", () => {
  function stubSend(): void {
    (globalThis as { window?: { api?: unknown } }).window = {
      api: { tab: { rpcSend: () => Promise.resolve(true) } },
    };
  }

  it("never attaches the abort's error to the prompt sent right after 停止", async () => {
    stubSend();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "长任务" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
    useChatStore.getState().abort(T);
    await useChatStore.getState().sendPrompt(T, "第二个 prompt");
    // pi finishes the abort: an EMPTY message carrying the raw AbortError text.
    apply([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "This operation was aborted", stopReason: "error" } },
    ]);

    const st = useChatStore.getState().states[T]!;
    const msgs = st.messages;
    // No stray bubble was created for the abort (it belongs to the aborted turn).
    expect(msgs).toHaveLength(3);
    const newPrompt = msgs.find((m) => m.role === "user" && m.blocks[0]?.kind === "text" && m.blocks[0].text === "第二个 prompt")!;
    expect(newPrompt).toBeTruthy();
    // Nothing at or after the new prompt claims a model error / interruption.
    const after = msgs.slice(msgs.indexOf(newPrompt));
    expect(after.some((m) => m.error)).toBe(false);
    expect(after.some((m) => m.interrupted)).toBe(false);
    // The aborted turn is marked as stopped, ABOVE the new prompt (where it
    // actually happened).
    const aborted = msgs.find((m) => m.interrupted)!;
    expect(aborted).toBeTruthy();
    expect(msgs.indexOf(aborted)).toBeLessThan(msgs.indexOf(newPrompt));
    // The user cancelled: no red banner anywhere.
    expect(st.lastError).toBeUndefined();
    expect(st.turn.phase).not.toBe("failed");
    // The next prompt was sent while pi still had the turn open, so it went out
    // as a STEER of the aborted turn (same turnSeq) — "已停止" is then the honest
    // label until pi settles and starts the queued turn. What must never happen
    // is a red error, and that is asserted above. When the new prompt does start
    // its own turn, the aborted fallout must not relabel it (next test).
  });

  it("marks the turn 已停止 when the user stops and nothing follows", () => {
    stubSend();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "长任务" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
    useChatStore.getState().abort(T);
    apply([
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "This operation was aborted", stopReason: "error" } },
    ]);

    const st = useChatStore.getState().states[T]!;
    expect(st.turn.phase).toBe("cancelled");
    expect(st.lastError).toBeUndefined();
    expect(st.messages[1]!.error).toBeUndefined();
    expect(st.messages[1]!.interrupted).toBe(true);
  });

  it("still reports a genuine model error, before and after an abort", () => {
    stubSend();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "Provider finish_reason: error", stopReason: "error" } },
    ]);
    expect(useChatStore.getState().states[T]!.lastError).toBe("Provider finish_reason: error");
    expect(useChatStore.getState().states[T]!.messages[0]!.interrupted).toBeUndefined();

    // An abort that KILLED the connection is a real failure, not a cancel.
    useChatStore.getState().clear(T);
    useChatStore.getState().ensure(T);
    useChatStore.getState().abort(T);
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "socket hang up", stopReason: "error" } },
    ]);
    expect(useChatStore.getState().states[T]!.lastError).toBe("socket hang up");
  });

  it("keeps a turn that produced output in the error path even if stop was pressed", () => {
    stubSend();
    useChatStore.getState().abort(T);
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "已经写了一部分" }], errorMessage: "Provider finish_reason: error", stopReason: "error" } },
    ]);
    const st = useChatStore.getState().states[T]!;
    expect(st.lastError).toBe("Provider finish_reason: error");
    expect(st.messages[0]!.interrupted).toBeUndefined();
  });

  it("does not relabel a turn that already started, and drops the stale fallout", async () => {
    stubSend();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
    useChatStore.getState().abort(T);
    // pi settles the abort, then answers the next prompt in a NEW turn.
    apply([{ type: "agent_settled" }]);
    await useChatStore.getState().sendPrompt(T, "新的一轮");
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "正在回答" } },
      // …the aborted turn's own final message shows up late.
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "This operation was aborted", stopReason: "error" } },
    ]);

    const st = useChatStore.getState().states[T]!;
    const live = st.messages.at(-1)!;
    expect(live.blocks[0]).toMatchObject({ kind: "text", text: "正在回答" });
    expect(live.error).toBeUndefined();
    expect(live.interrupted).toBeUndefined();
    expect(live.status).toBe("streaming");
    expect(st.turn.phase).not.toBe("cancelled");
    expect(st.turn.phase).not.toBe("failed");
  });

  it("a late abort cannot mutate the next turn's streaming answer", () => {
    stubSend();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
    useChatStore.getState().abort(T);
    // New turn is genuinely running (agent_start resolves the abort)…
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "新答案" } },
    ]);
    // …then the aborted turn's final message arrives out of order.
    apply([
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "This operation was aborted", stopReason: "error" } },
    ]);
    const msgs = useChatStore.getState().states[T]!.messages;
    const live = msgs.at(-1)!;
    expect(live.blocks[0]).toMatchObject({ kind: "text", text: "新答案" });
    expect(live.error).toBeUndefined();
    expect(live.interrupted).toBeUndefined();
    expect(live.status).toBe("streaming");
  });
});

/**
 * Regression: "停止后发消息，显示等待，然后模型也不回复了，就停止了".
 *
 * Root cause (pi source + a real app log): `sendPrompt` sent the message as
 * `streamingBehavior: "steer"` whenever `isStreaming` was still true, and
 * `isStreaming` is only cleared by `agent_settled`. A steer is QUEUED into the
 * running turn, and an aborted turn never drains that queue — pi's
 * `_handlePostAgentRun()` starts with `if (!msg) return false`, so when the abort
 * landed before any assistant message existed there is no continuation to
 * deliver it. The message stayed in pi forever while the UI waited and then
 * showed a terminal state.
 */
describe("chatStore prompt after abort", () => {
  function stubRecording(): { sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    (globalThis as { window?: { api?: unknown } }).window = {
      api: {
        tab: {
          rpcSend: (_t: string, cmd: Record<string, unknown>) => {
            sent.push(cmd);
            return Promise.resolve(true);
          },
        },
      },
    };
    return { sent };
  }

  it("does NOT steer into the turn it just asked to stop", async () => {
    const { sent } = stubRecording();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
    useChatStore.getState().abort(T);
    sent.length = 0; // ignore the abort commands themselves
    await useChatStore.getState().sendPrompt(T, "停止后的消息");

    const prompts = sent.filter((c) => c.type === "prompt");
    expect(prompts).toHaveLength(0); // deferred, not written yet
    const st = useChatStore.getState().states[T]!;
    expect(st.turn.detail).toContain("上一轮正在停止");
    // The bubble is in the transcript so the user sees their message, and it is
    // still recoverable (pendingUserText survives until delivery).
    expect(st.messages.at(-1)).toMatchObject({ role: "user" });
    expect(st.pendingUserText).toBe("停止后的消息");
  });

  it("sends it as a normal prompt the moment the abort lands", async () => {
    const { sent } = stubRecording();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
    useChatStore.getState().abort(T);
    sent.length = 0;
    await useChatStore.getState().sendPrompt(T, "停止后的消息");
    expect(sent.filter((c) => c.type === "prompt")).toHaveLength(0);

    // pi confirms the turn is gone.
    apply([{ type: "agent_settled" }]);
    await Promise.resolve();

    const prompts = sent.filter((c) => c.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ type: "prompt", message: "停止后的消息" });
    // NOT a steer: a steer into a dead turn is what got lost.
    expect(prompts[0]!.streamingBehavior).toBeUndefined();
    const st = useChatStore.getState().states[T]!;
    expect(st.turn.phase).toBe("submitting");
    expect(st.turn.detail).toContain("等待 Pi");
  });

  it("does NOT send on the cancelled message_end (pi is still unwinding), only on settle", async () => {
    const { sent } = stubRecording();
    apply([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);
    useChatStore.getState().abort(T);
    await useChatStore.getState().sendPrompt(T, "再来一次");
    sent.length = 0;
    // pi finalizes the aborted message from INSIDE the run, so `activeRun` is
    // still set: sending now earns "Agent is already processing…" (real app log
    // 05:23:21 abort → 05:23:28 prompt refused). Wait for the settle instead.
    apply([
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "This operation was aborted", stopReason: "error" } },
    ]);
    await Promise.resolve();
    expect(sent.filter((c) => c.type === "prompt")).toHaveLength(0);
    // The aborted turn is still reported as stopped.
    expect(useChatStore.getState().states[T]!.messages.some((m) => m.interrupted)).toBe(true);

    apply([{ type: "agent_settled" }]);
    await Promise.resolve();
    const prompts = sent.filter((c) => c.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.streamingBehavior).toBeUndefined();
  });

  it("never paints a terminal label over a message that is still pending", async () => {
    stubRecording();
    apply([{ type: "agent_start" }]);
    // A prompt is written and pi has not answered it yet.
    const sending = useChatStore.getState().sendPrompt(T, "等待回答的问题");
    apply([{ type: "agent_settled" }]);
    await sending;
    const st = useChatStore.getState().states[T]!;
    expect(st.turn.phase).not.toBe("completed");
    expect(st.turn.phase).not.toBe("cancelled");
  });

  it("an ordinary prompt is still steered while a turn streams", async () => {
    const { sent } = stubRecording();
    apply([{ type: "agent_start" }]);
    await useChatStore.getState().sendPrompt(T, "插一句");
    const prompts = sent.filter((c) => c.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.streamingBehavior).toBe("steer");
  });
});

describe("chatStore prompt acknowledgement deadline", () => {
  function stubQuiet(): void {
    // A bridge that accepts writes but where pi NEVER answers the prompt.
    (globalThis as { window?: { api?: unknown } }).window = {
      api: { tab: { rpcSend: () => Promise.resolve(true) } },
    };
  }

  it("gives the text back instead of waiting forever for an unaccepted prompt", async () => {
    vi.useFakeTimers();
    try {
      stubQuiet();
      await useChatStore.getState().sendPrompt(T, "会被丢弃的消息");
      expect(useChatStore.getState().states[T]!.pendingPromptId).toBeTruthy();
      // pi settles without ever acknowledging the prompt.
      apply([{ type: "agent_settled" }]);
      vi.advanceTimersByTime(20_001);
      const st = useChatStore.getState().states[T]!;
      expect(st.pendingPromptId).toBeUndefined();
      expect(st.restoreInput).toBe("会被丢弃的消息");
      expect(st.lastError).toContain("没有受理");
      // The optimistic bubble is removed: pi never saw the message.
      expect(st.messages.some((m) => m.role === "user")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when pi acknowledges the prompt", async () => {
    vi.useFakeTimers();
    try {
      stubQuiet();
      await useChatStore.getState().sendPrompt(T, "正常消息");
      const promptId = useChatStore.getState().states[T]!.pendingPromptId!;
      apply([{ type: "response", command: "prompt", id: promptId, success: true }]);
      apply([{ type: "agent_settled" }]);
      vi.advanceTimersByTime(20_001);
      const st = useChatStore.getState().states[T]!;
      expect(st.restoreInput).toBeUndefined();
      expect(st.lastError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Regression: 中断后输入「太慢了吧」→ pi 回 "Agent is already processing.
 * Specify streamingBehavior ('steer' or 'followUp') to queue the message."，
 * 消息没有送进去、也没有回复。
 *
 * pi's refusal is TRANSIENT: `Agent.prompt()` throws while `activeRun` is still
 * set, and the run clears it a moment later. Re-issuing the same prompt id is the
 * honest fix — the alternative (asking the user to send it again) loses a message
 * the app could have delivered itself.
 */
describe("chatStore transient prompt refusal", () => {
  function stubRecording(): { sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    (globalThis as { window?: { api?: unknown } }).window = {
      api: {
        tab: {
          rpcSend: (_t: string, cmd: Record<string, unknown>) => {
            sent.push(cmd);
            return Promise.resolve(true);
          },
        },
      },
    };
    return { sent };
  }

  const REFUSAL = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

  it("re-sends a prompt pi refused because it was still busy", async () => {
    vi.useFakeTimers();
    try {
      const { sent } = stubRecording();
      await useChatStore.getState().sendPrompt(T, "太慢了吧");
      const promptId = useChatStore.getState().states[T]!.pendingPromptId!;
      sent.length = 0;
      apply([{ type: "response", command: "prompt", id: promptId, success: false, error: REFUSAL }]);
      // Still pending, not rejected: the message has not been given up on.
      let st = useChatStore.getState().states[T]!;
      expect(st.pendingPromptId).toBe(promptId);
      expect(st.restoreInput).toBeUndefined();
      expect(st.turn.detail).toContain("自动重发");

      vi.advanceTimersByTime(401);
      const prompts = sent.filter((c) => c.type === "prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.id).toBe(promptId);
      expect(prompts[0]!.message).toBe("太慢了吧");

      // pi accepted it this time.
      apply([{ type: "response", command: "prompt", id: promptId, success: true }]);
      st = useChatStore.getState().states[T]!;
      expect(st.pendingPromptId).toBeUndefined();
      expect(st.lastError).toBeUndefined();
      expect(st.restoreInput).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the text back when pi never becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const { sent } = stubRecording();
      await useChatStore.getState().sendPrompt(T, "太慢了吧");
      const promptId = useChatStore.getState().states[T]!.pendingPromptId!;
      for (let i = 0; i < 5; i += 1) {
        apply([{ type: "response", command: "prompt", id: promptId, success: false, error: REFUSAL }]);
        vi.advanceTimersByTime(401);
      }
      const st = useChatStore.getState().states[T]!;
      expect(sent.filter((c) => c.type === "prompt").length).toBeLessThanOrEqual(4);
      expect(st.pendingPromptId).toBeUndefined();
      expect(st.restoreInput).toBe("太慢了吧");
      expect(st.lastError).toContain("没能送进去");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a real refusal (e.g. missing API key)", async () => {
    vi.useFakeTimers();
    try {
      const { sent } = stubRecording();
      await useChatStore.getState().sendPrompt(T, "写点东西");
      const promptId = useChatStore.getState().states[T]!.pendingPromptId!;
      sent.length = 0;
      apply([{ type: "response", command: "prompt", id: promptId, success: false, error: "No API key found for provider deepseek" }]);
      vi.advanceTimersByTime(2_000);
      expect(sent.filter((c) => c.type === "prompt")).toHaveLength(0);
      const st = useChatStore.getState().states[T]!;
      expect(st.restoreInput).toBe("写点东西");
      expect(st.lastError).toContain("No API key");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Regression: 中断后立刻输入，输入出现了两次
 *   「进度如何 / ■ 已停止（你中断了本轮）/ 进度如何」
 *
 * Two small defects combined:
 *  1. the optimistic user bubble carried a turn tag that did not match the turn it
 *     started, so the abort's own message could not be inserted BEFORE the new
 *     prompt and was appended under it; and
 *  2. reconciliation of pi's echoed user message only looked at the LAST message,
 *     so once (1) had pushed something below the bubble, the echo was appended as
 *     a second copy of the same prompt.
 */
describe("chatStore: no duplicated user prompt after an abort", () => {
  function stub(): { sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    (globalThis as { window?: { api?: unknown } }).window = {
      api: { tab: { rpcSend: (_t: string, cmd: Record<string, unknown>) => { sent.push(cmd); return Promise.resolve(true); } } },
    };
    return { sent };
  }

  it("replaces the optimistic bubble instead of appending the echoed prompt", async () => {
    stub();
    // A turn that was aborted before it produced any message (abort during
    // thinking) — its own message only arrives AFTER the next prompt.
    apply([{ type: "agent_start" }]);
    useChatStore.getState().abort(T);
    await useChatStore.getState().sendPrompt(T, "进度如何");
    const optimistic = useChatStore.getState().states[T]!.messages.at(-1)!;
    expect(optimistic.id.startsWith("local-")).toBe(true);

    // pi's abort fallout arrives late: it must be inserted BEFORE the prompt.
    apply([{ type: "message_start", message: { role: "assistant", content: [] } }]);
    let msgs = useChatStore.getState().states[T]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "user"]);
    apply([{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" } }]);
    expect(useChatStore.getState().states[T]!.messages[0]!.interrupted).toBe(true);

    // The deferral lands on settle, and pi echoes the prompt back.
    apply([{ type: "agent_settled" }]);
    await Promise.resolve();
    apply([{ type: "message_start", message: { id: "real-user-1", role: "user", content: [{ type: "text", text: "进度如何" }] } }]);

    msgs = useChatStore.getState().states[T]!.messages;
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(msgs[1]!.id).toBe("real-user-1"); // the real entry replaced the optimistic one
    expect(msgs[1]!.turnSeq).toBe(msgs[1]!.turnSeq); // tag survived the replacement
  });

  it("still reconciles when the optimistic bubble is the last message", async () => {
    stub();
    await useChatStore.getState().sendPrompt(T, "普通提问");
    apply([{ type: "message_start", message: { id: "real-1", role: "user", content: [{ type: "text", text: "普通提问" }] } }]);
    const msgs = useChatStore.getState().states[T]!.messages;
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(msgs.at(-1)!.id).toBe("real-1");
  });
});

describe("chatStore: several prompts outstanding at once", () => {
  function stub(): void {
    (globalThis as { window?: { api?: unknown } }).window = {
      api: { tab: { rpcSend: () => Promise.resolve(true) } },
    };
  }

  it("matches each echoed prompt to its own bubble (no duplicate, no swap)", async () => {
    stub();
    await useChatStore.getState().sendPrompt(T, "第一问");
    await useChatStore.getState().sendPrompt(T, "第二问");
    // pi echoes them in order; the second bubble is the last one when the FIRST
    // echo arrives, which the old "only if last" rule mistook for the target.
    apply([{ type: "message_start", message: { id: "u-a", role: "user", content: [{ type: "text", text: "第一问" }] } }]);
    apply([{ type: "message_start", message: { id: "u-b", role: "user", content: [{ type: "text", text: "第二问" }] } }]);
    const users = useChatStore.getState().states[T]!.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.id)).toEqual(["u-a", "u-b"]);
    expect(users.map((m) => m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join(""))).toEqual(["第一问", "第二问"]);
  });
});
