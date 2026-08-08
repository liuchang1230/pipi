/**
 * Chat state per RPC tab: messages assembled from pi's RPC event stream
 * (message_start/update/end, tool_execution_*, agent_start/settled), plus
 * the native input-box actions (prompt/steer/abort, terminal fallback).
 *
 * Streaming assembly follows rpc.md: message_update carries deltas keyed by
 * contentIndex; message_end.message is the authoritative snapshot.
 */
import { create } from "zustand";

export type ChatBlock =
  | { kind: "text"; contentIndex: number; text: string; done: boolean }
  | { kind: "thinking"; contentIndex: number; text: string; done: boolean }
  | {
      kind: "tool";
      contentIndex: number;
      toolCallId?: string;
      name?: string;
      argsText: string;
      status: "streaming" | "done";
      resultText?: string;
      isError?: boolean;
      resultDone?: boolean;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  status: "streaming" | "done";
  blocks: ChatBlock[];
}

export interface ChatTabState {
  messages: ChatMessage[];
  isStreaming: boolean;
  modelName?: string;
  modelId?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  sessionName?: string | null;
  booted: boolean;
  exited: boolean;
  lastError?: string;
  pendingUserText?: string;
}

interface ChatStore {
  states: Record<string, ChatTabState>;
  ensure: (tabId: string) => void;
  clear: (tabId: string) => void;
  applyEvent: (tabId: string, event: Record<string, unknown>) => void;
  initMessages: (tabId: string, messages: unknown[]) => void;
  sendPrompt: (tabId: string, text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>) => void;
  abort: (tabId: string) => void;
  markExited: (tabId: string, code: number) => void;
}

const emptyState = (): ChatTabState => ({
  messages: [],
  isStreaming: false,
  booted: false,
  exited: false,
});

let localSeq = 0;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        if (block.type === "text" && typeof block.text === "string") return block.text;
        return "";
      })
      .join("");
  }
  return "";
}

