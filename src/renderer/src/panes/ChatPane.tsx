/**
 * ChatPane: native chat view for RPC-backed pi tabs.
 *
 * Renders messages assembled from pi's RPC event stream (chatStore) with a
 * real <textarea> input box — mouse click-to-position, drag-selection and
 * direct deletion are native browser behavior. A "终端视图" button falls
 * back to the full TUI (same tab id) for anything that needs it.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js";
import Markdown from "../Markdown";
import { useChatStore, type ChatBlock, type ChatMessage } from "../stores/chatStore";
import { useTabsStore } from "../stores/tabsStore";
import { useUiStore } from "../stores/uiStore";
import { UiDialog, handleFireAndForget, type UiRequest } from "../dialogs/UiDialog";
import { TreeDialog } from "../dialogs/TreeDialog";

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

function ToolBlock({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const [showArgs, setShowArgs] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const running = block.status === "streaming";
  const resultText = block.resultText ?? "";
  // Highlight git diffs in tool results (hljs diff grammar + github.css theme).
  const isDiff =
    resultText.startsWith("diff --git") ||
    /^[+-]{3} \S/m.test(resultText) ||
    /^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(resultText);
  return (
    <div className={`chat-tool${block.isError ? " error" : ""}`}>
      <div className="chat-tool-head" onClick={() => setShowArgs((v) => !v)}>
        <span className={`chat-tool-dot${running ? " running" : ""}`} />
        <span className="chat-tool-name">{block.name ?? "tool"}</span>
        <span className="chat-tool-toggle">{showArgs ? "▾" : "▸"}</span>
      </div>
      {showArgs && (
        <pre className="chat-tool-args">
          {block.argsText || (running ? "(参数生成中…)" : "")}
        </pre>
      )}
      {(block.resultDone || running) && (
        <div className="chat-tool-result-wrap" onClick={() => setShowResult((v) => !v)}>
          <div className="chat-tool-result-head">
            {running ? "执行中…" : block.isError ? "执行失败" : "执行结果"}
            <span>{showResult ? "▾" : "▸"}</span>
          </div>
          {showResult &&
            (isDiff ? (
              <pre
                className={`chat-tool-result diff hljs${block.isError ? " error" : ""}`}
                dangerouslySetInnerHTML={{ __html: hljs.highlight(resultText, { language: "diff" }).value }}
              />
            ) : (
              <pre className={`chat-tool-result${block.isError ? " error" : ""}`}>{resultText || "(空)"}</pre>
            ))}
        </div>
      )}
    </div>
  );
}

function AssistantBlocks({ blocks }: { blocks: ChatBlock[] }) {
  return (
    <div className="chat-msg-blocks">
      {blocks.map((b, i) => {
        if (b.kind === "thinking") return <ThinkingBlock key={i} block={b} />;
        if (b.kind === "tool") return <ToolBlock key={i} block={b} />;
        const text = b.kind === "text" ? b.text : "";
        if (!text.trim()) return <div key={i} className="chat-msg-empty" />;
        return (
          <div key={i} className="chat-msg-md">
            <Markdown content={text} />
          </div>
        );
      })}
    </div>
  );
}

function MessageView({ message }: { message: ChatMessage }) {
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
      </div>
    </div>
  );
}

// --- Main view --------------------------------------------------------------

export const ChatView = memo(function ChatView({ tabId }: { tabId: string }) {
  const state = useChatStore((s) => s.states[tabId]);
  const activeTab = useTabsStore((s) => s.activeTab);
  const [input, setInput] = useState("");
  const [uiReq, setUiReq] = useState<UiRequest | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkMenuOpen, setThinkMenuOpen] = useState(false);
  const [modelView, setModelView] = useState<"providers" | "models">("providers");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const [stats, setStats] = useState<{ tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; context?: { tokens?: number | null; percent?: number | null; contextWindow?: number } } | null>(null);
  const [modelList, setModelList] = useState<Array<{ id: string; name?: string; provider?: string }>>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const [switchBusy, setSwitchBusy] = useState(false);

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

  useEffect(() => {
    useChatStore.getState().ensure(tabId);
    const offEvent = window.api.onRpcEvent(tabId, (event) => {
      if (event.type === "response" && event.command === "get_messages") {
        const data = event.data as { messages?: unknown[] } | undefined;
        useChatStore.getState().initMessages(tabId, data?.messages ?? []);
        return;
      }
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
        // The response data IS the full Model object (not wrapped in .model).
        const model = event.data as { name?: string; id?: string; provider?: string } | null;
        if (model?.id) {
          useChatStore.getState().applyEvent(tabId, {
            type: "state_ready",
            model,
            sessionName: useChatStore.getState().states[tabId]?.sessionName ?? null,
          });
        }
        return;
      }
      if (event.type === "response" && event.command === "get_state") {
        const data = event.data as { model?: { name?: string; id?: string; provider?: string } | null; thinkingLevel?: string | null } | undefined;
        if (data?.model || data?.thinkingLevel) {
          useChatStore.getState().applyEvent(tabId, {
            type: "state_ready",
            model: data.model ?? null,
            sessionName: useChatStore.getState().states[tabId]?.sessionName ?? null,
            thinkingLevel: data.thinkingLevel ?? null,
          });
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

    // Boot: load history + current state + session usage (historical sessions
    // already have real token/cost numbers from pi).
    const st = useChatStore.getState().states[tabId];
    if (!st?.booted) {
      void window.api.tab.rpcSend(tabId, { type: "get_messages" });
      void window.api.tab.rpcSend(tabId, { type: "get_state" });
      void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
    }
    return () => {
      offEvent();
      offExit();
      offUi();
    };
  }, [tabId]);

  useEffect(() => {
    // If pi never answered get_state/get_messages (remote without pi, bad
    // credentials, …), stop the spinner after 30s and point at the fallback.
    const timer = setTimeout(() => {
      const st = useChatStore.getState().states[tabId];
      if (!st?.booted && !st?.exited) setBootTimedOut(true);
    }, 30000);
    return () => clearTimeout(timer);
  }, [tabId]);

  // Auto-scroll to bottom while streaming (unless the user scrolled up).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [state?.messages, state?.isStreaming]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 40), 180)}px`;
  };

  const send = () => {
    const text = input.trim();
    if (!text || state?.exited) return;
    useChatStore.getState().sendPrompt(tabId, text);
    setInput("");
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
      taRef.current?.focus();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
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
    await window.api.tab.rpcSwitchToTerminal(tabId);
    // tabs:update flips this tab to mode "pty"; TerminalPane re-renders.
  };

  const messages = state?.messages ?? [];
  const isStreaming = !!state?.isStreaming;
  const exited = !!state?.exited;
  const booted = !!state?.booted;

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
                {thinkingLevels.map((lv) => (
                  <div
                    key={lv}
                    className={`chat-model-item${lv === state?.thinkingLevel ? " current" : ""}`}
                    onClick={() => {
                      // Optimistic local update; get_state confirms later.
                      useChatStore.getState().applyEvent(tabId, {
                        type: "state_ready",
                        model: null,
                        sessionName: null,
                        thinkingLevel: lv,
                      });
                      void window.api.tab.rpcSend(tabId, { type: "set_thinking_level", level: lv });
                      setThinkMenuOpen(false);
                    }}
                  >
                    {lv}
                  </div>
                ))}
              </div>
            )}
          </span>
        </div>
        <button className="chat-header-btn" onClick={() => setTreeOpen(true)} title="会话分支（fork）">
          分支
        </button>
        <button className="chat-header-btn" onClick={switchToTerminal} disabled={switchBusy} title="切换为完整终端视图（TUI）">
          终端视图
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {!booted && !bootTimedOut && <div className="chat-placeholder">正在启动 pi…</div>}
        {!booted && bootTimedOut && (
          <div className="chat-error-banner">
            pi 启动超时（远程服务器可能未安装 pi，或连接失败）。可切换到终端视图排查。
          </div>
        )}
        {messages.length === 0 && booted && (
          <div className="chat-placeholder">输入问题开始对话（鼠标可直接点击、选中、编辑输入内容）</div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {state?.lastError && <div className="chat-error-banner">{state.lastError}</div>}
        <div className="chat-scroll-end" />
      </div>

      <div className="chat-input-wrap">
        <textarea
          ref={taRef}
          className="chat-textarea"
          value={input}
          placeholder={exited ? "pi 已退出，请切换到终端视图" : isStreaming ? "agent 运行中 — Enter 排队发送" : "输入消息…（Shift+Enter 换行）"}
          onChange={(e) => {
            setInput(e.target.value);
            grow();
          }}
          onKeyDown={onKeyDown}
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
