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
import { useChatStore, exitBannerText, type ChatBlock, type ChatMessage } from "../stores/chatStore";
import { useTabsStore } from "../stores/tabsStore";
import { useUiStore } from "../stores/uiStore";
import { UiDialog, handleFireAndForget, type UiRequest } from "../dialogs/UiDialog";
import {
  QuestionnaireDialog,
  buildFlushResponse,
  buildFlushSteps,
  extractSentinelLabel,
  parseQuestionsFromArgs,
  walkerTitleStarts,
  type QAnswer,
  type QQuestion,
} from "../dialogs/QuestionnaireDialog";
import { TreeDialog } from "../dialogs/TreeDialog";
import { DiffView, editsToDiff, isDiffish } from "../components/DiffView";
import {
  fmtDuration,
  summarizeTool,
  type ToolSummary,
} from "../components/tool-summary";
import { SlashMenu } from "../components/SlashMenu";
import { SkillChips } from "../components/SkillChips";
import { FileMentionMenu } from "../components/FileMentionMenu";
import { Icon } from "../components/Icon";
import { fileMentionPaths, fileMentionTokenAt, filterFileMentions, replaceFileMention, type FileMention } from "../file-mentions";
import { modelSyncAppliesTo } from "../model-sync";
import { projectLabelForTab } from "../project-label";
import { createHistoryGate } from "./history-gate";
import { INTERNAL_RPC_ID_PREFIX } from "../../../shared/transcript";

/** "65" → "1m 5s" (running-time display). */
function fmtElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Await `p`, or resolve `null` if it takes longer than `ms` (and map a
 *  rejection to `null`). The timer is cleared whenever the race settles, so a
 *  fast path leaks nothing — a bare `Promise.race` with `setTimeout` would keep
 *  one pending timer per call for the whole `ms` window. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p.catch(() => null), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Quiet-turn threshold before the read-only liveness probe runs (5s tick).
 *  A healthy turn emits events continuously (streaming/tool progress), so 60s
 *  of total silence means either a wedged pi or a dead pipe — but the probe,
 *  not the silence, decides. */
const NO_RESPONSE_PROBE_MS = 60000;
/** A live pi answers get_session_stats in ~100ms even over SSH; 12s of nothing
 *  means the command (or the whole pipe) is gone. */
const PROBE_TIMEOUT_MS = 12000;
/** Budget for ONE transcript (`get_messages`) round trip. This is NOT a
 *  liveness timeout — the probe above owns liveness. Measured on a slow remote
 *  (36-server, multi-MB session, ssh2 + pi's serial command loop): 17–45s. The
 *  old 15s budget therefore ALWAYS expired, and `rpcRequest` removes its
 *  listener on timeout — so the arriving transcript was discarded while
 *  `historyLoaded` stayed false, and every later `get_state` re-fired the whole
 *  multi-MB download (three overlapped at once in the log): the link saturated
 *  (“连接非常卡”) and the main process stalled parsing JSON (“未响应”), with the
 *  `[mem]` peaks to match (rss 631MB at 08:26:21, inside a get_messages window).
 *  120s ≈ 2.7× the worst measured round trip. */
const HISTORY_REQUEST_TIMEOUT_MS = 120_000;
/** Budget for the FILE attempt (`session:transcript-from-file`). The read is
 *  bounded on the main side, but a wedged SFTP lease would otherwise leave the
 *  single-flight gate claimed forever — so the caller bounds it too and falls
 *  back to RPC. */
const TRANSCRIPT_FILE_TIMEOUT_MS = 60_000;
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
  // Collapsed by default; failures auto-expand the result area so errors are
  // visible without a click. args/result stay click-to-toggle.
  const [showArgs, setShowArgs] = useState(false);
  const failed = block.isError === true;
  const [showResult, setShowResult] = useState(failed);
  // Live-streamed failures arrive after mount → auto-expand when isError turns
  // true so the error is visible without a click (never auto-collapse).
  useEffect(() => {
    if (block.isError) setShowResult(true);
  }, [block.isError]);
  const running = block.status === "streaming";
  const resultText = block.resultText ?? "";
  const isDiff = isDiffish(resultText);
  const summary = useMemo(
    () => summarizeTool(block.name, block.argsText, resultText, block.isError),
    [block.name, block.argsText, resultText, block.isError],
  );
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
  // Edit diff defaults to collapsed: the head row shows a +N −N diffstat and
  // the full diff renders only when the row is expanded. Not force-opened on
  // failure — a failed edit did NOT apply, so showing its would-be diff
  // misleads; the auto-expanded error result explains what went wrong instead.
  const hasDiffDetail = !!editDiff && !isDiff;
  return (
    <div className={`chat-tool${block.isError ? " error" : ""}`}>
      <div
        className="chat-tool-head"
        onClick={() => setShowArgs((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={showArgs}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setShowArgs((v) => !v);
          }
        }}
      >
        <span className={`chat-tool-dot${running ? " running" : ""}`} />
        <span className="chat-tool-name">{block.name ?? "tool"}</span>
        <ToolSummaryView summary={summary} running={running} />
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
      {hasDiffDetail && showArgs && (
        <div className="chat-tool-editdiff">
          <div className="chat-tool-result-head">编辑预览</div>
          <DiffView diffText={editDiff!} />
        </div>
      )}
      {(block.resultDone || running) && (
        <div
          className="chat-tool-result-wrap"
          onClick={() => setShowResult((v) => !v)}
          role="button"
          tabIndex={0}
          aria-expanded={showResult}
          aria-label={running ? "工具执行中，点按展开或收起输出" : block.isError ? "执行失败，点按展开或收起错误信息" : "点按展开或收起执行结果"}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setShowResult((v) => !v);
            }
          }}
        >
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

