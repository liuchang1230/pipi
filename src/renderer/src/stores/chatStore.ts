/**
 * Chat state per RPC tab: messages assembled from pi's RPC event stream
 * (message_start/update/end, tool_execution_*, agent_start/settled), plus
 * the native input-box actions (prompt/steer/abort, terminal fallback).
 *
 * Streaming assembly follows rpc.md: message_update carries deltas keyed by
 * contentIndex; message_end.message is the authoritative snapshot.
 */
import { create } from "zustand";

/** Bash prints these for EVERY `bash -ic` exec without a pty. They say the
 *  command had no tty, not that anything failed, so they must never be shown
 *  as the reason a tab ended. */
const SHELL_NOISE = /cannot set terminal process group|no job control in this shell/i;

/** Pick the useful line from a failed pi process's stderr for the exit banner.
 * `bash -i` without a TTY prints job-control noise first; pi's own error (the
 * useful line) comes last. Returns null when there is nothing to show. */
export function pickExitErrorLine(stderr: string | undefined): string | null {
  const lines = (stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  return [...lines].reverse().find((l) => !SHELL_NOISE.test(l)) ?? lines[0]!;
}

/** Transport-level death, as opposed to pi itself failing: our own ssh2/ssh.exe
 *  wording first (see Ssh2Transport in main/rpc-session.ts), then openssh's. */
const CONNECTION_LOSS =
  /SSH 连接|connection (reset|closed|timed out|refused|aborted)|ECONNRESET|ETIMEDOUT|EPIPE|broken pipe|socket hang up|kex_exchange_identification|ssh_exchange_identification|Timeout, server/i;

export interface ExitBanner {
  /** "clean" = pi exited on its own; "connection" = the SSH/pipe transport died
   *  under pi and took it along (pi is not at fault); "crash" = pi itself ended
   *  abnormally. */
  kind: "clean" | "connection" | "crash";
  headline: string;
  /** The stderr line worth showing (bounded), or null when there is nothing
   *  informative — job-control noise is not a cause. */
  detail: string | null;
}

/**
 * What to tell the user when a tab's pi is gone.
 *
 * The distinction matters: exit code -1 is SYNTHESIZED by our transport when the
 * ssh2 connection/channel dies (`reportExit(code ?? -1)` in rpc-session.ts), so
 * a dropped SSH flow under a TUN/VPN proxy reads exactly like a crashed pi. It
 * reported "Pi 进程异常退出" for plain network blips, which sent users hunting the
 * wrong problem — the transport's own message must decide.
 */
export function exitBannerText(code: number | undefined, detail: string | null | undefined): ExitBanner {
  if (code === 0) return { kind: "clean", headline: "Pi 已正常退出，会话已保存在服务器上", detail: null };
  const cause = detail && !SHELL_NOISE.test(detail) ? detail.slice(0, 160) : null;
  if (cause && CONNECTION_LOSS.test(cause)) {
    return { kind: "connection", headline: "与服务器的连接已断开（远端 Pi 已随会话结束）", detail: cause };
  }
  return { kind: "crash", headline: `Pi 进程异常退出（code ${code ?? "?"}）`, detail: cause };
}

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

export type TurnPhase =
  | "booting"
  | "ready"
  | "submitting"
  /** pi's prompt response frame arrived (preflight passed) but no agent event
   *  yet: the turn is pi's now, we are waiting on the model. Distinct from
   *  "submitting" so a stall can be attributed honestly (never accepted vs
   *  accepted-but-silent). */
  | "accepted"
  | "thinking"
  | "streaming"
  | "tool"
  | "retrying"
  | "compacting"
  | "queued"
  | "cancelling"
  | "completed"
  | "failed"
  | "exited";

export interface TurnStatus {
  phase: TurnPhase;
  startedAt?: number;
  lastActivityAt?: number;
  completedAt?: number;
  detail?: string;
}

export interface ChatTabState {
  messages: ChatMessage[];
  /** True from Pi's agent_start until authoritative agent_settled. */
  isStreaming: boolean;
  turn: TurnStatus;
  modelName?: string;
  modelId?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  sessionName?: string | null;
  booted: boolean;
  exited: boolean;
  /** Normal (0) or abnormal exit code from the backend process. */
  exitCode?: number;
  /** Useful stderr line from a failed process (SSH drop, pi crash) — shown in
   *  the exit banner so "远程断了" is distinguishable from "pi 挂了". */
  exitDetail?: string;
  /** Boot progress from the backend (connecting → ready). */
  bootStage?: "connecting" | "starting" | "ready";
  /** History has been fetched at least once (guards ready-signal re-ask). */
  historyLoaded?: boolean;
  lastError?: string;
  pendingUserText?: string;
  /** Command id of the prompt awaiting pi's response frame (the optimistic
   *  turn's identity — see sendPrompt). */
  pendingPromptId?: string;
  /** Display text of a prompt pi REJECTED before it entered the transcript.
   *  ChatView puts it back into the composer instead of dropping the user's
   *  typing on the floor. */
  restoreInput?: string;
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
  /** Drop state for tabs that no longer exist (main's tabs:update is
   *  authoritative). A closed tab used to keep its full transcript — plus the
   *  rAF-batched delta queue — in memory for the rest of the app's run, so
   *  memory grew with every session the user ever opened. */
  retainTabs: (liveTabIds: Set<string>) => void;
  applyEvent: (tabId: string, event: Record<string, unknown>) => void;
  initMessages: (tabId: string, messages: unknown[]) => void;
  markHistoryLoading: (tabId: string) => void;
  /** displayText is kept in the chat bubble; message is the private expanded
   * payload sent to Pi (for example @file contents). */
  sendPrompt: (tabId: string, message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, displayText?: string) => Promise<void>;
  /** Read-and-clear the composer restore request (see ChatTabState.restoreInput). */
  consumeRestoreInput: (tabId: string) => string | undefined;
  abort: (tabId: string) => void;
  markExited: (tabId: string, info: { code: number; stderr?: string }) => void;
}

const emptyState = (): ChatTabState => ({
  messages: [],
  isStreaming: false,
  turn: { phase: "booting" },
  booted: false,
  exited: false,
  retryInfo: null,
  compacting: false,
});

let localSeq = 0;

/** Turn phases that represent work already in flight (never "reset" to ready
 *  by an unrelated state_ready snapshot). */
const pendingTurnPhases = new Set<TurnPhase>(["submitting", "accepted", "thinking", "streaming", "tool", "cancelling", "compacting"]);

/**
 * pi refused the prompt (or the write never left the app), so the message
 * never entered the transcript: drop the optimistic bubble and hand the text
 * back to the composer. Both facts matter — a 500-word prompt that "vanished"
 * with a spinner is worse than an error, and a bubble that pi never saw lies
 * about the session's actual history.
 */
function rejectPrompt(tabId: string, errorText: string): void {
  useChatStore.setState((s) => {
    const cur = s.states[tabId];
    if (!cur) return {};
    const last = cur.messages[cur.messages.length - 1];
    const pending = cur.pendingUserText && cur.pendingUserText.trim() ? cur.pendingUserText : undefined;
    return {
      states: {
        ...s.states,
        [tabId]: {
          ...cur,
          messages: last && last.id.startsWith("local-") ? cur.messages.slice(0, -1) : cur.messages,
          pendingUserText: undefined,
          pendingPromptId: undefined,
          restoreInput: pending,
          lastError: errorText,
          // A refused STEER (running turn) must not relabel that turn: the
          // agent is still working, only the queued message was rejected. The
          // error banner + restored composer carry the news instead.
          turn:
            cur.isStreaming && pendingTurnPhases.has(cur.turn.phase)
              ? cur.turn
              : { phase: "failed", lastActivityAt: Date.now(), detail: errorText },
        },
      },
    };
  });
}

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

/** Restore the authored @mention view from an expanded prompt: pi (and this
 * workbench) embed attached files as `<file name/path="…">…content…</file>`.
 * The chat history must not render that content — collapse it back to `@path`. */
function collapseFileAttachments(text: string): string {
  const collapsed = text.replace(/<file (?:name|path)="([^"]+)">[\s\S]*?<\/file>/g, (_, path: string) => {
    const isAbsolute = /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
    return `@${isAbsolute ? (path.split("/").pop() ?? path) : path}`;
  });
  return collapsed.replace(/\[已附加图片：([^\]]+)\]/g, (_, path: string) => `@${path}`);
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

  retainTabs: (liveTabIds) => {
    // Cheap no-op in the common case (nothing closed) so the subscription
    // does not re-render every chat on each tab-list update.
    const dropped = Object.keys(get().states).filter((id) => !liveTabIds.has(id));
    if (dropped.length === 0) return;
    for (const id of dropped) pendingStreamEvents.delete(id);
    set((s) => {
      const states = { ...s.states };
      for (const id of dropped) delete states[id];
      return { states };
    });
  },

  markExited: (tabId, { code, stderr }) => {
    get().ensure(tabId);
    const detail = pickExitErrorLine(stderr);
    const banner = exitBannerText(code, detail);
    set((s) => ({
      states: {
        ...s.states,
        [tabId]: {
          ...s.states[tabId]!,
          isStreaming: false,
          exited: true,
          // Kept separately from lastError so the exit banner can say WHY
          // (a dropped SSH flow reads very differently from a crashed pi).
          exitDetail: detail ?? undefined,
          // Same classification as the exited bar: an app-killed transport must
          // not be reported as pi crashing here either.
          lastError: banner.kind === "connection"
            ? `与服务器的连接已断开${banner.detail ? `：${banner.detail}` : ""}`
            : code === 0
              ? `pi 进程已退出 (code 0)`
              : `pi 进程已退出 (code ${code})${banner.detail ? `：${banner.detail}` : ""}`,
          exitCode: code,
          turn: { phase: "exited", lastActivityAt: Date.now(), detail: `进程退出（code ${code}）${detail ? ` · ${detail}` : ""}` },
        },
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
          blocks: [{ kind: "text", contentIndex: 0, text: collapseFileAttachments(textOf(m.content)), done: true }],
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

    if (type === "app_phase") {
      const phase = event.phase;
      if (phase === "connecting" || phase === "starting" || phase === "ready") {
        patch({ bootStage: phase });
      }
      return;
    }
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
        bootStage: "ready",
        // A pending prompt (written, not yet answered by pi) is in-flight
        // work even though isStreaming is still false: a stray get_state —
        // the settings refresh, the liveness probe — must not paint it as
        // "已就绪" and hide that the message is still unanswered.
        turn: st.isStreaming || pendingTurnPhases.has(st.turn.phase) ? st.turn : { phase: "ready", lastActivityAt: Date.now() },
      });
      return;
    }
    if (type === "agent_start") {
      patch({
        isStreaming: true,
        lastError: undefined,
        turn: { phase: "thinking", startedAt: Date.now(), lastActivityAt: Date.now() },
      });
      return;
    }
    if (type === "agent_settled") {
      patch({
        isStreaming: false,
        retryInfo: null,
        compacting: false,
        steeringQueue: [],
        followUpQueue: [],
        pendingUserText: undefined,
        turn: st.lastError || st.turn.phase === "failed"
          ? { phase: "failed", lastActivityAt: Date.now(), detail: st.turn.detail ?? st.lastError }
          : { phase: "completed", completedAt: Date.now(), lastActivityAt: Date.now() },
      });
      return;
    }
    if (type === "queue_update") {
      const steering = Array.isArray(event.steering) ? (event.steering as string[]) : st.steeringQueue ?? [];
      const followUp = Array.isArray(event.followUp) ? (event.followUp as string[]) : st.followUpQueue ?? [];
      patch({
        steeringQueue: steering,
        followUpQueue: followUp,
        // A queue is secondary information: don't hide visible output/tool
        // activity behind a generic "queued" status.
        turn: !st.isStreaming && (steering.length || followUp.length)
          ? { phase: "queued", lastActivityAt: Date.now(), detail: `已排队 ${steering.length + followUp.length} 条消息` }
          : st.turn,
      });
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
        turn: { phase: "retrying", lastActivityAt: Date.now(), detail: `第 ${attempt ?? "?"}/${maxAttempts ?? "?"} 次重试` },
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
      patch({ compacting: true, lastError: undefined, turn: { phase: "compacting", lastActivityAt: Date.now(), detail: "正在压缩上下文" } });
      return;
    }
    if (type === "compaction_end") {
      patch({
        compacting: false,
        // Failed compaction is the terminal state for this turn.
        lastError: event.errorMessage && !event.aborted ? (event.errorMessage as string) : undefined,
        turn: event.errorMessage && !event.aborted
          ? { phase: "failed", lastActivityAt: Date.now(), detail: event.errorMessage as string }
          : st.turn,
      });
      return;
    }
    if (type === "response") {
      // pi's verdict on a prompt command. Its response frame is emitted the
      // moment preflight passes (pi rpc-mode.js `case "prompt"` →
      // preflightResult), i.e. BEFORE agent_start / any message event — so it
      // is the only signal that separates "pi is thinking" from "pi never took
      // this message". Ignoring it is what left the UI on "已发送，等待 Pi 开始
      // 处理…" forever when pi refused (no API key / already processing /
      // compaction in flight) or when the response never came at all.
      if (event.command !== "prompt") return;
      const respId = typeof event.id === "string" ? event.id : undefined;
      // Only the composer's own turn is tracked here: main injects other
      // prompts (model-sync) that must not touch the visible turn.
      if (!st.pendingPromptId || respId !== st.pendingPromptId) return;
      if (event.success === false) {
        const reason = typeof event.error === "string" && event.error ? event.error : "Pi 拒绝了这条消息";
        rejectPrompt(tabId, reason);
        return;
      }
      patch({
        pendingPromptId: undefined,
        restoreInput: undefined,
        // A steer ack only means "queued into the running turn" — that turn's
        // phase (streaming/tool) is still the truth, so leave it alone.
        turn: st.isStreaming
          ? st.turn
          : { phase: "accepted", startedAt: st.turn.startedAt ?? Date.now(), lastActivityAt: Date.now() },
      });
      return;
    }
    if (type === "message_start") {
      const m = messageOf(event.message);
      if (!m) return;
      if (m.role === "user") {
        // The optimistic bubble already shows the authored @path form. When
        // pi echoes the full expanded prompt back, keep the display version
        // instead of letting the file contents leak into the transcript.
        const display = st.pendingUserText && st.pendingUserText.trim() ? st.pendingUserText : collapseFileAttachments(textOf(m.content));
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
                blocks: [{ kind: "text" as const, contentIndex: 0, text: display, done: true }],
              },
            ];
          }
          return [
            ...msgs,
            {
              id: m.id ?? `msg-${localSeq++}`,
              role: "user" as const,
              status: "done" as const,
              blocks: [{ kind: "text" as const, contentIndex: 0, text: display, done: true }],
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
            // First visible text proves the model is responding; distinguish it
            // from the opaque pre-response thinking interval.
            patch({ turn: { phase: "streaming", lastActivityAt: Date.now(), detail: "正在回复" } });
            ensureBlock("text");
            (block as { kind: "text"; done: boolean }).done = false;
            break;
          case "text_delta":
            patch({ turn: { phase: "streaming", lastActivityAt: Date.now(), detail: "正在回复" } });
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
            patch({ turn: { phase: "thinking", lastActivityAt: Date.now(), detail: "正在思考" } });
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
            patch({ turn: { phase: "tool", lastActivityAt: Date.now(), detail: "正在准备工具调用" } });
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
      if (type === "tool_execution_start") {
        patch({
          turn: {
            phase: "tool",
            lastActivityAt: Date.now(),
            detail: typeof event.toolName === "string" ? `正在执行 ${event.toolName}` : "正在执行工具",
          },
        });
      }
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
      patch({
        lastError: typeof event.error === "string" ? event.error : "扩展错误",
        turn: { phase: "failed", lastActivityAt: Date.now(), detail: typeof event.error === "string" ? event.error : "扩展错误" },
      });
      return;
    }
    // Ignore: response frames for other commands (handled in ChatView or by
    // rpcRequest) / turn_start / turn_end / auto_retry_* / agent_end /
    // bash_execution_update / summarization_retry_*
  },

  consumeRestoreInput: (tabId) => {
    const pending = get().states[tabId]?.restoreInput;
    if (pending === undefined) return undefined;
    set((s) => ({
      states: { ...s.states, [tabId]: { ...s.states[tabId]!, restoreInput: undefined } },
    }));
    return pending;
  },

  sendPrompt: async (tabId, message, images, displayText = message) => {
    get().ensure(tabId);
    const st = get().states[tabId]!;
    if (st.exited) return;
    const id = `local-${++localSeq}`;
    // pi answers every prompt command with a response frame carrying this id:
    // success = preflight passed (the turn starts), failure = pi refused the
    // prompt (no API key, already processing, compaction running…). Without
    // matching on this id a rejected prompt left the UI at "已发送" forever.
    const promptId = `prompt-${id}`;
    // The visible user bubble deliberately differs from the private prompt
    // payload when @mentions expanded a file. Pi will echo the payload in its
    // message_start event, so pendingUserText keeps reconciliation on the
    // display-safe version as well.
    set((s) => ({
      states: {
        ...s.states,
        [tabId]: {
          ...s.states[tabId]!,
          pendingUserText: displayText,
          pendingPromptId: promptId,
          restoreInput: undefined,
          // A steer joins a turn that is already running: "已发送，等待 Pi 开始
          // 处理…" would be a lie (pi is mid-stream), and the queue banner
          // (queue_update) is the honest feedback for it.
          turn: st.isStreaming
            ? st.turn
            : { phase: "submitting", startedAt: Date.now(), lastActivityAt: Date.now(), detail: "已发送，等待 Pi 开始处理" },
          messages: [
            ...s.states[tabId]!.messages,
            { id, role: "user", status: "done", blocks: [{ kind: "text", contentIndex: 0, text: displayText, done: true }] },
          ],
        },
      },
    }));
    const cmd: Record<string, unknown> = st.isStreaming
      ? { type: "prompt", message, images, streamingBehavior: "steer" }
      : { type: "prompt", message, images };
    const sent = await window.api.tab.rpcSend(tabId, { ...cmd, id: promptId });
    if (!sent) {
      rejectPrompt(tabId, "消息未能发送到 Pi，请重试或切换到终端视图检查连接。");
    }
  },

  abort: (tabId) => {
    get().ensure(tabId);
    set((s) => ({
      states: {
        ...s.states,
        [tabId]: {
          ...s.states[tabId]!,
          turn: { phase: "cancelling", lastActivityAt: Date.now(), detail: "正在停止…" },
        },
      },
    }));
    // Escape in pi's TUI first aborts the active agent turn; if no turn is
    // running it aborts the active bash command. The RPC path has separate
    // commands, so mirror the effective cancellation rather than sending a
    // terminal Escape byte to a headless process.
    void window.api.tab.rpcSend(tabId, { type: "abort" }).catch(() => {});
    void window.api.tab.rpcSend(tabId, { type: "abort_bash" }).catch(() => {});
  },
}));