/** Convert a pi AgentMessage content array into ChatBlocks (assistant side). */
function blocksFromContent(content: unknown): ChatBlock[] {
  if (typeof content === "string") {
    return [{ kind: "text", contentIndex: 0, text: content, done: true }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ChatBlock[] = [];
  content.forEach((raw, i) => {
    const b = raw as { type?: string; text?: string; thinking?: string; name?: string; id?: string; arguments?: unknown };
    if (b.type === "text") {
      blocks.push({ kind: "text", contentIndex: i, text: b.text ?? "", done: true });
    } else if (b.type === "thinking") {
      blocks.push({ kind: "thinking", contentIndex: i, text: b.thinking ?? "", done: true });
    } else if (b.type === "toolCall") {
      blocks.push({
        kind: "tool",
        contentIndex: i,
        toolCallId: b.id,
        name: b.name,
        argsText: b.arguments ? JSON.stringify(b.arguments, null, 2) : "",
        status: "done",
        // Historical tool calls are complete; without a toolResult they show
        // as finished with no output rather than an endless running pulse.
        resultDone: true,
      });
    }
  });
  return blocks;
}

interface ToolResultLike {
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
}

/** Attach historical toolResult messages to their toolCall blocks. */
function attachToolResults(messages: ChatMessage[], toolResults: ToolResultLike[]): void {
  for (const tr of toolResults) {
    if (!tr.toolCallId) continue;
    for (let i = messages.length - 1; i >= 0; i--) {
      const target = messages[i]!.blocks.find((b) => b.kind === "tool" && b.toolCallId === tr.toolCallId);
      if (target && target.kind === "tool") {
        target.resultText = textOf(tr.content);
        target.isError = tr.isError;
        target.resultDone = true;
        target.status = "done";
        break;
      }
    }
  }
}

function messageOf(raw: unknown): { id?: string; role?: string; content?: unknown } | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as { id?: string; role?: string; content?: unknown };
  return m;
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  states: {},

  ensure: (tabId) => {
    if (!get().states[tabId]) {
      set((s) => ({ states: { ...s.states, [tabId]: emptyState() } }));
    }
  },

  clear: (tabId) => {
    set((s) => {
      const states = { ...s.states };
      delete states[tabId];
      return { states };
    });
  },

  markExited: (tabId, code) => {
    get().ensure(tabId);
    set((s) => ({
      states: {
        ...s.states,
        [tabId]: { ...s.states[tabId]!, isStreaming: false, exited: true, lastError: `pi 进程已退出 (code ${code})` },
      },
    }));
  },

  initMessages: (tabId, messages) => {
    get().ensure(tabId);
    const chatMessages: ChatMessage[] = [];
    const toolResults: ToolResultLike[] = [];
    for (const raw of messages) {
      const m = messageOf(raw);
      if (!m) continue;
      if (m.role === "user") {
        chatMessages.push({
          id: m.id ?? `hist-${chatMessages.length}`,
          role: "user",
          status: "done",
          blocks: [{ kind: "text", contentIndex: 0, text: textOf(m.content), done: true }],
        });
      } else if (m.role === "assistant") {
        chatMessages.push({
          id: m.id ?? `hist-${chatMessages.length}`,
          role: "assistant",
          status: "done",
          blocks: blocksFromContent(m.content),
        });
      } else if (m.role === "toolResult") {
        toolResults.push(m as ToolResultLike);
      }
    }
    attachToolResults(chatMessages, toolResults);
    set((s) => ({
      states: {
        ...s.states,
        [tabId]: {
          ...s.states[tabId]!,
          messages: chatMessages,
          booted: true,
          // A history reload (navigation/fork) always lands on an idle agent.
          isStreaming: false,
        },
      },
    }));
  },

  applyEvent: (tabId, event) => {
    get().ensure(tabId);
    const st = get().states[tabId]!;
    const type = event.type;

    const patch = (p: Partial<ChatTabState>) =>
      set((s) => ({ states: { ...s.states, [tabId]: { ...s.states[tabId]!, ...p } } }));

    const patchMessages = (fn: (msgs: ChatMessage[]) => ChatMessage[]) =>
      set((s) => ({
        states: { ...s.states, [tabId]: { ...s.states[tabId]!, messages: fn(s.states[tabId]!.messages) } },
      }));

    if (type === "state_ready") {
      const model = (event.model ?? null) as { name?: string; id?: string; provider?: string } | null;
      patch({
        modelName: model?.name ?? model?.id,
        modelId: model?.id,
        modelProvider: model?.provider,
        thinkingLevel: (event.thinkingLevel as string | null | undefined) ?? undefined,
        sessionName: (event.sessionName as string | null) ?? undefined,
        booted: true,
      });
      return;
    }
    if (type === "agent_start") {
      patch({ isStreaming: true, lastError: undefined });
      return;
    }
    if (type === "agent_settled") {
      patch({ isStreaming: false });
      return;
    }
    if (type === "message_start") {
      const m = messageOf(event.message);
      if (!m) return;
      if (m.role === "user") {
        patchMessages((msgs) => {
          const last = msgs[msgs.length - 1];
          // Replace the optimistic user bubble with the real entry.
          if (last && last.role === "user" && last.id.startsWith("local-")) {
            return [
              ...msgs.slice(0, -1),
              {
                id: m.id ?? last.id,
                role: "user" as const,
                status: "done" as const,
                blocks: [{ kind: "text" as const, contentIndex: 0, text: textOf(m.content), done: true }],
              },
            ];
          }
          return [
            ...msgs,
            {
              id: m.id ?? `msg-${localSeq++}`,
              role: "user" as const,
              status: "done" as const,
              blocks: [{ kind: "text" as const, contentIndex: 0, text: textOf(m.content), done: true }],
            },
          ];
        });
      } else if (m.role === "assistant") {
        const blocks = blocksFromContent(m.content);
        patchMessages((msgs) => [
          ...msgs,
          { id: m.id ?? `msg-${localSeq++}`, role: "assistant", status: "streaming", blocks },
        ]);
      }
      return;
    }
    if (type === "message_end") {
      const m = messageOf(event.message);
      if (!m || m.role !== "assistant") return;
      patchMessages((msgs) => {
        const idx = msgs.length - 1;
        if (idx < 0 || msgs[idx]!.role !== "assistant") return msgs;
        return [
          ...msgs.slice(0, idx),
          { ...msgs[idx]!, status: "done" as const, blocks: blocksFromContent(m.content) },
        ];
      });
      return;
    }
    if (type === "message_update") {
      const ev = (event.assistantMessageEvent ?? {}) as {
        type?: string;
        contentIndex?: number;
        delta?: string;
        content?: string;
        id?: string;
        name?: string;
        toolCall?: { id?: string; name?: string; arguments?: unknown };
      };
      patchMessages((msgs) => {
        const idx = msgs.length - 1;
        if (idx < 0 || msgs[idx]!.role !== "assistant") return msgs;
        const msg = msgs[idx]!;
        const ci = ev.contentIndex ?? 0;
        const blocks = msg.blocks.map((b) => ({ ...b }));
        let block = blocks.find((b) => b.contentIndex === ci) as (typeof blocks)[number] | undefined;

        const ensureBlock = (kind: "text" | "thinking" | "tool") => {
          if (!block) {
            block =
              kind === "tool"
                ? ({ kind, contentIndex: ci, toolCallId: ev.id, name: ev.name, argsText: "", status: "streaming" } as ChatBlock)
                : ({ kind, contentIndex: ci, text: "", done: false } as ChatBlock);
            blocks.push(block);
          } else if (block.kind !== kind) {
            const replacement: ChatBlock =
              kind === "tool"
                ? { kind, contentIndex: ci, toolCallId: ev.id, name: ev.name, argsText: "", status: "streaming" }
                : { kind, contentIndex: ci, text: "", done: false };
            const i = blocks.indexOf(block);
            blocks[i] = replacement;
            block = replacement;
          }
          return block;
        };

        switch (ev.type) {
          case "text_start":
            ensureBlock("text");
            (block as { kind: "text"; done: boolean }).done = false;
            break;
          case "text_delta":
            ensureBlock("text");
            (block as { kind: "text"; text: string }).text += ev.delta ?? "";
            break;
          case "text_end":
            ensureBlock("text");
            {
              const t = block as { kind: "text"; text: string; done: boolean };
              if (typeof ev.content === "string") t.text = ev.content;
              t.done = true;
            }
            break;
          case "thinking_start":
            ensureBlock("thinking");
            (block as { kind: "thinking"; done: boolean }).done = false;
            break;
          case "thinking_delta":
            ensureBlock("thinking");
            (block as { kind: "thinking"; text: string }).text += ev.delta ?? "";
            break;
          case "thinking_end":
            ensureBlock("thinking");
            {
              const t = block as { kind: "thinking"; text: string; done: boolean };
              if (typeof ev.content === "string") t.text = ev.content;
              t.done = true;
            }
            break;
          case "toolcall_start":
            ensureBlock("tool");
            {
              const t = block as { kind: "tool"; toolCallId?: string; name?: string };
              if (ev.id) t.toolCallId = ev.id;
              if (ev.name) t.name = ev.name;
            }
            break;
          case "toolcall_delta":
            ensureBlock("tool");
            (block as { kind: "tool"; argsText: string }).argsText += ev.delta ?? "";
            break;
          case "toolcall_end":
            ensureBlock("tool");
            {
              const t = block as { kind: "tool"; toolCallId?: string; name?: string; argsText: string; status: string };
              if (ev.toolCall) {
                if (ev.toolCall.id) t.toolCallId = ev.toolCall.id;
                if (ev.toolCall.name) t.name = ev.toolCall.name;
                if (ev.toolCall.arguments) t.argsText = JSON.stringify(ev.toolCall.arguments, null, 2);
              }
              t.status = "streaming";
            }
            break;
          default:
            return msgs;
        }
        return [...msgs.slice(0, idx), { ...msg, blocks }];
      });
      return;
    }
    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      const toolCallId = event.toolCallId as string | undefined;
      if (!toolCallId) return;
      patchMessages((msgs) => {
        const out = msgs.map((m) => ({ ...m, blocks: m.blocks.map((b) => ({ ...b })) }));
        for (let i = out.length - 1; i >= 0; i--) {
          const target = out[i]!.blocks.find((b) => b.kind === "tool" && b.toolCallId === toolCallId);
          if (target && target.kind === "tool") {
            if (type === "tool_execution_start") {
              const args = event.args as Record<string, unknown> | undefined;
              target.status = "streaming";
              if (event.toolName) target.name = event.toolName as string;
              if (args && Object.keys(args).length > 0) target.argsText = JSON.stringify(args, null, 2);
              target.resultText = "";
              target.resultDone = false;
            } else if (type === "tool_execution_update") {
              const pr = event.partialResult as { content?: unknown } | undefined;
              target.resultText = pr ? textOf(pr.content) : target.resultText;
            } else {
              const res = event.result as { content?: unknown } | undefined;
              if (res) target.resultText = textOf(res.content);
              target.isError = !!event.isError;
              target.resultDone = true;
              target.status = "done";
            }
            break;
          }
        }
        return out;
      });
      return;
    }
    if (type === "extension_error") {
      patch({ lastError: typeof event.error === "string" ? event.error : "扩展错误" });
      return;
    }
    // Ignore: response / turn_start / turn_end / queue_update / compaction_* /
    // auto_retry_* / agent_end / bash_execution_update / summarization_retry_*
  },

  sendPrompt: (tabId, text, images) => {
    get().ensure(tabId);
    const st = get().states[tabId]!;
    if (st.exited) return;
    const id = `local-${++localSeq}`;
    // Optimistic user bubble; message_start replaces it with the real entry.
    set((s) => ({
      states: {
        ...s.states,
        [tabId]: {
          ...s.states[tabId]!,
          messages: [
            ...s.states[tabId]!.messages,
            { id, role: "user", status: "done", blocks: [{ kind: "text", contentIndex: 0, text, done: true }] },
          ],
        },
      },
    }));
    const cmd: Record<string, unknown> = st.isStreaming
      ? { type: "prompt", message: text, images, streamingBehavior: "steer" }
      : { type: "prompt", message: text, images };
    void window.api.tab.rpcSend(tabId, cmd);
  },

  abort: (tabId) => {
    void window.api.tab.rpcSend(tabId, { type: "abort" });
  },
}));