/** Right side of the collapsed head row: object + result status. */
const ToolSummaryView = memo(function ToolSummaryView({
  summary,
  running,
}: {
  summary: ToolSummary | null;
  running: boolean;
}) {
  if (!summary || running) return <span className="chat-tool-summary" />;
  return (
    <span className="chat-tool-summary">
      {summary.object && (
        <span className="chat-tool-object" title={summary.object}>
          {summary.objectDir && <span className="chat-tool-object-dir">{summary.objectDir}</span>}
          {summary.object}
        </span>
      )}
      {summary.size && <span className="chat-tool-chip">{summary.size}</span>}
      {summary.stat && (
        <span className="chat-tool-chip">
          <span className="diffstat-add">+{summary.stat.adds}</span> <span className="diffstat-del">−{summary.stat.dels}</span>
        </span>
      )}
      {summary.durationMs !== undefined && <span className="chat-tool-chip">{fmtDuration(summary.durationMs)}</span>}
      {summary.lines !== undefined && <span className="chat-tool-chip">{summary.lines} 行</span>}
      {summary.exitCode !== undefined && summary.exitCode !== 0 && (
        <span className="chat-tool-chip chip-fail">exit {summary.exitCode}</span>
      )}
      <span className={`chat-tool-status${summary.alert ? " fail" : ""}`}>{summary.alert ? "✗" : "✓"}</span>
    </span>
  );
});

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
  const updateResult = useUiStore((s) => s.updateResult);
  const piUpdating = useUiStore((s) => s.piUpdating);
  const extNotice = useUiStore((s) => s.extNotice);
  if (!appUpdateInfo && !updateInfo && !extNotice && !updateResult) return null;
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
      {updateResult ? (
        <div className={`chat-notice update${updateResult.ok ? " ok" : " err"}`}>
          <span className="chat-notice-text">
            {updateResult.ok
              ? `pi agent 更新成功：已更新到 ${updateResult.version ?? "最新版"}，请重启标签页生效`
              : `pi agent 更新失败：${updateResult.error ?? "未知错误"}`}
          </span>
          <button className="chat-notice-close" onClick={() => useUiStore.getState().setUpdateResult(null)} title="关闭">×</button>
        </div>
      ) : updateInfo ? (
        <div className="chat-notice update">
          <span className="chat-notice-text">
            {piUpdating
              ? "正在更新 pi agent 和扩展包…"
              : updateInfo.targetLabel
                ? `${updateInfo.targetLabel} pi agent 版本（${updateInfo.current ?? "?"}）与应用配套版本（${updateInfo.latest ?? "?"}）不一致；更新将对齐版本并同步扩展包`
                : updateInfo.latest
                  ? `pi agent 有新版本：${updateInfo.current ?? "?"} → ${updateInfo.latest}${updateInfo.extensions.length ? `；扩展包也有更新：${updateInfo.extensions.join("、")}` : ""}`
                  : `pi 扩展包有更新：${updateInfo.extensions.join("、")}`}
          </span>
          <button
            className="btn btn-primary chat-notice-btn"
            disabled={piUpdating}
            onClick={() => void useUiStore.getState().runPiUpdate()}
          >
            {piUpdating ? "更新中…" : "立即更新"}
          </button>
          <button className="chat-notice-close" onClick={() => useUiStore.getState().setUpdateInfo(null)} title="关闭">×</button>
        </div>
      ) : null}
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
  bootStage: undefined as "connecting" | "starting" | "ready" | undefined,
  compacting: false,
  retryInfo: null,
  steeringQueue: [] as string[],
  followUpQueue: [] as string[],
  lastError: undefined as string | undefined,
};

