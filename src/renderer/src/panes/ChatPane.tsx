/**
 * ChatPane: native chat view for RPC-backed pi tabs.
 *
 * Renders messages assembled from pi's RPC event stream (chatStore) with a
 * real <textarea> input box — mouse click-to-position, drag-selection and
 * direct deletion are native browser behavior. A "终端视图" button falls
 * back to the full TUI (same tab id) for anything that needs it.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Markdown from "../Markdown";
import { useChatStore, type ChatBlock, type ChatMessage } from "../stores/chatStore";
import { useTabsStore } from "../stores/tabsStore";
import { useUiStore } from "../stores/uiStore";
import { UiDialog, handleFireAndForget, type UiRequest } from "../dialogs/UiDialog";
import { TreeDialog } from "../dialogs/TreeDialog";
import { DiffView, editsToDiff, isDiffish } from "../components/DiffView";
import { SlashMenu } from "../components/SlashMenu";
import { SkillChips } from "../components/SkillChips";
import {
  commandTokenAt,
  fetchCommands,
  filterCommands,
  invalidateCommands,
  replaceCommandToken,
  type SessionCommand,
} from "../commands";

// --- Block renderers --------------------------------------------------------

function ThinkingBlock({ block }: { block: Extract<ChatBlock, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const streaming = !block.done;
  return (
    <details className="chat-thinking" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{streaming ? "思考中…" : `思考过程${open ? "" : `（${block.text.length} 字）`}`}</summary>
      <pre className="chat-thinking-body">{block.text}</pre>
    </details>
  );
}

const INLINE_PREVIEW_MAX_CHARS = 24_000;

function CollapsibleText({
  text,
  className,
  label,
}: {
  text: string;
  className: string;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > INLINE_PREVIEW_MAX_CHARS;
  const shown = truncated && !expanded ? text.slice(0, INLINE_PREVIEW_MAX_CHARS) : text;
  return (
    <>
      <pre className={className}>{shown || "(空)"}</pre>
      {truncated && (
        <button className="chat-expand-output" onClick={() => setExpanded((value) => !value)}>
          {expanded ? `收起 ${label}` : `展开完整${label}（${text.length.toLocaleString()} 字）`}
        </button>
      )}
    </>
  );
}

function ToolBlock({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const [showArgs, setShowArgs] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const running = block.status === "streaming";
  const resultText = block.resultText ?? "";
  const isDiff = isDiffish(resultText);
  // edit tool: render a real diff from args (oldText→newText) even before
  // the result arrives — args-only JSON is unreadable.
  const editDiff = useMemo(() => {
    if (block.name !== "edit") return null;
    try {
      const args = JSON.parse(block.argsText || "{}") as { path?: string; edits?: Array<{ oldText: string; newText: string }> };
      if (!Array.isArray(args.edits) || !args.edits.length) return null;
      return editsToDiff(args.path, args.edits);
    } catch {
      return null;
    }
  }, [block.name, block.argsText]);
  // bash tool: render the command as a shell snippet rather than exposing its
  // transport JSON (`{ command, cwd, timeout… }`) to the user.
  const bashPreview = useMemo(() => {
    if (block.name !== "bash") return null;
    try {
      const args = JSON.parse(block.argsText || "{}") as { command?: unknown; cwd?: unknown; timeout?: unknown };
      if (typeof args.command !== "string") return null;
      return {
        command: args.command,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        timeout: typeof args.timeout === "number" ? args.timeout : undefined,
      };
    } catch {
      return null;
    }
  }, [block.name, block.argsText]);
  // write tool: show path + content preview instead of JSON args.
  const writePreview = useMemo(() => {
    if (block.name !== "write_file" && block.name !== "write") return null;
    try {
      const args = JSON.parse(block.argsText || "{}") as { path?: string; content?: string };
      if (typeof args.content !== "string" && typeof args.path !== "string") return null;
      return { path: args.path ?? "", content: args.content ?? "" };
    } catch {
      return null;
    }
  }, [block.name, block.argsText]);
  // apply_patch: the patch argument is already a unified diff → render it.
  const patchDiff = useMemo(() => {
    if (block.name !== "apply_patch" && block.name !== "patch") return null;
    try {
      const args = JSON.parse(block.argsText || "{}") as { patch?: unknown };
      if (typeof args.patch === "string" && isDiffish(args.patch)) return args.patch;
    } catch {
      /* partial args */
    }
    return null;
  }, [block.name, block.argsText]);
  // JSON result texts get pretty-printed instead of raw single-line dumps.
  const prettyResult = useMemo(() => {
    const t = resultText.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return null;
    }
  }, [resultText]);
  return (
    <div className={`chat-tool${block.isError ? " error" : ""}`}>
      <div className="chat-tool-head" onClick={() => setShowArgs((v) => !v)}>
        <span className={`chat-tool-dot${running ? " running" : ""}`} />
        <span className="chat-tool-name">{block.name ?? "tool"}</span>
        <span className="chat-tool-toggle">{showArgs ? "▾" : "▸"}</span>
      </div>
      {showArgs && bashPreview && (
        <div className="chat-tool-command">
          {bashPreview.cwd && <div className="chat-tool-command-meta">$ cd {bashPreview.cwd}</div>}
          <pre><code>{bashPreview.command}</code></pre>
          {bashPreview.timeout !== undefined && <div className="chat-tool-command-meta">超时：{bashPreview.timeout} ms</div>}
        </div>
      )}
      {showArgs && !bashPreview && !writePreview && (editDiff ? (
        <div className="chat-tool-editdiff">
          <div className="chat-tool-result-head">编辑参数（diff 视图）</div>
          <DiffView diffText={editDiff} />
        </div>
      ) : patchDiff ? (
        <div className="chat-tool-editdiff">
          <div className="chat-tool-result-head">补丁内容（diff 视图）</div>
          <DiffView diffText={patchDiff} />
        </div>
      ) : (
        <pre className="chat-tool-args">
          {block.argsText || (running ? "(参数生成中…)" : "")}
        </pre>
      ))}
      {showArgs && writePreview && (
        <div className="chat-tool-editdiff">
          <div className="chat-tool-result-head">写入 {writePreview.path || "（未知路径）"}</div>
          <pre className="chat-tool-write-preview">{writePreview.content || "（空内容）"}</pre>
        </div>
      )}
      {editDiff && !isDiff && (
        <div className="chat-tool-editdiff">
          <div className="chat-tool-result-head">编辑预览</div>
          <DiffView diffText={editDiff} />
        </div>
      )}
      {(block.resultDone || running) && (
        <div className="chat-tool-result-wrap" onClick={() => setShowResult((v) => !v)}>
          <div className="chat-tool-result-head">
            {running ? "执行中…" : block.isError ? "执行失败" : "执行结果"}
            <span>{showResult ? "▾" : "▸"}</span>
          </div>
          {showResult &&
            (isDiff ? (
              <div className="chat-tool-result diff">
                <DiffView diffText={resultText} />
              </div>
            ) : prettyResult ? (
              <CollapsibleText text={prettyResult} className={`chat-tool-result${block.isError ? " error" : ""}`} label="结果" />
            ) : (
              <CollapsibleText text={resultText} className={`chat-tool-result${block.isError ? " error" : ""}`} label="结果" />
            ))}
        </div>
      )}
    </div>
  );
}

