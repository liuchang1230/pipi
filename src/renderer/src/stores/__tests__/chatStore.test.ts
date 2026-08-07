// Chat store reducer tests: feed the store the exact event shapes pi's RPC
// mode emits (verified against a live pi --mode rpc session) and assert the
// assembled message list.
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../chatStore";

const T = "tab-test";

function apply(events: Record<string, unknown>[]): void {
  for (const e of events) useChatStore.getState().applyEvent(T, e);
}

beforeEach(() => {
  useChatStore.getState().clear(T);
  useChatStore.getState().ensure(T);
});

describe("chatStore streaming assembly", () => {
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
});