const ChatTimeline = memo(function ChatTimeline({ tabId, bootTimedOut, bootTimeoutDetail }: { tabId: string; bootTimedOut: boolean; bootTimeoutDetail?: string | null }) {
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
      bootStage: st.bootStage,
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
      {!timeline.booted && !bootTimedOut && <div className="chat-placeholder">{timeline.bootStage === "connecting" ? "正在连接远程 Pi…" : "正在启动 Pi…"}</div>}
      {!timeline.booted && bootTimedOut && (
        <div className="chat-error-banner">
          pi 启动超时（远程服务器可能未安装 pi，或连接失败）。可切换到终端视图排查。
          {bootTimeoutDetail && <div className="chat-error-detail">远程输出：{bootTimeoutDetail}</div>}
        </div>
      )}
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

/**
 * Find the currently-running ask_user_question tool call in the tab's chat
 * stream and parse its full question set. Used to recognize the walker's
 * first dialog and open the full questionnaire instead of tiny per-question
 * dialogs.
 */
function findRunningAskUserQuestion(tabId: string): QQuestion[] | null {
  const st = useChatStore.getState().states[tabId];
  if (!st) return null;
  for (let mi = st.messages.length - 1; mi >= 0; mi--) {
    const msg = st.messages[mi];
    if (!msg || msg.role !== "assistant") continue;
    for (const b of msg.blocks) {
      if (b.kind === "tool" && b.name === "ask_user_question" && b.status === "streaming") {
        const qs = parseQuestionsFromArgs(b.argsText);
        if (qs && qs.length > 0) return qs;
      }
    }
  }
  return null;
}

export const ChatView = memo(function ChatView({ tabId, active = true }: { tabId: string; active?: boolean }) {
  const state = useChatStore(useShallow((s) => {
    const st = s.states[tabId];
    if (!st) return undefined;
    // Deliberately omit `messages`: ChatTimeline owns that high-frequency
    // surface, leaving this editor/control module stable during token flow.
    return {
      isStreaming: st.isStreaming,
      exited: st.exited,
      exitCode: st.exitCode,
      exitDetail: st.exitDetail,
      booted: st.booted,
      modelName: st.modelName,
      modelId: st.modelId,
      modelProvider: st.modelProvider,
      thinkingLevel: st.thinkingLevel,
      sessionName: st.sessionName,
      lastError: st.lastError,
      restoreInput: st.restoreInput,
      retryInfo: st.retryInfo,
      compacting: st.compacting,
      steeringQueue: st.steeringQueue,
      followUpQueue: st.followUpQueue,
      steeringMode: st.steeringMode,
      followUpMode: st.followUpMode,
      autoCompactionEnabled: st.autoCompactionEnabled,
      turn: st.turn,
    };
  }));
  const activeTab = useTabsStore((s) => s.activeTab);
  const [input, setInput] = useState("");
  const [uiReq, setUiReq] = useState<UiRequest | null>(null);
  // Full multi-question UI for ask_user_question (parity with the TUI): the
  // first walker dialog is held unanswered while the user fills the
  // questionnaire; submit/cancel then answers the walker's dialogs in order.
  const [questionnaire, setQuestionnaire] = useState<{
    questions: QQuestion[];
    firstReq: UiRequest;
    sentinelLabel?: string;
  } | null>(null);
  const [questionnaireSubmitting, setQuestionnaireSubmitting] = useState(false);
  const questionnaireRef = useRef<{
    questions: QQuestion[];
    firstReq: UiRequest;
    sentinelLabel?: string;
  } | null>(null);
  const flushRef = useRef<{
    steps: Array<{ qi: number; kind: "select" | "multi" | "custom" }>;
    nextIndex: number;
    questions: QQuestion[];
    answers: Record<number, QAnswer>;
  } | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkMenuOpen, setThinkMenuOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [modelView, setModelView] = useState<"providers" | "models">("providers");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  // Click-away dismiss for the header dropdowns (模型/思考/会话): opening one
  // and clicking anywhere else — transcript, 分支, tree — must close it instead
  // of leaving it hanging. pointerdown (capture) fires before the buttons' own
  // click handlers, so re-clicking a button to toggle still works: only clicks
  // outside the header menu container close the menus. Escape closes them too.
  const headerMenusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (headerMenusRef.current?.contains(e.target as Node)) return;
      setModelMenuOpen(false);
      setThinkMenuOpen(false);
      setSessionMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModelMenuOpen(false);
        setThinkMenuOpen(false);
        setSessionMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  const [treeOpen, setTreeOpen] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const [bootTimeoutDetail, setBootTimeoutDetail] = useState<string | null>(null);
  // Connection-death banner (see the probe effect below): set only when a
  // read-only probe proves pi is NOT answering, never on mere quiet.
  const [unresponsive, setUnresponsive] = useState<{ silentMs: number; detail?: string | null } | null>(null);
  const unresponsiveRef = useRef(false);
  const probeInFlightRef = useRef(false);
  const lastEventAtRef = useRef(Date.now());
  const [completionVisible, setCompletionVisible] = useState(false);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stats, setStats] = useState<{ tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; cost?: number; context?: { tokens?: number | null; percent?: number | null; contextWindow?: number } } | null>(null);
  const [modelList, setModelList] = useState<Array<{ id: string; name?: string; provider?: string }>>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  // Session commands (get_commands): slash popup + skill chips + ext badge.
  const [commands, setCommands] = useState<SessionCommand[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<FileMention[]>([]);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [attachingFiles, setAttachingFiles] = useState(false);
  const mentionRequestRef = useRef(0);
  const mentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachingFilesRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Double-fire guard: Enter/button double-hits within 300ms are slips. */
  const lastSendAtRef = useRef(0);
  const [switchBusy, setSwitchBusy] = useState(false);
  // Only the latest history request may replace the timeline. This prevents a
  // delayed mount-time response from erasing a newer prompt or live stream.
  const historyRequestSeq = useRef(0);
  const historyLoadedRef = useRef(false);
  // Single-flight for the transcript download (see history-gate.ts): the
  // mount effect, the `state_ready` branch and branch navigation used to
  // overlap three multi-MB `get_messages` on one link. `requestHistoryRef`
  // lets the settle path re-run without depending on its own identity.
  const historyGateRef = useRef(createHistoryGate());
  const requestHistoryRef = useRef<(opts?: { preferRpc?: boolean }) => void>(() => {});
  // Fresh view of `active` for the event-subscription effect: that effect must
  // run ONCE per mount (re-subscribing and re-downloading history on every tab
  // ACTIVATION made big remote sessions stall the UI on each switch), but its
  // mount-time steeringMode check still needs the current value.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Dedupes the one-shot modelFallbackMessage toast per ChatPane mount so a
  // boot handshake + mount-time get_state (or a later manual refresh) don't
  // repeat it.
  const seenModelFallbackRef = useRef(false);

  // Auto-focus the input when this chat becomes the visible tab (new tab via
  // "+" or switching back). Without it, typing right after clicking "+"
  // goes nowhere — the focus is still on the button.
  // Also refocus when the window regains OS focus (mirrors TerminalView): a
  // blur/refocus cycle must hand the keyboard back to the chat input.
  // `wasActive` latches only AFTER a focus attempt, so a failed mount-time
  // focus (tabs:update arriving before tabs:active, dialog stealing focus)
  // can retry on the next activation instead of being skipped forever.
  const wasActive = useRef(false);
  useEffect(() => {
    if (activeTab !== tabId) {
      wasActive.current = false;
      return;
    }
    const focusInput = () => {
      const ta = taRef.current;
      if (!ta || ta.disabled) return;
      ta.focus();
      wasActive.current = true;
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryFrame: number | null = null;
    if (!wasActive.current) {
      // Slight delay so the textarea exists after a fresh mount; retry once
      // on the next frame if the focus didn't take.
      timer = setTimeout(() => {
        focusInput();
        if (!wasActive.current) retryFrame = requestAnimationFrame(focusInput);
      }, 30);
    }
    window.addEventListener("focus", focusInput);
    return () => {
      if (timer) clearTimeout(timer);
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
      window.removeEventListener("focus", focusInput);
    };
  }, [activeTab, tabId]);

  /** `opts.preferRpc`: use the RPC path even for a remote/WSL tab. Set by the
   *  EXPLICIT refresh paths (fork / branch navigation / new / clone), which
   *  immediately follow a state change: pi's LIVE state is authoritative there,
   *  while the file can still be behind it (an unflushed navigation is a
   *  documented divergence — see tree-from-file.ts). These paths are rare and
   *  user-initiated, so paying the RPC transfer is the correct trade; the
   *  ambient mount/retry path uses the file instead. */
  const requestHistory = useCallback((opts?: { preferRpc?: boolean }) => {
    // Coalesce, never stack: a trigger arriving while a payload is in flight
    // is recorded by the gate and re-runs ONCE after it settles, instead of
    // opening a PARALLEL multi-MB download on the same link.
    if (!historyGateRef.current.begin()) return;
    const seq = ++historyRequestSeq.current;
    historyLoadedRef.current = false;
    useChatStore.getState().markHistoryLoading(tabId);

    const apply = (messages: unknown[] | undefined) => {
      if (seq !== historyRequestSeq.current || !messages) return;
      historyLoadedRef.current = true;
      useChatStore.getState().initMessages(tabId, messages);
    };

    void (async () => {
      if (!opts?.preferRpc) {
        // File first: it carries the multi-MB history over SFTP/UNC instead of
        // the `pi --mode rpc` command loop, which is serial and behind a
        // stdout-backpressure gate — a big `get_messages` made `prompt`/
        // `get_state` queue, so the agent looked stuck (measured 17–45s round
        // trips). Main scopes this to remote/WSL, verifies the file's message
        // count against pi's own `get_state` count, and answers `ok: false` for
        // anything it cannot serve — that is NOT an error, it is the cue to
        // fall through to RPC, so a pi format change degrades to "slow but
        // correct" rather than blank or stale chat.
        const file = await withTimeout(window.api.session.transcriptFromFile(tabId), TRANSCRIPT_FILE_TIMEOUT_MS);
        if (seq !== historyRequestSeq.current) return;
        if (file?.ok) {
          apply(file.messages);
          return;
        }
      }
      const response = await window.api.tab.rpcRequest(tabId, { type: "get_messages" }, HISTORY_REQUEST_TIMEOUT_MS);
      if (!response.success) return;
      apply((response.data as { messages?: unknown[] } | undefined)?.messages);
    })()
      .catch(() => {
        /* both paths resolve rather than reject; belt-and-braces */
      })
      .finally(() => {
        // Free the slot on EVERY outcome — including a timeout — before any
        // early return, or one lost payload would wedge history forever.
        const rerun = historyGateRef.current.settle();
        if (seq !== historyRequestSeq.current) return; // a newer request owns the state
        // A trigger that arrived mid-flight still needs a snapshot (it may be
        // a branch navigation, whose payload the settled request predates).
        // Triggers are event-driven — mount / state_ready / navigation, never
        // a timer — so this adds at most one download per burst.
        if (rerun) requestHistoryRef.current(opts);
      });
  }, [tabId]);
  requestHistoryRef.current = requestHistory;

  // --- ask_user_question full-questionnaire plumbing -----------------------
  // The rpiv extension's RPC walker emits one select/input dialog per
  // question with no back navigation. We hold the FIRST dialog unanswered,
  // show QuestionnaireDialog built from the tool call args, then answer the
  // walker's sequential dialogs from the collected answers on submit.
  const respondToUi = (req: UiRequest, payload: Record<string, unknown>) => {
    void window.api.rpcUiResponse(tabId, { id: req.id, ...payload });
  };
  const closeQuestionnaire = () => {
    flushRef.current = null;
    questionnaireRef.current = null;
    setQuestionnaireSubmitting(false);
    setQuestionnaire(null);
  };
  /** Answer one walker dialog from the flush plan. False = dialog not ours. */
  const tryFlushStep = (req: UiRequest, flush: NonNullable<typeof flushRef.current>): boolean => {
    const step = flush.steps[flush.nextIndex];
    if (!step) return false;
    const q = flush.questions[step.qi];
    if (!q || !walkerTitleStarts(req.title, q)) return false;
    const payload = buildFlushResponse(step, flush.answers[step.qi]!, req.options ?? []);
    if (payload === null) return false;
    respondToUi(req, payload);
    flush.nextIndex++;
    if (flush.nextIndex >= flush.steps.length) closeQuestionnaire();
    return true;
  };
  /** Open the full questionnaire when the walker's first dialog arrives. */
  const tryOpenQuestionnaire = (req: UiRequest): boolean => {
    if (req.method !== "select" && req.method !== "input") return false;
    const questions = findRunningAskUserQuestion(tabId);
    if (!questions) return false;
    if (!walkerTitleStarts(req.title, questions[0]!)) return false;
    questionnaireRef.current = {
      questions,
      firstReq: req,
      // The walker's sentinel label follows the host locale — mirror it in
      // the custom-answer row instead of hardcoding English.
      sentinelLabel: extractSentinelLabel(req.options),
    };
    setQuestionnaire(questionnaireRef.current);
    return true;
  };
  const handleQuestionnaireSubmit = (answers: Record<number, QAnswer>) => {
    const open = questionnaireRef.current;
    if (!open) return;
    // Re-entry guard: a held Enter + button click in the same tick must not
    // rebuild the flush plan mid-flush (answers would mis-map to dialogs).
    if (flushRef.current) return;
    const steps = buildFlushSteps(open.questions, answers);
    if (steps.length === 0) {
      closeQuestionnaire();
      return;
    }
    setQuestionnaireSubmitting(true);
    flushRef.current = { steps, nextIndex: 0, questions: open.questions, answers };
    // Answer the held first dialog now; subsequent dialogs arrive via offUi.
    if (!tryFlushStep(open.firstReq, flushRef.current)) {
      // Practically unreachable (title already matched at open; the walker
      // always sends options). Abort honestly — surfacing it as a normal
      // dialog could let a later dialog re-open a misaligned questionnaire.
      respondToUi(open.firstReq, { cancelled: true });
      closeQuestionnaire();
    }
  };
  const handleQuestionnaireCancel = () => {
    const open = questionnaireRef.current;
    if (!open) return;
    // Dismissing any dialog cancels the whole walker (mirrors Esc in the TUI).
    respondToUi(open.firstReq, { cancelled: true });
    closeQuestionnaire();
  };

  useEffect(() => {
    useChatStore.getState().ensure(tabId);
    const offEvent = window.api.onRpcEvent(tabId, (event) => {
      // Liveness clock: ANY frame from pi (event, response, delta) proves the
      // pipe is alive, so it also clears the connection-death banner.
      lastEventAtRef.current = Date.now();
      if (unresponsiveRef.current) flagUnresponsive(null);
      // Responses to MAIN's internal probes (the transcript provider's
      // get_state) are not this component's requests. Letting one reach the
      // `state_ready` branch below would re-enter requestHistory → probe → …
      // (a self-feeding loop), so they are dropped here.
      if (typeof event.id === "string" && event.id.startsWith(INTERNAL_RPC_ID_PREFIX)) return;
      if (event.type === "rpc_unresponsive") {
        // Main's post-boot silence watchdog: a command was written and not a
        // single byte came back — the pipe is gone (silently dropped SSH flow,
        // wedged remote process). Definitive, unlike a merely quiet turn.
        flagUnresponsive({
          silentMs: typeof event.silentMs === "number" ? event.silentMs : 0,
          detail: ((event.stderr as string | undefined) ?? "").trim() || null,
        });
        return;
      }
      if (event.type === "rpc_no_output") {
        // Main's zero-output watchdog: the remote produced no bytes at all
        // (auth hang / .bashrc block / pi missing) — same conclusion as the
        // 30s boot timer, but definitive and earlier.
        const st = useChatStore.getState().states[tabId];
        if (!st?.booted && !st?.exited) {
          setBootTimedOut(true);
          setBootTimeoutDetail(((event as { stderr?: string }).stderr ?? "").trim() || null);
        }
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
        // Model changes invalidate the thinking-level cache: the available
        // levels belong to the selected model, not the provider.
        setThinkingLevels([]);
        if (event.success === false) {
          // Backend refused the switch ("No API key for p/m" from pi's auth
          // check, "Model not found" from a stale menu cache, …). The menu is
          // already closed at this point — without surfacing this the header
          // keeps the old model and the switch silently no-ops (the classic
          // "切了但没换" report). Do NOT optimistically patch or re-query:
          // get_state would just confirm the unchanged old model.
          const errText = typeof event.error === "string" && event.error ? event.error : "未知错误";
          useUiStore.getState().showToast(`切换模型失败：${errText}`, "err");
          return;
        }
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
          modelFallbackMessage?: string | null;
        } | undefined;
        if (data && (data.model || data.thinkingLevel || data.steeringMode || data.followUpMode || data.autoCompactionEnabled !== undefined)) {
          // SDK backend only: pi failed to restore the session's model
          // (e.g. its provider lost auth) and fell back to the default —
          // the TUI prints a banner for this, the chat view used to show
          // nothing, so users saw "different models" across views.
          if (data.modelFallbackMessage && !seenModelFallbackRef.current) {
            seenModelFallbackRef.current = true;
            useUiStore.getState().showToast(`模型恢复失败：${data.modelFallbackMessage}`, "err");
          }
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
          // requestHistory (NOT a bare get_messages): the transcript is only
          // ever applied via `initMessages`, so a bare send opened a multi-MB
          // RPC transfer whose payload was dropped — and left the chat stuck on
          // the OLD branch. This is the rule already documented for `onNavigated`.
          requestHistory({ preferRpc: true });
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
        nudgeSessionTitle();
        return;
      }
      useChatStore.getState().applyEvent(tabId, event);
    });
    const offExit = window.api.onRpcExit(tabId, (info) => useChatStore.getState().markExited(tabId, info));
    const offUi = window.api.onRpcUiRequest(tabId, (raw) => {
      const req = raw as unknown as UiRequest;
      const consumed = handleFireAndForget(req, (text) => {
        setInput(text);
        requestAnimationFrame(() => {
          taRef.current?.focus();
        });
      });
      if (!consumed) {
        // While flushing answers back, every incoming dialog belongs to the
        // walker — answer it from the flush plan. An unexpected dialog shape
        // aborts the walker honestly (mismatch is essentially impossible;
        // answering out of order would corrupt the question mapping).
        const flush = flushRef.current;
        if (flush) {
          if (tryFlushStep(req, flush)) return;
          respondToUi(req, { cancelled: true });
          closeQuestionnaire();
          return;
        }
        // First walker dialog → open the full questionnaire instead.
        if (!questionnaireRef.current && tryOpenQuestionnaire(req)) return;
        setUiReq(req);
      }
    });

    // Boot history when this tab is first shown. The main process already
    // requests get_state during session creation and forwards it. Re-ask for
    // history UNCONDITIONALLY on mount: with the SDK backend the get_messages
    // response can arrive before this subscription exists (worker is ~50ms vs
    // RPC's ~1.9s), so booted=true from state_ready must not suppress it.
    const st2 = useChatStore.getState().states[tabId];
    // Unconditional within THIS mount: hidden tabs also need history ready for
    // when they're shown, and a remount (terminal view → chat view) must
    // re-read a session that advanced while the chat was unmounted. Not on
    // every `active` flip though — `active` is deliberately NOT a dependency
    // of this effect: a huge remote session's get_messages payload (multi-MB)
    // was re-downloaded and re-parsed on every tab switch, which is what made
    // switching tabs to a long session hang. Mount-time/live events keep the
    // transcript current; explicit paths (new_session/fork/clone/navigate,
    // app_phase ready) re-request history on their own.
    requestHistory();
    void window.api.tab.rpcSend(tabId, { type: "get_session_stats" });
    // Session behavior fields (steeringMode/…) ride on get_state; the boot
    // handshake may have raced the subscription, so re-ask when missing.
    if (activeRef.current && st2.steeringMode === undefined) {
      void window.api.tab.rpcSend(tabId, { type: "get_state" });
    }
    return () => {
      offEvent();
      offExit();
      offUi();
    };
  }, [tabId, requestHistory]);

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

  // NOTE: there used to be an effect here that sent a bare
  // `rpcSend(get_messages)` when the active tab had no messages. It was removed
  // because nothing consumed its response: `chatStore.applyEvent` has no
  // `get_messages` branch (history is applied only by `initMessages`, reached
  // via `requestHistory`'s own request id), and main has no side effect on that
  // response (session linkage comes from `get_state` — see pty.ts:1568).
  // So it opened an UNGATED, UN-COALESCED multi-MB transfer on the serial RPC
  // command loop whose payload was discarded, re-firing on every remount while
  // history happened to be empty (the bare `SEND get_messages` every ~30s in
  // pipi-debug.log). History is owned by `requestHistory`: gated, file-first,
  // and retried on `state_ready`.

  // Model config hot-sync: the ModelConfigDialog bumps modelConfigSavedAt
  // (with a target payload) after saving ~/.pi/agent/models.json (locally or
  // via SFTP). Running pi processes never re-read those files on their own
  // (even pi's /reload doesn't refresh the model registry), so this invokes
  // the shipped pipi-model-sync extension command — ctx.modelRegistry.refresh()
  // inside the live session. The prompt is gated on get_commands (an unknown
  // slash command would leak into the transcript as a user message); the
  // prompt's own response frame is the completion signal (extension commands
  // never start an agent run, so there is no agent_settled to await).
  // After completion the two header caches are dropped and re-fetched.
  const modelConfigSavedAt = useUiStore((s) => s.modelConfigSavedAt);
  const modelConfigTarget = useUiStore((s) => s.modelConfigTarget);
  const seenModelSaveRef = useRef(modelConfigSavedAt);
  useEffect(() => {
    if (modelConfigSavedAt === seenModelSaveRef.current) return;
    seenModelSaveRef.current = modelConfigSavedAt;
    const target = modelConfigTarget;
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    // Scope the sync to tabs the save actually applies to (pure predicate in
    // model-sync.ts: local saves reach SDK + local-rpc chat tabs; remote/WSL
    // saves reach tabs on exactly that profile).
    if (!modelSyncAppliesTo(target, tab)) return;
    // Listener + fallback timer live in the effect scope so cleanup reaps
    // both even when the save supersedes an in-flight handshake.
    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let offResp: (() => void) | null = null;
    const settle = () => {
      if (cancelled) return;
      cancelled = true;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      offResp?.();
      offResp = null;
      setModelList([]);
      setThinkingLevels([]);
      void window.api.tab.rpcSend(tabId, { type: "get_available_models" });
    };
    void (async () => {
      try {
        // Does this session know the shipped extension command?
        const cmds = await window.api.tab.rpcRequest(tabId, { type: "get_commands" }, 10000);
        if (cancelled) return;
        const known = cmds.success && Array.isArray((cmds.data as { commands?: Array<{ name?: unknown }> } | undefined)?.commands)
          && ((cmds.data as { commands: Array<{ name?: unknown }> }).commands.some((c) => c?.name === "pipi-model-sync"));
        if (!known) return; // old pi / extension not synced yet — next session restart picks the config up from disk
        // Invoke it. The prompt response arrives the moment the extension
        // handler finishes; keep the menu cache dirty until then.
        const reqId = `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        offResp = window.api.onRpcEvent(tabId, (event) => {
          if (event.type !== "response" || event.id !== reqId) return;
          // Success OR an explicit error response both mean the command
          // dispatch has finished — refresh the menu either way.
          settle();
        });
        const sent = await window.api.tab.rpcSend(tabId, { type: "prompt", message: "/pipi-model-sync", expandPromptTemplates: true, id: reqId });
        if (cancelled) return;
        if (!sent) {
          // Session gone — drop the listener quietly.
          cancelled = true;
          offResp?.();
          offResp = null;
          return;
        }
        // No response within the window: treat as settled anyway so a long
        // turn can't leave the menu stale — a fresh get_available_models is
        // harmless against the same snapshot.
        settleTimer = setTimeout(settle, 15000);
      } catch {
        /* rpcRequest can only resolve; this path is belt-and-braces */
      }
    })();
    return () => {
      cancelled = true;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      offResp?.();
      offResp = null;
    };
  }, [modelConfigSavedAt, modelConfigTarget, tabId]);

  useEffect(() => {
    // credentials, …), stop the spinner after 30s and point at the fallback.
    const timer = setTimeout(() => {
      const st = useChatStore.getState().states[tabId];
      if (!st?.booted && !st?.exited) setBootTimedOut(true);
    }, 30000);
    return () => clearTimeout(timer);
  }, [tabId]);

  useEffect(() => () => {
    if (completionTimer.current) clearTimeout(completionTimer.current);
  }, []);

  useEffect(() => {
    if (state?.turn.phase !== "completed") return;
    setCompletionVisible(true);
    if (completionTimer.current) clearTimeout(completionTimer.current);
    completionTimer.current = setTimeout(() => setCompletionVisible(false), 2500);
  }, [state?.turn.phase]);

  const isStreaming = !!state?.isStreaming;
  const exited = !!state?.exited;

  // Reconnect and continue the same session: close the dead tab and spawn a
  // fresh backend (same remote profile / session file). Pi sessions live on
  // disk, so resuming is cheap — the process itself cannot be revived.
  const resumeSession = async () => {
    if (switchBusy) return;
    setSwitchBusy(true);
    try {
      const tabsState = useTabsStore.getState();
      const tab = tabsState.tabs.find((t) => t.id === tabId);
      const info = await window.api.remote.getInfo(tabId);
      const cwd = tabsState.cwd || ".";
      await window.api.tab.close(tabId);
      useChatStore.getState().clear(tabId);
      let id: string;
      if ((info as { isWsl?: boolean } | null)?.isWsl) {
        const w = info as { host: string; path?: string };
        id = await window.api.tab.create({ cwd, sessionPath: tab?.sessionPath, wsl: { distro: w.host, path: w.path } });
      } else if (info) {
        id = await window.api.tab.create({
          cwd,
          sessionPath: tab?.sessionPath,
          remote: {
            host: info.host,
            user: info.user,
            port: info.port,
            path: info.path,
            password: info.password,
            startPi: info.startPi,
            agentDir: (info as { agentDir?: string }).agentDir,
          },
        });
      } else {
        id = await window.api.tab.create({ cwd, sessionPath: tab?.sessionPath, continueRecent: tab?.sessionPath ? undefined : true });
      }
      useTabsStore.getState().selectTab(id);
    } catch (e) {
      useUiStore.getState().showToast(`重新连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setSwitchBusy(false);
    }
  };
  const phase = state?.turn.phase ?? "booting";
  // "Where does this session run" — read from the tab record (remote/WSL tabs
  // keep the project in remoteDir: their cwd is the local app directory).
  const project = useTabsStore(
    useShallow((s) => {
      const label = projectLabelForTab(s.tabs.find((t) => t.id === tabId));
      return label ? { short: label.short, full: label.full } : null;
    }),
  );
  const phaseLabel: Record<string, string> = {
    booting: "正在启动 Pi…",
    ready: "已就绪",
    submitting: "已发送，等待 Pi 开始处理…",
    accepted: "Pi 已受理，等待模型响应…",
    thinking: "正在思考…",
    streaming: "正在回复…",
    tool: state?.turn.detail ?? "正在执行工具…",
    retrying: "模型暂时不可用，正在重试…",
    compacting: "正在压缩上下文…",
    queued: state?.turn.detail ?? "消息已排队",
    cancelling: "正在停止…",
    completed: "✓ Agent 已完成",
    failed: state?.turn.detail ?? "本轮出现错误",
    exited: "Pi 已退出",
  };
  const phaseActive = !["ready", "completed", "failed", "exited"].includes(phase);

  // Live elapsed clock while the agent is working — the "已运行 Xs" on the
  // banner makes a long think/tool run obviously alive instead of hung.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!phaseActive) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseActive, phase]);

  /** Set/clear the connection-death banner (ref keeps the event handler cheap). */
  const flagUnresponsive = (value: { silentMs: number; detail?: string | null } | null) => {
    unresponsiveRef.current = !!value;
    setUnresponsive(value);
  };

  /**
   * Remote/WSL tab titles follow the session LIST, and that list is lazily
   * refreshed (12s cache + 4s poll) and its labels come from background
   * hydration — so a brand-new session's name can take ~20s to reach the tab
   * while the sidebar already shows it. One targeted listRemote call right
   * after a turn settles prioritizes that project's hydration (main marks the
   * cache priority 2), which runs emitRemoteSessionsUpdated → the tab title
   * sync, within a second or two. Local tabs are not nudged: their titles come
   * from the session-file watcher, which is immediate.
   */
  const titleNudgeRef = useRef<{ initial: string; attempts: number } | null>(null);
  const nudgeSessionTitle = () => {
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || (!tab.isRemote && !tab.isWsl)) return;
    const seen = (titleNudgeRef.current ??= { initial: tab.title, attempts: 0 });
    // Stop as soon as a real title replaced the placeholder (project/folder
    // name) the tab was born with, and never poll in a loop.
    if (tab.title !== seen.initial || seen.attempts >= 3) return;
    seen.attempts += 1;
    void window.api.session.listRemote(tabId, tab.remoteDir || tab.cwd).catch(() => {});
  };

  // Connection watchdog. Two failures look identical in the UI while a turn is
  // running and both end in "已发送，等待 Pi 开始处理…" forever:
  //   1. the transport died (SSH flow silently dropped, remote process wedged)
  //      yet no exit ever reaches us;
  //   2. pi is alive but stuck inside prompt preflight (waiting on the provider
  //      or an extension hook) and will never emit a single event.
  // A silent turn alone proves nothing — a long tool run is legitimately quiet —
  // so the verdict comes from a read-only probe: only an UNANSWERED probe
  // declares the connection dead. get_session_stats is the cheap command that
  // cannot disturb the turn (unlike get_state, which refreshes UI state).
  useEffect(() => {
    if (!phaseActive) return;
    let cancelled = false;
    const tick = setInterval(() => {
      if (probeInFlightRef.current || unresponsiveRef.current || exited) return;
      const silentMs = Date.now() - lastEventAtRef.current;
      if (silentMs < NO_RESPONSE_PROBE_MS) return;
      probeInFlightRef.current = true;
      void window.api.tab
        .rpcRequest(tabId, { type: "get_session_stats" }, PROBE_TIMEOUT_MS)
        .then((res) => {
          probeInFlightRef.current = false;
          if (cancelled) return;
          // Answered → pi is alive, just quiet. Any event also bumps the clock.
          if (res.success) return;
          flagUnresponsive({ silentMs: Date.now() - lastEventAtRef.current, detail: null });
        })
        .catch(() => {
          probeInFlightRef.current = false;
        });
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseActive, tabId, exited]);

  // pi refused the prompt before it entered the transcript: hand the text back
  // to the composer. Losing a long prompt behind a spinner is the failure mode
  // users report as "发了没反应".
  const restoreInput = state?.restoreInput;
  useEffect(() => {
    if (!restoreInput) return;
    const text = useChatStore.getState().consumeRestoreInput(tabId);
    if (!text) return;
    setInput((prev) => (prev.trim() ? prev : text));
    requestAnimationFrame(() => taRef.current?.focus());
  }, [restoreInput, tabId]);

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
        // requestHistory, not a bare get_messages: a bare send's payload is
        // dropped, so the new (empty) session's transcript would never replace
        // the old one. preferRpc: this follows a state change, so pi's LIVE
        // state is authoritative (the file may not have the new session yet).
        requestHistory({ preferRpc: true });
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
        // and session state from the new session file. requestHistory, not a
        // bare get_messages — the latter's payload is dropped. preferRpc: the
        // file cannot be trusted to hold the new session yet.
        requestHistory({ preferRpc: true });
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
    if (attachingFilesRef.current) return;
    attachingFilesRef.current = true;
    setAttachingFiles(true);
    const mentionedPaths = fileMentionPaths(text);
    const attachments: string[] = [];
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    let attachmentChars = 0;
    try {
    for (const path of mentionedPaths.slice(0, 8)) {
      const result = await window.api.file.read(tabId, path, undefined, true);
      if (result.error) {
        // Silent degrade: keep the authored @path in the message text — pi
        // has its own read tool and can fetch the file itself. Blocking with
        // an error toast was wrong: an unreferencable file is not the user's
        // mistake to fix, and the mention is still useful to the agent.
        continue;
      }
      if (result.image) {
        images.push({ type: "image", data: result.image.base64, mimeType: result.image.mimeType });
        attachments.push(`\n\n[已附加图片：${path}]`);
      } else if (!result.isBinary) {
        const remaining = 120_000 - attachmentChars;
        if (remaining <= 0) break;
        const content = result.content.slice(0, remaining);
        attachmentChars += content.length;
        attachments.push(`\n\n<file path="${path}">\n${content}${result.truncated ? "\n[文件过大，内容已截断]" : ""}\n</file>`);
      }
      // Binary (or oversized image beyond the preview cap): same silent
      // degrade — the @path text stays, pi fetches it with its own tools.
    }
    // Keep the authored @path in the visible chat history; only Pi receives
    // the expanded <file> context, matching the native TUI's UX.
    useChatStore.getState().sendPrompt(tabId, `${text}${attachments.join("")}`, images.length ? images : undefined, text);
    setInput((current) => current === input ? "" : current);
    setSlashOpen(false);
    setMentionOpen(false);
    } catch (error) {
      useUiStore.getState().showToast(`读取引用文件失败: ${error instanceof Error ? error.message : String(error)}`, "err");
    } finally {
      attachingFilesRef.current = false;
      setAttachingFiles(false);
    }
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

  const insertMention = (file: FileMention) => {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? input.length;
    const token = fileMentionTokenAt(input, caret);
    if (!token) return;
    const nextValue = replaceFileMention(input, token, file.path);
    // Selecting a file completes the mention. Invalidate the in-flight query
    // before changing the controlled textarea; otherwise its response can
    // keep the old completion lifecycle alive while the user continues typing.
    if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);
    mentionTimerRef.current = null;
    mentionRequestRef.current += 1;
    setInput(nextValue);
    setMentionOpen(false);
    setSlashOpen(false);
    requestAnimationFrame(() => {
      const editor = taRef.current;
      if (editor) {
        editor.focus();
        editor.setSelectionRange(nextValue.length, nextValue.length);
      }
      grow();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: Enter/Arrow keys belong to the composition, not the
    // popup. Bail before any slash handling so committing Chinese text works.
    if (!e.nativeEvent.isComposing && mentionOpen) {
      const list = filterFileMentions(mentionFiles, mentionQuery);
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => list.length ? (i + 1) % list.length : 0); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => list.length ? (i - 1 + list.length) % list.length : 0); return; }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        const file = list[Math.min(mentionIndex, Math.max(list.length - 1, 0))];
        if (file) { e.preventDefault(); insertMention(file); return; }
        if (e.key === "Tab") return;
      }
      if (e.key === "Escape") { e.preventDefault(); setMentionOpen(false); return; }
    }
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
  const syncInputMenus = (v: string, caret: number) => {
    const mention = fileMentionTokenAt(v, caret);
    if (mention) {
      setMentionQuery(mention.query);
      setMentionOpen(true);
      setMentionIndex(0);
      setSlashOpen(false);
      if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);
      const request = ++mentionRequestRef.current;
      setMentionsLoading(true);
      mentionTimerRef.current = setTimeout(() => {
        mentionTimerRef.current = null;
        void window.api.file.searchMentions(tabId, mention.query).then((result) => {
          if (request !== mentionRequestRef.current) return;
          // A transient remote/SFTP failure must not erase usable candidates
          // and masquerade as an empty search result.
          if (result.error) {
            useUiStore.getState().showToast(result.error, "err");
            return;
          }
          setMentionFiles(result.files);
        }).catch(() => {
          if (request === mentionRequestRef.current) useUiStore.getState().showToast("搜索项目文件失败", "err");
        }).finally(() => {
          if (request === mentionRequestRef.current) setMentionsLoading(false);
        });
      }, 180);
      return;
    }
    if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);
    mentionTimerRef.current = null;
    mentionRequestRef.current += 1;
    setMentionOpen(false);
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
  const modelButtonLabel = state?.modelProvider
    ? `${state.modelProvider} · ${state.modelName ?? state.modelId ?? "模型"}`
    : state?.modelName ?? state?.modelId ?? "模型";

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
        <div className="chat-header-left" ref={headerMenusRef}>
          {project && (
            <button
              className="chat-header-btn chat-project-btn"
              title={`项目：${project.full}\n点击复制路径`}
              onClick={() => {
                void navigator.clipboard.writeText(project.full).then(
                  () => useUiStore.getState().showToast("已复制项目路径", "ok"),
                  () => useUiStore.getState().showToast(`项目路径：${project.full}`, "ok"),
                );
              }}
            >
              <Icon name="folder" /> {project.short}
            </button>
          )}
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
              title={`${modelButtonLabel}${state?.sessionName ? ` · ${state.sessionName}` : ""} — 点击切换模型`}
            >
              {modelButtonLabel} ▾
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
                          // rpcSend resolves false when the session process is
                          // gone (exited flag / dead channel) — the command was
                          // DROPPED, so no response (and no error toast from
                          // the handler above) will ever arrive. Say so now.
                          void window.api.tab
                            .rpcSend(tabId, { type: "set_model", provider: m.provider ?? selectedProvider ?? m.id.split("/")[0], modelId: m.id })
                            .then((sent) => {
                              if (!sent) useUiStore.getState().showToast("切换模型失败：会话未连接", "err");
                            });
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
            <Icon name="puzzle" /> {extCommands.length} 扩展
          </span>
          )}
        </div>
        <div className="chat-header-right">
          <button className="chat-header-btn" onClick={() => setTreeOpen(true)} title="会话分支（fork）">
            分支
          </button>
          <button className="chat-header-btn" onClick={switchToTerminal} disabled={switchBusy} title="切换为完整终端视图（TUI）">
            终端视图
          </button>
        </div>
      </div>

      <ChatNotices />

      <ChatTimeline tabId={tabId} bootTimedOut={bootTimedOut} bootTimeoutDetail={bootTimeoutDetail} />

      {exited && (() => {
        const banner = exitBannerText(state?.exitCode, state?.exitDetail);
        return (
          <div className="chat-exited-bar">
            {/* title carries the full untruncated reason (the inline text is
                bounded so the bar stays one line). */}
            <span title={banner.detail ? state?.exitDetail ?? undefined : undefined}>
              {banner.headline}
              {banner.detail ? ` · ${banner.detail}` : ""}
            </span>
            <button className="chat-btn" onClick={resumeSession} disabled={switchBusy}>继续此会话</button>
            <button className="chat-btn" onClick={switchToTerminal} disabled={switchBusy}>终端视图</button>
          </div>
        );
      })()}

      {unresponsive && !exited && (
        <div className="chat-exited-bar chat-unresponsive-bar">
          <span title={unresponsive.detail ?? undefined}>
            Pi 已 {fmtElapsed(Math.max(1, Math.round(unresponsive.silentMs / 1000)))} 无响应 —
            连接可能已断开（远程主机掉线 / 网络中断）
            {unresponsive.detail ? `：${unresponsive.detail.slice(0, 120)}` : ""}
          </span>
          <button className="chat-btn" onClick={resumeSession} disabled={switchBusy}>重新连接</button>
          <button className="chat-btn" onClick={switchToTerminal} disabled={switchBusy}>终端视图</button>
        </div>
      )}

      <div className="chat-input-wrap">
        {(phaseActive || completionVisible) && (
          <div className={`chat-turn-status ${phase === "completed" ? "completed" : ""}`}>
            {phaseActive && <span className="chat-turn-spinner" />}
            <span>{phaseLabel[phase]}</span>
            {phaseActive && <span className="chat-turn-elapsed">已运行 {fmtElapsed(elapsed)}</span>}
          </div>
        )}
        {mentionOpen && (
          <FileMentionMenu
            files={mentionFiles}
            query={mentionQuery}
            selectedIndex={Math.min(mentionIndex, Math.max(filterFileMentions(mentionFiles, mentionQuery).length - 1, 0))}
            loading={mentionsLoading}
            onSelect={insertMention}
            onHover={setMentionIndex}
          />
        )}
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
          placeholder={exited ? "pi 已退出，请切换到终端视图" : phase === "submitting" || phase === "accepted" ? "消息已发送，等待 Pi 响应…" : phase === "cancelling" ? "正在停止当前任务…" : isStreaming ? "agent 运行中 — Enter 排队发送" : "输入消息…（Shift+Enter 换行）"}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            grow();
            syncInputMenus(v, e.target.selectionStart ?? v.length);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            // Caret-only moves (arrows/Home/End) don't fire onChange — keep
            // the popup query in sync so Enter inserts what the popup shows.
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
              const ta = taRef.current;
              if (ta) syncInputMenus(ta.value, ta.selectionStart ?? ta.value.length);
            }
          }}
          onClick={() => {
            const ta = taRef.current;
            if (ta) syncInputMenus(ta.value, ta.selectionStart ?? ta.value.length);
          }}
          onBlur={() => {
            if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);
            mentionTimerRef.current = null;
            mentionRequestRef.current += 1;
            setSlashOpen(false);
            setMentionOpen(false);
          }}
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
            {phase === "cancelling" ? "正在停止…" : isStreaming ? "Enter 排队（steer）· Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行 · @ 引用文件 · / 命令"}
          </span>
          {isStreaming && (
            <button className="chat-btn stop" onClick={() => useChatStore.getState().abort(tabId)} disabled={phase === "cancelling"}>
              {phase === "cancelling" ? "正在停止…" : "■ 停止"}
            </button>
          )}
          <button className="chat-btn send" onClick={send} disabled={!input.trim() || exited || attachingFiles}>
            发送
          </button>
        </div>
      </div>
      {uiReq && <UiDialog tabId={tabId} req={uiReq} onClose={() => setUiReq(null)} />}
      {questionnaire && (
        <QuestionnaireDialog
          questions={questionnaire.questions}
          submitting={questionnaireSubmitting}
          active={active}
          sentinelLabel={questionnaire.sentinelLabel}
          onSubmit={handleQuestionnaireSubmit}
          onCancel={handleQuestionnaireCancel}
        />
      )}
      {treeOpen && (
        <TreeDialog
          tabId={tabId}
          onClose={() => setTreeOpen(false)}
          onOpenTerminal={() => {
            setTreeOpen(false);
            void switchToTerminal();
          }}
          onNavigated={(editorText) => {
            // Navigation switched the leaf: reload history. requestHistory()
            // (rpcRequest → initMessages) is the ONLY path that actually
            // refreshes the transcript — a bare rpcSend(get_messages)
            // response is dropped by the event handlers, leaving the chat
            // stuck at the end of the old branch. get_state keeps the
            // session-behavior fields in sync. preferRpc: navigation just moved
            // the leaf, and an unflushed navigation is a documented divergence
            // from the file — pi's live state is authoritative here.
            requestHistory({ preferRpc: true });
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