const CHAT_MARKDOWN_MAX_CHARS = 120_000;

const AssistantBlocks = memo(function AssistantBlocks({ blocks }: { blocks: ChatBlock[] }) {
  return (
    <div className="chat-msg-blocks">
      {blocks.map((b, i) => {
        if (b.kind === "thinking") return <ThinkingBlock key={i} block={b} />;
        if (b.kind === "tool") return <ToolBlock key={i} block={b} />;
        const text = b.kind === "text" ? b.text : "";
        if (!text.trim()) return <div key={i} className="chat-msg-empty" />;
        // Markdown parsing + highlight.js on every token is much more
        // expensive than the terminal's plain text paint. Keep the active
        // block lightweight and parse Markdown once the block is complete.
        if (b.kind === "text" && !b.done) {
          return <div key={i} className="chat-msg-md chat-msg-streaming">{text}</div>;
        }
        return (
          <div key={i} className="chat-msg-md">
            <Markdown content={text} plainCode={text.length > CHAT_MARKDOWN_MAX_CHARS} disableStrikeThrough />
          </div>
        );
      })}
    </div>
  );
});

const MessageView = memo(function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.blocks[0]?.kind === "text" ? message.blocks[0].text : "";
    return (
      <div className="chat-msg user">
        <div className="chat-bubble user">{text}</div>
      </div>
    );
  }
  return (
    <div className="chat-msg assistant">
      <div className="chat-bubble assistant">
        <AssistantBlocks blocks={message.blocks} />
        {message.error && <div className="chat-msg-error">⚠ 模型错误：{message.error}</div>}
      </div>
    </div>
  );
});

/** 聊天页更新通知条：pi 更新 + 内置扩展更新。与全局 UpdateBanner 读同一
 * uiStore（更新成功/关闭在任意一处生效，两处同步消失）。 */
function ChatNotices() {
  const appUpdateInfo = useUiStore((s) => s.appUpdateInfo);
  const updateInfo = useUiStore((s) => s.updateInfo);
  const extNotice = useUiStore((s) => s.extNotice);
  const [busy, setBusy] = useState(false);
  if (!appUpdateInfo && !updateInfo && !extNotice) return null;
  return (
    <div className="chat-notices">
      {appUpdateInfo && (
        <div className="chat-notice update">
          <span className="chat-notice-text" title={appUpdateInfo.notes || undefined}>
            pipi 有新版本：{appUpdateInfo.current} → {appUpdateInfo.latest} — 下载后运行安装包即可覆盖升级
          </span>
          <button
            className="btn btn-primary chat-notice-btn"
            onClick={async () => {
              if (!appUpdateInfo.downloadUrl || !(await window.api.appUpdate.download(appUpdateInfo.downloadUrl))) {
                useUiStore.getState().showToast("无法打开 GitHub 下载页，请稍后重试", "err");
              }
            }}
          >下载更新</button>
          <button className="chat-notice-close" onClick={() => useUiStore.getState().setAppUpdateInfo(null)} title="关闭">×</button>
        </div>
      )}
      {extNotice && (
        <div className="chat-notice">
          <span className="chat-notice-text">
            内置扩展已更新：{extNotice.files.join("、")} — 新开的会话将使用新版本
          </span>
          <button className="chat-notice-close" onClick={() => useUiStore.getState().setExtNotice(null)} title="关闭">×</button>
        </div>
      )}
      {updateInfo && (
        <div className="chat-notice update">
          <span className="chat-notice-text">
            pi 有新版本：{updateInfo.current} → {updateInfo.latest}（含扩展包更新）
          </span>
          <button
            className="btn btn-primary chat-notice-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await window.api.update.run();
              setBusy(false);
              if (r.ok) {
                useUiStore.getState().setUpdateInfo(null);
                useUiStore.getState().showToast("更新完成，请重启标签页生效", "ok");
              } else {
                useUiStore.getState().showToast(`更新失败: ${r.error ?? r.output.slice(0, 120)}`, "err");
              }
            }}
          >
            {busy ? "更新中…" : "立即更新"}
          </button>
          <button className="chat-notice-close" onClick={() => useUiStore.getState().setUpdateInfo(null)} title="关闭">×</button>
        </div>
      )}
    </div>
  );
}

// Windowed chat history: rendering hundreds of messages through
// react-markdown + highlight.js freezes the UI for seconds. Render only the
// most recent chunk and reveal older messages on scroll-up.
const INITIAL_VISIBLE = 60;
const VISIBLE_STEP = 60;

