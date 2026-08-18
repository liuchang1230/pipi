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
  /** Model stream error on this message (e.g. "Provider finish_reason: error"). */
  error?: string;
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
  /** History has been fetched at least once (guards ready-signal re-ask). */
  historyLoaded?: boolean;
  lastError?: string;
  pendingUserText?: string;
  /** Model stream error → pi exponential-backoff retry progress. */
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage: string } | null;
  /** Context compaction running (auto/manual). */
  compacting?: boolean;
  /** Pending steering messages (queue_update; delivered between turns). */
  steeringQueue?: string[];
  /** Pending follow-up messages (queue_update; delivered when agent settles). */
  followUpQueue?: string[];
  /** Queue delivery modes + auto compaction, from get_state. */
  steeringMode?: string;
  followUpMode?: string;
  autoCompactionEnabled?: boolean;
}

interface ChatStore {
  states: Record<string, ChatTabState>;
  ensure: (tabId: string) => void;
  clear: (tabId: string) => void;
  applyEvent: (tabId: string, event: Record<string, unknown>) => void;
  initMessages: (tabId: string, messages: unknown[]) => void;
  markHistoryLoading: (tabId: string) => void;
  sendPrompt: (tabId: string, text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>) => void;
  abort: (tabId: string) => void;
  markExited: (tabId: string, code: number) => void;
}

const emptyState = (): ChatTabState => ({
  messages: [],
  isStreaming: false,
  booted: false,
  exited: false,
  retryInfo: null,
  compacting: false,
});

let localSeq = 0;

// Streaming can produce hundreds of tiny deltas per second. Expose one
// normal `applyEvent` Interface to callers, but coalesce visual-only deltas
// behind this seam and commit them at most once per animation frame. Lifecycle
// events (start/end/errors) remain immediate, so controls never feel delayed.
const pendingStreamEvents = new Map<string, Map<string, Record<string, unknown>>>();
const releasedStreamEvents = new WeakSet<object>();
let streamFrame: number | ReturnType<typeof setTimeout> | null = null;
const scheduleStreamFrame =
  typeof requestAnimationFrame === "function"
    ? (callback: FrameRequestCallback) => requestAnimationFrame(callback)
    : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16);

function streamEventKey(event: Record<string, unknown>): string | null {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent as { type?: string; contentIndex?: number } | undefined;
    if (update?.type === "text_delta" || update?.type === "thinking_delta" || update?.type === "toolcall_delta") {
      return `message:${update.type}:${update.contentIndex ?? 0}`;
    }
  }
  if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") return `tool:${event.toolCallId}`;
  return null;
}

function flushQueuedStreamEvents(tabId: string): void {
  const events = pendingStreamEvents.get(tabId);
  if (!events) return;
  pendingStreamEvents.delete(tabId);
  for (const queued of events.values()) {
    releasedStreamEvents.add(queued);
    useChatStore.getState().applyEvent(tabId, queued);
  }
}

function queueStreamEvent(tabId: string, key: string, event: Record<string, unknown>): void {
  let tabEvents = pendingStreamEvents.get(tabId);
  if (!tabEvents) pendingStreamEvents.set(tabId, (tabEvents = new Map()));
  const previous = tabEvents.get(key);
  if (previous?.type === "message_update" && event.type === "message_update") {
    const oldUpdate = previous.assistantMessageEvent as Record<string, unknown>;
    const nextUpdate = event.assistantMessageEvent as Record<string, unknown>;
    // Merge contiguous text/thinking/tool argument deltas so one store update
    // renders an entire frame's worth of model output.
    tabEvents.set(key, {
      ...event,
      assistantMessageEvent: { ...nextUpdate, delta: `${oldUpdate.delta ?? ""}${nextUpdate.delta ?? ""}` },
    });
  } else {
    // A tool partial result is a snapshot: only the newest one matters.
    tabEvents.set(key, event);
  }
  if (streamFrame !== null) return;
  streamFrame = scheduleStreamFrame(() => {
    streamFrame = null;
    const tabIds = [...pendingStreamEvents.keys()];
    for (const id of tabIds) flushQueuedStreamEvents(id);
  });
}

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

/** Does this text look like a git/unified diff already? */
function isDiffish(text: string): boolean {
  return text.startsWith("diff --git") || /^[+-]{3} \S/m.test(text) || /^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(text);
}

/**
 * Best display text for a tool result: pi's edit tool puts the real diff in
 * `result.details` (patch is standard unified, diff is a line-number format).
 * Prefer those so tool cards and file aggregation see actual changes.
 */
function resultTextOf(res: { content?: unknown; details?: { diff?: unknown; patch?: unknown } } | undefined): string {
  if (!res) return "";
  const text = textOf(res.content);
  const patch = res.details?.patch;
  const diff = res.details?.diff;
  if (typeof patch === "string" && patch.trim() && !isDiffish(text)) return patch;
  if (typeof diff === "string" && diff.trim() && !isDiffish(text)) return diff;
  return text;
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
  details?: { diff?: unknown };
}