// --- Stream-isolated timeline ----------------------------------------------
// This module owns the only high-frequency `messages` subscription. Its
// Interface is intentionally small: callers provide a tab id, while message
// windowing, scroll anchoring, and status rendering stay local. Token updates
// therefore never re-render the header, menus, or editable textarea.
const HIDDEN_TIMELINE = {
  messages: [] as ChatMessage[],
  isStreaming: false,
  booted: false,
  compacting: false,
  retryInfo: null,
  steeringQueue: [] as string[],
  followUpQueue: [] as string[],
  lastError: undefined as string | undefined,
};

const ChatTimeline = memo(function ChatTimeline({ tabId, bootTimedOut }: { tabId: string; bootTimedOut: boolean }) {
  const timeline = useChatStore(useShallow((s) => {
    const st = s.states[tabId];
    // Zustand selectors must return a stable snapshot while the async session
    // boot is still creating its state. Fresh `[]` fallbacks make React see a
    // different store snapshot on every read, which can cause a render loop
    // and a blank chat page before `ensure(tabId)` runs.
    if (!st) return HIDDEN_TIMELINE;
    return {
      messages: st.messages,
      isStreaming: st.isStreaming,
      booted: st.booted,
      compacting: !!st.compacting,
      retryInfo: st.retryInfo ?? null,
      steeringQueue: st.steeringQueue ?? HIDDEN_TIMELINE.steeringQueue,
      followUpQueue: st.followUpQueue ?? HIDDEN_TIMELINE.followUpQueue,
      lastError: st.lastError,
    };
  }));
  const { messages, isStreaming } = timeline;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const revealAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const revealLockedRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const visibleMessages = useMemo(() => messages.slice(-visibleCount), [messages, visibleCount]);
  const hiddenCount = messages.length - visibleMessages.length;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = revealAnchorRef.current;
    if (anchor) {
      revealAnchorRef.current = null;
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      requestAnimationFrame(() => { revealLockedRef.current = false; });
      return;
    }
    if (!stickToBottom.current || scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const current = scrollRef.current;
      if (current && stickToBottom.current) current.scrollTop = current.scrollHeight;
    });
  }, [messages, isStreaming, visibleMessages]);
  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const revealOlder = () => {
    const el = scrollRef.current;
    if (!el || revealLockedRef.current || hiddenCount <= 0) return;
    revealLockedRef.current = true;
    revealAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setVisibleCount((count) => Math.min(count + VISIBLE_STEP, messages.length));
  };

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={(e) => {
      const el = e.currentTarget;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }} onWheel={(e) => {
      if (e.deltaY < 0 && e.currentTarget.scrollTop < 80) revealOlder();
    }}>
      {!timeline.booted && !bootTimedOut && <div className="chat-placeholder">正在启动 pi…</div>}
      {!timeline.booted && bootTimedOut && <div className="chat-error-banner">pi 启动超时（远程服务器可能未安装 pi，或连接失败）。可切换到终端视图排查。</div>}
      {messages.length === 0 && timeline.booted && <div className="chat-placeholder">输入问题开始对话（鼠标可直接点击、选中、编辑输入内容）</div>}
      {hiddenCount > 0 && <div className="chat-load-older" onClick={revealOlder}>↑ 更早的消息已折叠（还有 {hiddenCount} 条）— 点击或滚动到顶部加载</div>}
      {visibleMessages.map((message) => <MessageView key={message.id} message={message} />)}
      {timeline.compacting && <div className="chat-retry-banner">正在压缩上下文（compaction）…</div>}
      {timeline.retryInfo && <div className="chat-retry-banner">模型错误：{timeline.retryInfo.errorMessage} — 正在重试 {timeline.retryInfo.attempt}/{timeline.retryInfo.maxAttempts}（退避等待）…</div>}
      {timeline.steeringQueue.length > 0 && <div className="chat-queue-banner">⏳ 排队（当前回合后发送）：{timeline.steeringQueue.join(" · ")}</div>}
      {timeline.followUpQueue.length > 0 && <div className="chat-queue-banner">⏳ 排队（agent 完成后发送）：{timeline.followUpQueue.join(" · ")}</div>}
      {timeline.lastError && <div className="chat-error-banner">{timeline.lastError}</div>}
      <div className="chat-scroll-end" />
    </div>
  );
});

// --- Main view --------------------------------------------------------------

export const ChatView = memo(function ChatView({ tabId, active = true }: { tabId: string; active?: boolean }) {
  const state = useChatStore(useShallow((s) => {
    const st = s.states[tabId];
    if (!st) return undefined;
    // Deliberately omit `messages`: ChatTimeline owns that high-frequency
    // surface, leaving this editor/control module stable during token flow.
    return {
      isStreaming: st.isStreaming,
      exited: st.exited,
      booted: st.booted,
      modelName: st.modelName,
      modelId: st.modelId,
      modelProvider: st.modelProvider,
      thinkingLevel: st.thinkingLevel,
      sessionName: st.sessionName,
      lastError: st.lastError,
      retryInfo: st.retryInfo,
      compacting: st.compacting,
      steeringQueue: st.steeringQueue,
      followUpQueue: st.followUpQueue,
      steeringMode: st.steeringMode,
      followUpMode: st.followUpMode,
      autoCompactionEnabled: st.autoCompactionEnabled,
    };
  }));
  const activeTab = useTabsStore((s) => s.activeTab);
  const [input, setInput] = useState("");
  const [uiReq, setUiReq] = useState<UiRequest | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkMenuOpen, setThinkMenuOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [modelView, setModelView] = useState<"providers" | "models">("providers");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const [stats, setStats] = useState<{ tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; context?: { tokens?: number | null; percent?: number | null; contextWindow?: number } } | null>(null);
  const [modelList, setModelList] = useState<Array<{ id: string; name?: string; provider?: string }>>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  // Session commands (get_commands): slash popup + skill chips + ext badge.
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Double-fire guard: Enter/button double-hits within 300ms are slips. */
  const lastSendAtRef = useRef(0);
  const [switchBusy, setSwitchBusy] = useState(false);
  // Only the latest history request may replace the timeline. This prevents a
  // delayed mount-time response from erasing a newer prompt or live stream.
  const historyRequestSeq = useRef(0);
  const historyLoadedRef = useRef(false);

  // Auto-focus the input when this chat becomes the visible tab (new tab via
  // "+" or switching back). Without it, typing right after clicking "+"
  // goes nowhere — the focus is still on the button.
  const wasActive = useRef(false);
  useEffect(() => {
    if (activeTab === tabId) {
      if (!wasActive.current) {
        const t = setTimeout(() => taRef.current?.focus(), 30);
        wasActive.current = true;
        return () => clearTimeout(t);
      }
    } else {
      wasActive.current = false;
    }
  }, [activeTab, tabId]);

  const requestHistory = useCallback(() => {
    const seq = ++historyRequestSeq.current;
    historyLoadedRef.current = false;
    useChatStore.getState().markHistoryLoading(tabId);
    void window.api.tab.rpcRequest(tabId, { type: "get_messages" }, 15000).then((response) => {
      if (seq !== historyRequestSeq.current || !response.success) return;
      const data = response.data as { messages?: unknown[] } | undefined;
      if (!data) return;
      historyLoadedRef.current = true;
      useChatStore.getState().initMessages(tabId, data.messages ?? []);
    });
  }, [tabId]);

  useEffect(() => {
    useChatStore.getState().ensure(tabId);
    const offEvent = window.api.onRpcEvent(tabId, (event) => {
      if (event.type === "response" && event.command === "get_available_models") {
        const data = event.data as { models?: Array<{ id: string; name?: string; provider?: string }> } | undefined;
        if (data?.models) setModelList(data.models);
        return;
      }
      if (event.type === "response" && event.command === "get_available_thinking_levels") {
        const data = event.data as { levels?: string[] } | undefined;
        if (data?.levels) setThinkingLevels(data.levels);
        return;
      }
      if (event.type === "response" && event.command === "set_model") {
        // Model changes invalidate the thinking-level cache: the available
        // levels belong to the selected model, not the provider.
        setThinkingLevels([]);
        // The response data IS the full Model object (not wrapped in .model).
        const model = event.data as { name?: string; id?: string; provider?: string } | null;
        if (model?.id) {
          const current = useChatStore.getState().states[tabId];
          useChatStore.getState().applyEvent(tabId, {
            type: "state_ready",
            model,
            sessionName: current?.sessionName ?? null,
            // Pi may clamp the level for the new model. Keep the current UI
            // value until get_state below returns the authoritative result.
            thinkingLevel: current?.thinkingLevel ?? null,
          });
        }
        void window.api.tab.rpcSend(tabId, { type: "get_state" });
        return;
      }
      if (event.type === "response" && event.command === "get_state") {
        const data = event.data as {
          model?: { name?: string; id?: string; provider?: string } | null;
          thinkingLevel?: string | null;
          steeringMode?: string;
          followUpMode?: string;
          autoCompactionEnabled?: boolean;
        } | undefined;
        if (data && (data.model || data.thinkingLevel || data.steeringMode || data.followUpMode || data.autoCompactionEnabled !== undefined)) {
          useChatStore.getState().applyEvent(tabId, {
            type: "state_ready",
            model: data.model ?? null,
            sessionName: useChatStore.getState().states[tabId]?.sessionName ?? null,
            thinkingLevel: data.thinkingLevel ?? null,
            steeringMode: data.steeringMode,
            followUpMode: data.followUpMode,
            autoCompactionEnabled: data.autoCompactionEnabled,
          });
          // Session is ready — fetch history. The SDK backend can answer the
          // mount-time get_messages BEFORE the tab is registered in the
          // worker (first open takes ~1.5s), so re-ask on the authoritative
          // ready signal. Guarded so a manual get_state (settings change)
          // doesn't churn history repeatedly.
          const cur = useChatStore.getState().states[tabId];
          if (!cur?.historyLoaded) {
            requestHistory();
            void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
          }
        }
        return;
      }
      if (event.type === "response" && event.command === "get_session_stats") {
        const data = event.data as { tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; contextUsage?: { tokens?: number | null; percent?: number | null; contextWindow?: number } } | undefined;
        if (data) {
          setStats({ tokens: data.tokens, cost: data.cost, context: data.contextUsage });
        }
        return;
      }
      if (event.type === "response" && event.command === "fork") {
        const data = event.data as { text?: string; cancelled?: boolean } | undefined;
        if (data && !data.cancelled) {
          // The new branch starts empty; replay the forked message so the
          // agent re-answers from that point (same as TUI /tree fork).
          void window.api.tab.rpcSend(tabId, { type: "get_messages" });
          void window.api.tab.rpcSend(tabId, { type: "get_state" });
          if (typeof data.text === "string" && data.text.trim()) {
            useChatStore.getState().sendPrompt(tabId, data.text);
          }
          useUiStore.getState().showToast("已切换到新分支", "ok");
        }
        return;
      }
      if (event.type === "agent_settled") {
        // Refresh stats after a turn completes.
        void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
        useChatStore.getState().applyEvent(tabId, event);
        return;
      }
      useChatStore.getState().applyEvent(tabId, event);
    });
    const offExit = window.api.onRpcExit(tabId, (code) => useChatStore.getState().markExited(tabId, code));
    const offUi = window.api.onRpcUiRequest(tabId, (raw) => {
      const req = raw as unknown as UiRequest;
      const consumed = handleFireAndForget(req, (text) => {
        setInput(text);
        requestAnimationFrame(() => {
          taRef.current?.focus();
        });
      });
      if (!consumed) setUiReq(req);
    });

    // Boot history when this tab is first shown. The main process already
    // requests get_state during session creation and forwards it. Re-ask for
    // history UNCONDITIONALLY on mount: with the SDK backend the get_messages
    // response can arrive before this subscription exists (worker is ~50ms vs
    // RPC's ~1.9s), so booted=true from state_ready must not suppress it.
    const st2 = useChatStore.getState().states[tabId];
    // Unconditional: hidden tabs also need history ready for when they're
    // shown, and `active` can be stale false at mount time (tabs:update is
    // async) — the guard caused history to never load with the SDK backend.
    requestHistory();
    void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
    // Session behavior fields (steeringMode/…) ride on get_state; the boot
    // handshake may have raced the subscription, so re-ask when missing.
    if (active && st2.steeringMode === undefined) {
      void window.api.tab.rpcSend(tabId, { type: "get_state" });
    }
    return () => {
      offEvent();
      offExit();
      offUi();
    };
  }, [tabId, active, requestHistory]);

  // Session commands for the slash popup / skill chips / extension badge.
  // Per-tab cache in commands.ts; get_commands is static per session.
  useEffect(() => {
    let cancelled = false;
    void fetchCommands(tabId).then((r) => {
      if (!cancelled) setCommands(r.commands);
    });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  useEffect(() => {
    // Hidden RPC tabs receive state events but defer the potentially large
    // history payload until the user actually opens the tab.
    if (!active) return;
    const st = useChatStore.getState().states[tabId];
    if (!st?.messages.length) {
      void window.api.tab.rpcSend(tabId, { type: "get_messages" });
    }
  }, [active, tabId]);

  useEffect(() => {
    // credentials, …), stop the spinner after 30s and point at the fallback.
    const timer = setTimeout(() => {
      const st = useChatStore.getState().states[tabId];
      if (!st?.booted && !st?.exited) setBootTimedOut(true);
    }, 30000);
    return () => clearTimeout(timer);
  }, [tabId]);

  const isStreaming = !!state?.isStreaming;
  const exited = !!state?.exited;

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 40), 180)}px`;
  };

  const runBuiltinSlash = async (text: string): Promise<boolean> => {
    const m = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!m) return false;
    const name = m[1];
    const args = (m[2] ?? "").trim();
    switch (name) {
      case "new": {
        const res = await window.api.tab.rpcRequest(tabId, { type: "new_session" }, 20000);
        if (!res.success) {
          useUiStore.getState().showToast(res.error ?? "新会话失败", "err");
          return true;
        }
        void window.api.tab.rpcSend(tabId, { type: "get_messages" });
        void window.api.tab.rpcSend(tabId, { type: "get_state" });
        void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
        setInput("");
        return true;
      }
      case "compact": {
        void window.api.tab.rpcSend(tabId, { type: "compact" });
        setInput("");
        return true;
      }
      case "tree":
        setInput("");
        setTreeOpen(true);
        return true;
      case "model":
        setInput("");
        setThinkMenuOpen(false);
        setSessionMenuOpen(false);
        setModelMenuOpen(true);
        setModelView("providers");
        if (modelList.length === 0) void window.api.tab.rpcSend(tabId, { type: "get_available_models" });
        return true;
      case "name": {
        if (!args) return false; // no args → caller inserts the template
        if (/^<.+>$/.test(args)) {
          useUiStore.getState().showToast("请把 <会话名> 替换成实际名称", "err");
          return true;
        }
        const res = await window.api.tab.rpcRequest(tabId, { type: "set_session_name", name: args }, 15000);
        if (!res.success) useUiStore.getState().showToast(res.error ?? "设置会话名失败", "err");
        void window.api.tab.rpcSend(tabId, { type: "get_state" });
        setInput("");
        return true;
      }
      case "session": {
        setInput("");
        void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
        const st = useChatStore.getState().states[tabId];
        const bits = [st?.sessionName || "未命名会话", st?.modelName || "未选模型", st?.thinkingLevel || "thinking:-"];
        useUiStore.getState().showToast(bits.join(" · "), "ok");
        return true;
      }
      case "clone": {
        const res = await window.api.tab.rpcRequest(tabId, { type: "clone" }, 20000);
        const cancelled = (res.data as { cancelled?: boolean } | undefined)?.cancelled === true;
        if (!res.success) {
          useUiStore.getState().showToast(res.error ?? "克隆会话失败", "err");
          return true;
        }
        if (cancelled) {
          useUiStore.getState().showToast("克隆被扩展拦截", "err");
          return true;
        }
        // Clone switches the active branch to the new session: reload history
        // and session state from the new session file.
        void window.api.tab.rpcSend(tabId, { type: "get_messages" });
        void window.api.tab.rpcSend(tabId, { type: "get_state" });
        void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
        setInput("");
        useUiStore.getState().showToast("已克隆到新会话", "ok");
        return true;
      }
      case "copy": {
        setInput("");
        const st = useChatStore.getState().states[tabId];
        const lastAssistant = [...(st?.messages ?? [])].reverse().find((m) => m.role === "assistant");
        const text = lastAssistant?.blocks
          .filter((b) => b.kind === "text")
          .map((b) => b.text)
          .join("\n\n")
          .trim();
        if (!text) {
          useUiStore.getState().showToast("没有可复制的助手消息", "err");
          return true;
        }
        try {
          await navigator.clipboard.writeText(text);
          useUiStore.getState().showToast("已复制上一条助手消息", "ok");
        } catch {
          useUiStore.getState().showToast("复制失败", "err");
        }
        return true;
      }
      case "fork":
        setInput("");
        setTreeOpen(true);
        useUiStore.getState().showToast("在会话树中选择一条用户消息后可创建新分支", "ok");
        return true;
      case "settings":
        setInput("");
        useUiStore.getState().openAppDialog("model-config");
        return true;
      case "export": {
        setInput("");
        // RPC/SDK both support export_html; default path = session dir + name.
        const st = useChatStore.getState().states[tabId];
        const base = st?.sessionName || st?.modelName || "session";
        const safe = base.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").slice(0, 60) || "session";
        const res = await window.api.tab.rpcRequest(
          tabId,
          { type: "export_html", outputPath: `${safe}.html` },
          30000,
        );
        if (res.success) {
          const p = (res.data as { path?: string } | undefined)?.path;
          useUiStore.getState().showToast(`已导出：${p ?? "HTML"}`, "ok");
        } else {
          useUiStore.getState().showToast(res.error ?? "导出失败", "err");
        }
        return true;
      }
      case "reload": {
        setInput("");
        const tabMode = useTabsStore.getState().tabs.find((tab) => tab.id === tabId)?.mode;
        // `reload` is an SDK session operation, not a pi RPC protocol
        // command. Sending it through the remote/WSL RPC transport makes pi
        // answer "Unknown command: reload" even though get_commands exposes
        // the built-in command list. Never forward an unsupported protocol
        // command; explain the transport difference instead.
        if (tabMode !== "sdk") {
          useUiStore.getState().showToast("远程/WSL 聊天暂不支持 reload，请切换到终端视图后执行 /reload", "err");
          return true;
        }
        const res = await window.api.tab.rpcRequest(tabId, { type: "reload" }, 30000);
        if (res.success) {
          useUiStore.getState().showToast("已重新加载扩展 / 技能 / 模板", "ok");
          // Commands may have changed — refresh the slash menu cache.
          invalidateCommands(tabId);
          void fetchCommands(tabId, true).then((r) => setCommands(r.commands));
        } else {
          useUiStore.getState().showToast(res.error ?? "reload 仅支持 SDK 后端", "err");
        }
        return true;
      }
      case "resume":
        setInput("");
        // Open the tree dialog (session history) — resume = navigate to a
        // past point; switching to a different session file is available via
        // the sidebar session list.
        setTreeOpen(true);
        useUiStore.getState().showToast("在会话树中选择历史位置继续（切换会话请用侧边栏）", "ok");
        return true;
      default:
        return false;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || state?.exited) return;
    const now = Date.now();
    if (now - lastSendAtRef.current < 300) return; // double-fire guard
    lastSendAtRef.current = now;
    if (await runBuiltinSlash(text)) {
      setSlashOpen(false);
      requestAnimationFrame(() => {
        if (taRef.current) taRef.current.style.height = "auto";
        taRef.current?.focus();
      });
      return;
    }
    useChatStore.getState().sendPrompt(tabId, text);
    setInput("");
    setSlashOpen(false);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
      taRef.current?.focus();
    });
  };

  /** Insert a slash command token, or execute simple builtins immediately. */
  const insertCommand = async (cmd: SessionCommand) => {
    if (cmd.supportedInChat === false) {
      useUiStore.getState().showToast(`/${cmd.name} 仅支持原生 pi TUI`, "err");
      setSlashOpen(false);
      return;
    }
    if (cmd.source === "builtin") {
      // Run builtins immediately (model→picker, tree/fork→tree dialog, …).
      // runBuiltinSlash returns false for builtins that need an argument
      // template (login, name without args) — fall through to insertion.
      const handled = await runBuiltinSlash(`/${cmd.name}`);
      if (handled) {
        setSlashOpen(false);
        requestAnimationFrame(() => {
          taRef.current?.focus();
          grow();
        });
        return;
      }
    }
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? input.length;
    const token = commandTokenAt(input, caret);
    setInput(
      token
        ? replaceCommandToken(input, token.start, token.query.length, cmd.name, cmd.argumentHint)
        : input
          ? `${input} /${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""} `
          : `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""} `,
    );
    setSlashOpen(false);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      grow();
    });
  };

  /** Skill chip click: append "/skill:name " to the input. */
  const insertSkill = (name: string) => {
    setInput((v) => (v ? `${v} /${name} ` : `/${name} `));
    setSlashOpen(false);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      grow();
    });
  };

  /** Optimistic local update for session-behavior settings; get_state
   *  returns the authoritative value right after. */
  const patchSessionState = (extra: { steeringMode?: string; followUpMode?: string; autoCompactionEnabled?: boolean }) => {
    const cur = useChatStore.getState().states[tabId];
    useChatStore.getState().applyEvent(tabId, {
      type: "state_ready",
      model: cur?.modelId ? { id: cur.modelId, name: cur.modelName, provider: cur.modelProvider } : null,
      sessionName: cur?.sessionName ?? null,
      thinkingLevel: cur?.thinkingLevel ?? null,
      ...extra,
    });
  };

  const slashList = useMemo(() => filterCommands(commands, slashQuery), [commands, slashQuery]);
  const commandMode = useTabsStore((s) => s.tabs.find((tab) => tab.id === tabId)?.mode);
  const visibleCommands = useMemo(
    () => commands.map((command) => command.name === "reload" && commandMode !== "sdk"
      ? { ...command, supportedInChat: false, description: `${command.description ?? "重新加载扩展"}（远程/WSL 请在终端执行）` }
      : command),
    [commands, commandMode],
  );
  const visibleSlashList = useMemo(() => filterCommands(visibleCommands, slashQuery), [visibleCommands, slashQuery]);
  const skillCommands = useMemo(() => commands.filter((c) => c.source === "skill"), [commands]);
  const extCommands = useMemo(() => commands.filter((c) => c.source === "extension"), [commands]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: Enter/Arrow keys belong to the composition, not the
    // popup. Bail before any slash handling so committing Chinese text works.
    if (!e.nativeEvent.isComposing && slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (slashList.length ? (i + 1) % slashList.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (slashList.length ? (i - 1 + slashList.length) % slashList.length : 0));
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        const idx = Math.min(slashIndex, Math.max(slashList.length - 1, 0));
        const cmd = slashList[idx];
        if (cmd) {
          e.preventDefault();
          insertCommand(cmd);
          return;
        }
        // No match: Enter falls through to send, Tab just moves on.
        if (e.key === "Tab") return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  /** Recompute the slash popup state from the caret position (typing,
   *  caret-only moves via arrows/clicks — onChange alone misses those). */
  const syncSlash = (v: string, caret: number) => {
    const token = commandTokenAt(v, caret);
    if (token) {
      setSlashQuery(token.query);
      setSlashOpen(true);
      setSlashIndex(0);
    } else {
      setSlashOpen(false);
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        }
        images.push({ type: "image", data: btoa(bin), mimeType: file.type });
      }
    }
    if (images.length > 0) {
      e.preventDefault();
      const text = input.trim();
      useChatStore.getState().sendPrompt(tabId, text || "（图片）", images);
      setInput("");
      taRef.current?.focus();
    }
  };

  const switchToTerminal = async () => {
    setSwitchBusy(true);
    try {
      await window.api.tab.rpcSwitchToTerminal(tabId);
      // tabs:update flips this tab to mode "pty"; TerminalPane re-renders.
    } catch (e) {
      useUiStore.getState().showToast(`切换到终端视图失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setSwitchBusy(false);
    }
  };

  // Model list grouped by provider (first level = providers, second = models).
  const modelsByProvider = useMemo(() => {
    const map: Record<string, typeof modelList> = {};
    for (const m of modelList) {
      const p = m.provider ?? m.id.split("/")[0] ?? "其他";
      (map[p] ??= []).push(m);
    }
    return map;
  }, [modelList]);
  const providers = useMemo(() => Object.keys(modelsByProvider).sort(), [modelsByProvider]);
  const currentProvider = useMemo(() => {
    // Prefer the provider recorded at state_ready (exact); fall back to
    // matching by name/id (ambiguous when providers share model names).
    if (state?.modelProvider) return state.modelProvider;
    const name = state?.modelName;
    if (!name) return null;
    for (const m of modelList) {
      if (m.name === name || m.id === name) return m.provider ?? m.id.split("/")[0] ?? null;
    }
    return null;
  }, [modelList, state?.modelName, state?.modelProvider]);

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-model-switch-wrap">
            <button
              className="chat-header-btn chat-model-btn"
              onClick={() => {
                if (modelMenuOpen) {
                  setModelMenuOpen(false);
                  return;
                }
                setThinkMenuOpen(false);
                setModelMenuOpen(true);
                setModelView("providers");
                // Cache: don't re-request on every open (menu feels snappy).
                if (modelList.length === 0) {
                  void window.api.tab.rpcSend(tabId, { type: "get_available_models" });
                }
              }}
              title={`${state?.modelName ?? "pi"}${state?.sessionName ? ` · ${state.sessionName}` : ""} — 点击切换模型`}
            >
              {state?.modelName ?? "模型"} ▾
            </button>
            {modelMenuOpen && (
              <div className="chat-model-menu">
                {modelView === "providers" ? (
                  <>
                    <div className="chat-model-menu-title">提供商</div>
                    {providers.map((p) => (
                      <div
                        key={p}
                        className={`chat-model-provider${p === currentProvider ? " current" : ""}`}
                        onClick={() => {
                          setSelectedProvider(p);
                          setModelView("models");
                        }}
                      >
                        {p}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div
                      className="chat-model-back"
                      onClick={() => {
                        setModelView("providers");
                        setSelectedProvider(null);
                      }}
                    >
                      ← {selectedProvider}
                    </div>
                    {(modelsByProvider[selectedProvider ?? ""] ?? []).map((m) => (
                      <div
                        key={m.id}
                        className={`chat-model-item${
                          (m.provider === state?.modelProvider && state?.modelId === m.id) ||
                          (!state?.modelProvider && !state?.modelId && state?.modelName === (m.name ?? m.id))
                            ? " current"
                            : ""
                        }`}
                        onClick={() => {
                          void window.api.tab.rpcSend(tabId, { type: "set_model", provider: m.provider ?? selectedProvider ?? m.id.split("/")[0], modelId: m.id });
                          setModelMenuOpen(false);
                        }}
                        title={m.id}
                      >
                        {m.name ?? m.id}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </span>
          <span className="chat-model-switch-wrap">
            <button
              className="chat-header-btn chat-think-btn"
              onClick={() => {
                if (thinkMenuOpen) {
                  setThinkMenuOpen(false);
                  return;
                }
                setModelMenuOpen(false);
                setThinkMenuOpen(true);
                if (thinkingLevels.length === 0) {
                  void window.api.tab.rpcSend(tabId, { type: "get_available_thinking_levels" });
                }
              }}
              title="点击切换思考级别"
            >
              思考 {state?.thinkingLevel ?? "—"} ▾
            </button>
            {thinkMenuOpen && (
              <div className="chat-model-menu">
                <div className="chat-model-menu-title">思考级别</div>
                {thinkingLevels.length === 0 && <div className="chat-model-empty">该模型未声明可用的思考级别</div>}
                {thinkingLevels.map((lv) => (
                  <div
                    key={lv}
                    className={`chat-model-item${lv === state?.thinkingLevel ? " current" : ""}`}
                    onClick={() => {
                      // Optimistic local update; get_state confirms later.
                      const current = useChatStore.getState().states[tabId];
                      useChatStore.getState().applyEvent(tabId, {
                        type: "state_ready",
                        model: current?.modelId
                          ? { id: current.modelId, name: current.modelName, provider: current.modelProvider }
                          : null,
                        sessionName: current?.sessionName ?? null,
                        thinkingLevel: lv,
                      });
                      void window.api.tab.rpcSend(tabId, { type: "set_thinking_level", level: lv });
                      void window.api.tab.rpcSend(tabId, { type: "get_state" });
                      setThinkMenuOpen(false);
                    }}
                  >
                    {lv}
                  </div>
                ))}
              </div>
            )}
          </span>
          <span className="chat-model-switch-wrap">
            <button
              className="chat-header-btn"
              onClick={() => {
                setSessionMenuOpen((v) => !v);
                setModelMenuOpen(false);
                setThinkMenuOpen(false);
              }}
              title="会话行为：steer/follow-up 排队模式、自动压缩"
            >
              会话 ▾
            </button>
            {sessionMenuOpen && (
              <div className="chat-model-menu session-menu">
                <div className="chat-model-menu-title">steer 排队（运行中输入）</div>
                {["all", "one-at-a-time"].map((m) => (
                  <div
                    key={m}
                    className={`chat-model-item${state?.steeringMode === m ? " current" : ""}`}
                    onClick={() => {
                      patchSessionState({ steeringMode: m });
                      void window.api.tab.rpcSend(tabId, { type: "set_steering_mode", mode: m });
                      void window.api.tab.rpcSend(tabId, { type: "get_state" });
                    }}
                  >
                    {m === "all" ? "全部发送" : "每回合一条"}
                    {state?.steeringMode === m ? " ✓" : ""}
                  </div>
                ))}
                <div className="chat-model-menu-title">follow-up 排队（agent 完成后）</div>
                {["all", "one-at-a-time"].map((m) => (
                  <div
                    key={m}
                    className={`chat-model-item${state?.followUpMode === m ? " current" : ""}`}
                    onClick={() => {
                      patchSessionState({ followUpMode: m });
                      void window.api.tab.rpcSend(tabId, { type: "set_follow_up_mode", mode: m });
                      void window.api.tab.rpcSend(tabId, { type: "get_state" });
                    }}
                  >
                    {m === "all" ? "全部发送" : "每轮一条"}
                    {state?.followUpMode === m ? " ✓" : ""}
                  </div>
                ))}
                <div className="chat-model-menu-title">自动压缩（上下文接近上限时）</div>
                <div
                  className="chat-model-item"
                  onClick={() => {
                    const enabled = state?.autoCompactionEnabled !== true;
                    patchSessionState({ autoCompactionEnabled: enabled });
                    void window.api.tab.rpcSend(tabId, { type: "set_auto_compaction", enabled });
                    void window.api.tab.rpcSend(tabId, { type: "get_state" });
                  }}
                >
                  {state?.autoCompactionEnabled === true ? "已启用 ✓" : state?.autoCompactionEnabled === false ? "已停用（点击启用）" : "启用（默认）"}
                </div>
              </div>
            )}
          </span>
          {extCommands.length > 0 && (
            <span
              className="chat-ext-badge"
              title={extCommands
                .map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ""}`)
                .join("\n")}
            >
              🧩 {extCommands.length} 扩展
            </span>
          )}
        </div>
        <button className="chat-header-btn" onClick={() => setTreeOpen(true)} title="会话分支（fork）">
          分支
        </button>
        <button className="chat-header-btn" onClick={switchToTerminal} disabled={switchBusy} title="切换为完整终端视图（TUI）">
          终端视图
        </button>
      </div>

      <ChatNotices />

      <ChatTimeline tabId={tabId} bootTimedOut={bootTimedOut} />

      <div className="chat-input-wrap">
        {slashOpen && (
          <SlashMenu
            commands={visibleCommands}
            query={slashQuery}
            selectedIndex={Math.min(slashIndex, visibleSlashList.length - 1)}
            onSelect={insertCommand}
            onHover={setSlashIndex}
          />
        )}
        <SkillChips skills={skillCommands} onInsert={insertSkill} />
        <textarea
          ref={taRef}
          className="chat-textarea"
          value={input}
          placeholder={exited ? "pi 已退出，请切换到终端视图" : isStreaming ? "agent 运行中 — Enter 排队发送" : "输入消息…（Shift+Enter 换行）"}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            grow();
            syncSlash(v, e.target.selectionStart ?? v.length);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            // Caret-only moves (arrows/Home/End) don't fire onChange — keep
            // the popup query in sync so Enter inserts what the popup shows.
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
              const ta = taRef.current;
              if (ta) syncSlash(ta.value, ta.selectionStart ?? ta.value.length);
            }
          }}
          onClick={() => {
            const ta = taRef.current;
            if (ta) syncSlash(ta.value, ta.selectionStart ?? ta.value.length);
          }}
          onBlur={() => setSlashOpen(false)}
          onPaste={onPaste}
          disabled={exited}
          rows={1}
          spellCheck={false}
        />
        <div className="chat-input-bar">
          <span className="chat-input-stats" title="会话用量（输入↑ / 输出↓ / 缓存读取 / 上下文占用）">
            {stats
              ? (() => {
                  const t = stats.tokens;
                  const fmt = (n?: number) => (n ? `${n >= 1000 ? (n / 1000).toFixed(1) + "k" : n}` : "0");
                  const parts: string[] = [];
                  if (t) {
                    parts.push(`↑${fmt(t.input)} ↓${fmt(t.output)}`);
                    if (t.cacheRead) parts.push(`缓存${fmt(t.cacheRead)}`);
                  }
                  if (typeof stats.context?.percent === "number") parts.push(`${stats.context.percent.toFixed(1)}%`);
                  return parts.join(" · ");
                })()
              : "用量将在首轮对话后显示"}
          </span>
          <span className="chat-input-hint">
            {isStreaming ? "Enter 排队（steer）· Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行 · / 命令可用"}
          </span>
          {isStreaming && (
            <button className="chat-btn stop" onClick={() => useChatStore.getState().abort(tabId)}>
              ■ 停止
            </button>
          )}
          <button className="chat-btn send" onClick={send} disabled={!input.trim() || exited}>
            发送
          </button>
        </div>
      </div>
      {uiReq && <UiDialog tabId={tabId} req={uiReq} onClose={() => setUiReq(null)} />}
      {treeOpen && (
        <TreeDialog
          tabId={tabId}
          onClose={() => setTreeOpen(false)}
          onNavigated={(editorText) => {
            // Navigation switched the leaf: reload history. The input box
            // follows the target — user-message targets restore their text
            // (TUI /tree behavior), anything else clears stale text.
            void window.api.tab.rpcSend(tabId, { type: "get_messages" });
            void window.api.tab.rpcSend(tabId, { type: "get_state" });
            setInput(editorText ?? "");
            if (editorText) {
              requestAnimationFrame(() => taRef.current?.focus());
            }
          }}
        />
      )}
    </div>
  );
});