/** Attach historical toolResult messages to their toolCall blocks. */
function attachToolResults(messages: ChatMessage[], toolResults: ToolResultLike[]): void {
  for (const tr of toolResults) {
    if (!tr.toolCallId) continue;
    for (let i = messages.length - 1; i >= 0; i--) {
      const target = messages[i]!.blocks.find((b) => b.kind === "tool" && b.toolCallId === tr.toolCallId);
      if (target && target.kind === "tool") {
        target.resultText = resultTextOf(tr);
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
    // A closed/switched session must never receive a stale rAF-batched delta.
    pendingStreamEvents.delete(tabId);
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
        const raw = m as { errorMessage?: string; stopReason?: string };
        const error = raw.errorMessage || raw.stopReason === "error" ? (raw.errorMessage ?? "模型返回错误") : undefined;
        chatMessages.push({
          id: m.id ?? `hist-${chatMessages.length}`,
          role: "assistant",
          status: "done",
          blocks: blocksFromContent(m.content),
          error,
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
          historyLoaded: true,
          // A history reload must not clear live output that arrived after
          // the request was sent. The ChatView request generation decides
          // whether this snapshot is still current before calling here.
          isStreaming: s.states[tabId]!.isStreaming,
        },
      },
    }));
  },

  markHistoryLoading: (tabId) => {
    get().ensure(tabId);
    set((s) => ({
      states: { ...s.states, [tabId]: { ...s.states[tabId]!, historyLoaded: false } },
    }));
  },

  applyEvent: (tabId, event) => {
    const streamKey = streamEventKey(event);
    if (streamKey && !releasedStreamEvents.has(event)) {
      queueStreamEvent(tabId, streamKey, event);
      return;
    }
    if (releasedStreamEvents.has(event)) releasedStreamEvents.delete(event);
    // Authoritative/lifecycle events are ordering barriers. Commit every
    // preceding visual delta before they replace a final snapshot, finish a
    // tool, advance to another assistant message, or settle the agent.
    if (
      event.type === "message_end" ||
      event.type === "agent_settled" ||
      event.type === "tool_execution_end" ||
      (event.type === "message_start" && (event.message as { role?: string } | undefined)?.role === "assistant")
    ) {
      flushQueuedStreamEvents(tabId);
    }
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
        steeringMode: (event.steeringMode as string | undefined) ?? st.steeringMode,
        followUpMode: (event.followUpMode as string | undefined) ?? st.followUpMode,
        autoCompactionEnabled: (event.autoCompactionEnabled as boolean | undefined) ?? st.autoCompactionEnabled,
        booted: true,
      });
      return;
    }
    if (type === "agent_start") {
      patch({ isStreaming: true, lastError: undefined });
      return;
    }
    if (type === "agent_settled") {
      patch({ isStreaming: false, retryInfo: null, compacting: false, steeringQueue: [], followUpQueue: [] });
      return;
    }
    if (type === "queue_update") {
      const steering = Array.isArray(event.steering) ? (event.steering as string[]) : st.steeringQueue ?? [];
      const followUp = Array.isArray(event.followUp) ? (event.followUp as string[]) : st.followUpQueue ?? [];
      patch({ steeringQueue: steering, followUpQueue: followUp });
      return;
    }
    if (type === "auto_retry_start") {
      const attempt = event.attempt as number | undefined;
      const maxAttempts = event.maxAttempts as number | undefined;
      const errorMessage = (event.errorMessage as string | undefined) ?? "Unknown error";
      patch({
        retryInfo:
          attempt !== undefined && maxAttempts !== undefined
            ? { attempt, maxAttempts, errorMessage }
            : null,
        // Not a final error yet — pi is retrying with backoff.
        lastError: undefined,
      });
      return;
    }
    if (type === "auto_retry_end") {
      // success=false after exhausting retries: surface the final error.
      // "Retry cancelled" is the user aborting — keep the banner silent.
      const finalError = event.finalError as string | undefined;
      const cancelled = finalError === "Retry cancelled";
      patch({
        retryInfo: null,
        lastError: !cancelled && event.success === false && finalError ? finalError : undefined,
      });
      return;
    }
    if (type === "compaction_start") {
      patch({ compacting: true, lastError: undefined });
      return;
    }
    if (type === "compaction_end") {
      patch({
        compacting: false,
        // Failed compaction is the terminal state for this turn.
        lastError: event.errorMessage && !event.aborted ? (event.errorMessage as string) : undefined,
      });
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
      // Model stream errors (e.g. "Provider finish_reason: error") ride on
      // the finished assistant message. Attach to the message so the error
      // stays visible in history (a later successful retry emits another
      // message_end without errorMessage and clears the transient banner).
      const errMsg = (m as { errorMessage?: string; stopReason?: string }).errorMessage;
      const stopReason = (m as { stopReason?: string }).stopReason;
      const error = errMsg || stopReason === "error" ? (errMsg ?? "模型返回错误") : undefined;
      patch({ lastError: error });
      patchMessages((msgs) => {
        const idx = msgs.length - 1;
        if (idx < 0 || msgs[idx]!.role !== "assistant") return msgs;
        return [
          ...msgs.slice(0, idx),
          {
            ...msgs[idx]!,
            status: "done" as const,
            blocks: blocksFromContent(m.content),
            error,
          },
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
              const pr = event.partialResult as { content?: unknown; details?: { diff?: unknown } } | undefined;
              target.resultText = pr ? resultTextOf(pr) : target.resultText;
            } else {
              const res = event.result as { content?: unknown; details?: { diff?: unknown } } | undefined;
              if (res) target.resultText = resultTextOf(res);
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
    // Ignore: response / turn_start / turn_end / compaction_* /
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
    // Escape in pi's TUI first aborts the active agent turn; if no turn is
    // running it aborts the active bash command. The RPC path has separate
    // commands, so mirror the effective cancellation rather than sending a
    // terminal Escape byte to a headless process.
    void window.api.tab.rpcSend(tabId, { type: "abort" }).catch(() => {});
    void window.api.tab.rpcSend(tabId, { type: "abort_bash" }).catch(() => {});
  },
}));
