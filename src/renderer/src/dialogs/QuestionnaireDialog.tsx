/**
 * QuestionnaireDialog — full multi-question UI for `ask_user_question` in the
 * chat view, with parity to the TUI's tabbed overlay.
 *
 * Background: `ask_user_question` is provided by the third-party package
 * `@juicesharp/rpiv-ask-user-question`. In RPC mode (which both the local SDK
 * worker and remote/WSL `pi --mode rpc` use in the chat view) it renders by
 * walking ONE native select/input dialog per question (rpc-fallback.ts) — no
 * tab bar, no back navigation, previews folded into titles, multi-select as
 * free-text "1,3" input. The terminal view (TUI) gets a tabbed overlay with
 * `Shift+Tab`/`←` back navigation.
 *
 * ChatPane intercepts the walker's first dialog when a running
 * `ask_user_question` tool call is visible in the chat stream, shows THIS full
 * questionnaire (tab chips + back/next + Submit review + side-by-side preview
 * + multi-select checkboxes), then feeds the walker's sequential dialogs with
 * the collected answers (see `buildFlushSteps` / `walkerTitleStarts`).
 *
 * The component is presentational: it only collects answers. Answering the
 * backend dialogs is ChatPane's job (it owns `rpcUiResponse` and the UI
 * request stream).
 */
import { useEffect, useRef, useState } from "react";

export interface QOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface QQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: QOption[];
}

export type QAnswer =
  | { kind: "option"; index: number }
  | { kind: "custom"; text: string }
  | { kind: "multi"; selected: number[] };

/** Sentinel row label — matches the extension's reserved "Type something." row. */
const DEFAULT_SENTINEL_LABEL = "Type something.";

/** localStorage key for the questionnaire window's dragged position. */
const POS_STORAGE_KEY = "pipi:questionnaire:pos";

/**
 * Extract the walker's sentinel row label from its select dialog options
 * (last option line "N+1. <label>"), so the custom row follows the host
 * locale (e.g. Chinese "自定义输入…") instead of hardcoded English.
 */
export function extractSentinelLabel(options: string[] | undefined): string {
  const last = options && options.length > 0 ? options[options.length - 1]! : "";
  const m = /^\d+\.\s*(.*)$/.exec(last);
  return m?.[1]?.trim() || DEFAULT_SENTINEL_LABEL;
}

/** Key action the questionnaire should take for a keypress. Pure so the
 * minimized-hidden dialog can't receive Enter/arrow keys — they would submit
 * or navigate a dialog the user cannot see (the transcript is interactive
 * again once the overlay is gone). Event-context guards (IME composition,
 * focus inside an INPUT/TEXTAREA) stay in the component's keydown handler. */
export type QuestionnaireKeyAction = "cancel" | "prev" | "next" | "submit" | null;
export function questionnaireKeyAction(
  key: string,
  ctx: { minimized: boolean; tab: number; submitTab: number; allAnswered: boolean },
): QuestionnaireKeyAction {
  if (ctx.minimized) return key === "Escape" ? "cancel" : null;
  if (key === "Escape") return "cancel";
  if (key === "ArrowLeft") return "prev";
  if (key === "ArrowRight") return "next";
  if (key === "Enter" && ctx.tab === ctx.submitTab && ctx.allAnswered) return "submit";
  return null;
}

/** Parse the `questions` array out of an ask_user_question tool call's args. */
export function parseQuestionsFromArgs(argsText: string): QQuestion[] | null {
  try {
    const args = JSON.parse(argsText || "{}") as { questions?: unknown };
    if (!Array.isArray(args.questions) || args.questions.length === 0) return null;
    const out: QQuestion[] = [];
    for (const raw of args.questions) {
      const r = (raw ?? {}) as {
        header?: unknown;
        question?: unknown;
        multiSelect?: unknown;
        options?: unknown;
      };
      const options = Array.isArray(r.options)
        ? (r.options as Array<Record<string, unknown>>)
            .filter((o) => o && typeof o.label === "string")
            .map((o) => ({
              label: o.label as string,
              description: typeof o.description === "string" ? o.description : undefined,
              preview: typeof o.preview === "string" ? o.preview : undefined,
            }))
        : [];
      if (typeof r.question !== "string" || r.question.trim() === "" || options.length === 0) continue;
      out.push({
        header: typeof r.header === "string" ? r.header : undefined,
        question: r.question,
        multiSelect: r.multiSelect === true,
        options,
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Every dialog the walker emits for a question starts its title with
 * `[header] question` (single select + preview block, multi input + list,
 * "Type something." follow-up input). Used both to recognize the walker's
 * first dialog and to correlate dialogs to questions during the flush.
 */
export function walkerTitleStarts(title: string | undefined, q: QQuestion): boolean {
  if (!title) return false;
  const prefix = q.header ? `[${q.header}] ${q.question}` : q.question;
  return title.startsWith(prefix);
}

/**
 * Emission order of the walker's dialogs given the collected answers:
 * per question, one select (single) or input (multi), plus one follow-up
 * input when a single-select question was answered with a custom text.
 */
export function buildFlushSteps(
  questions: QQuestion[],
  answers: Record<number, QAnswer>,
): Array<{ qi: number; kind: "select" | "multi" | "custom" }> {
  const steps: Array<{ qi: number; kind: "select" | "multi" | "custom" }> = [];
  for (let qi = 0; qi < questions.length; qi++) {
    if (questions[qi]!.multiSelect) {
      steps.push({ qi, kind: "multi" });
    } else {
      steps.push({ qi, kind: "select" });
      if (answers[qi]?.kind === "custom") steps.push({ qi, kind: "custom" });
    }
  }
  return steps;
}

/**
 * Build the `{ value }` payload the walker expects for one dialog, given the
 * flush step and the collected answer. Returns null when the step cannot be
 * answered (e.g. select dialog without options) — the caller aborts then.
 */
export function buildFlushResponse(
  step: { qi: number; kind: "select" | "multi" | "custom" },
  answer: QAnswer,
  options: string[],
): { value: string } | null {
  if (step.kind === "select") {
    if (options.length === 0) return null;
    if (answer.kind === "custom") return { value: options[options.length - 1]! };
    if (answer.kind === "option") return { value: options[answer.index] ?? options[options.length - 1]! };
    return { value: options[options.length - 1]! };
  }
  if (step.kind === "multi") {
    // Walker expects 1-based indices as plain text ("1,3"), or free text
    // for a custom answer, or "" for an empty commit.
    if (answer.kind === "multi") return { value: answer.selected.length ? answer.selected.map((i) => i + 1).join(",") : "" };
    if (answer.kind === "custom") return { value: answer.text };
    return { value: "" };
  }
  // custom follow-up input
  return { value: answer.kind === "custom" ? answer.text : "" };
}

interface QuestionnaireDialogProps {
  questions: QQuestion[];
  /** True while ChatPane is flushing answers back to the walker's dialogs. */
  submitting: boolean;
  /** False while this tab is hidden — keyboard must stay with the visible tab. */
  active: boolean;
  /** Custom-answer row label, from the walker's first dialog (host locale). */
  sentinelLabel?: string;
  onSubmit: (answers: Record<number, QAnswer>) => void;
  onCancel: () => void;
}

export function QuestionnaireDialog({ questions, submitting, active, sentinelLabel, onSubmit, onCancel }: QuestionnaireDialogProps) {
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  // Genuine unmount (tab closed, or chat→terminal view switch) must not leave
  // the walker's held dialog unanswered — abort the questionnaire so the
  // agent's turn isn't stuck. Normal close paths (submit/cancel) already
  // answered the held dialog; the stale id is ignored by the backend.
  useEffect(() => {
    return () => {
      onCancelRef.current();
    };
  }, []);

  const submitTab = questions.length;
  const [tab, setTab] = useState(0); // 0..n-1 = questions, n = submit tab

  // Draggable window position. null = centered (default). Remembered across
  // sessions via localStorage so one drag benefits every later questionnaire.
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem(POS_STORAGE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
      if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
    } catch {
      // Corrupt storage — fall back to centered.
    }
    return null;
  });
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origLeft: number; origTop: number } | null>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // --- Dragging ----------------------------------------------------------
  // Drag starts on the title bar (mousedown). The document listeners are
  // managed by the effect below (keyed on `dragging`), so React tears them
  // down even if the component unmounts mid-drag. The handlers themselves are
  // stable (refs + setState only), so add/remove always target the same
  // function reference.
  const startDrag = (e: React.MouseEvent) => {
    // Buttons inside the title bar (minimize/close) must not start a drag.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Anchor at the ACTUALLY rendered position (rect.left/top), not the stored
    // dragPos: the render clamps an out-of-viewport position back into view
    // (e.g. after the window shrank), so anchoring at the raw stored value
    // would make the dialog jump the moment the user grabs it.
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
    };
    setDragging(true);
  };

  const onDragMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // Small movement threshold: a plain click on the title bar is not a drag.
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    const rect = dialogRef.current?.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - (rect?.width ?? 400) - 8);
    const maxY = Math.max(8, window.innerHeight - (rect?.height ?? 300) - 8);
    const pos = {
      x: Math.max(8, Math.min(d.origLeft + dx, maxX)),
      y: Math.max(8, Math.min(d.origTop + dy, maxY)),
    };
    lastPosRef.current = pos;
    setDragPos(pos);
  };

  const onDragEnd = () => {
    setDragging(false);
    dragRef.current = null;
    const pos = lastPosRef.current;
    if (pos) {
      try {
        localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos));
      } catch {
        // Storage unavailable — position just won't persist.
      }
    }
  };

  useEffect(() => {
    if (!dragging) return;
    // App loses focus mid-drag (Alt-Tab): end the drag so the dialog can't
    // follow the mouse while no button is held.
    const onBlur = () => setDragging(false);
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
      window.removeEventListener("blur", onBlur);
    };
  }, [dragging]);

  // Double-click the title bar to reset to centered.
  const centerAgain = () => {
    setDragPos(null);
    try {
      localStorage.removeItem(POS_STORAGE_KEY);
    } catch {
      // Ignore.
    }
  };
  const [answered, setAnswered] = useState<Record<number, boolean>>({});
  const [focus, setFocus] = useState<Record<number, number>>({});
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [customMode, setCustomMode] = useState<Record<number, boolean>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});

  const isMulti = (i: number) => questions[i]?.multiSelect === true;
  const focusOf = (i: number) => focus[i] ?? 0;
  const customOf = (i: number) => customText[i] ?? "";
  const inCustom = (i: number) => customMode[i] === true;

  const markAnswered = (i: number) => setAnswered((a) => ({ ...a, [i]: true }));
  const goto = (t: number) => {
    if (!submitting) setTab(Math.max(0, Math.min(submitTab, t)));
  };
  const prev = () => goto(tab - 1);
  const next = () => goto(tab + 1);

  const pickOption = (i: number, idx: number) => {
    if (submitting) return;
    setCustomMode((m) => ({ ...m, [i]: false }));
    if (isMulti(i)) {
      setSelected((s) => {
        const cur = s[i] ?? [];
        const has = cur.includes(idx);
        return { ...s, [i]: has ? cur.filter((x) => x !== idx) : [...cur, idx].sort((a, b) => a - b) };
      });
      markAnswered(i);
    } else {
      setFocus((f) => ({ ...f, [i]: idx }));
      markAnswered(i);
      // No auto-advance: stay on the question so the user can read the
      // side-by-side preview and confirm the choice, then move on with
      // 下一步 / a tab chip.
    }
  };

  const enterCustom = (i: number) => {
    if (submitting) return;
    // Toggle: clicking the row again (or Esc in the input, or picking an
    // option) leaves custom mode; the previously chosen option highlights
    // return, so no selection is lost.
    setCustomMode((m) => ({ ...m, [i]: !m[i] }));
  };

  const allAnswered = questions.every((_, i) => answered[i] === true);

  // Derive the final answers (single-select: option or custom; multi: custom
  // text wins over checkbox selection, mirroring the walker's semantics).
  const derived: Record<number, QAnswer> = {};
  for (let i = 0; i < questions.length; i++) {
    if (isMulti(i)) {
      derived[i] = customOf(i).trim()
        ? { kind: "custom", text: customOf(i).trim() }
        : { kind: "multi", selected: selected[i] ?? [] };
    } else {
      derived[i] = inCustom(i) ? { kind: "custom", text: customOf(i).trim() } : { kind: "option", index: focusOf(i) };
    }
  }

  const submit = () => {
    if (allAnswered && !submitting) onSubmit(derived);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A hidden tab's questionnaire must never capture keys from the visible
      // tab (Esc there would silently cancel this walker).
      if (!active || submitting) return;
      // While typing (incl. IME composition) leave arrows/Esc to the input:
      // arrow keys move the caret / composition cursor, Esc cancels composition.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.isComposing) return;
      // Minimized: the overlay is gone and the transcript is interactive again,
      // but the questionnaire itself is invisible — only Esc (cancel) may reach
      // it. Enter/arrows would secretly submit or navigate a dialog the user
      // cannot see (questionnaireKeyAction enforces this).
      const action = questionnaireKeyAction(e.key, { minimized, tab, submitTab, allAnswered });
      if (action === "cancel") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (action === "prev") {
        e.preventDefault();
        prev();
      } else if (action === "next") {
        e.preventDefault();
        next();
      } else if (action === "submit") {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const q = tab < submitTab ? questions[tab]! : null;
  const previewQ = q && !isMulti(tab) && q.options.some((o) => o.preview && o.preview.length > 0) ? q : null;
  // Preview follows the clicked option; nothing is focused while in custom
  // mode (the user is writing their own answer, no option preview applies).
  const previewIdx = previewQ && !inCustom(tab) ? (focus[tab] ?? -1) : -1;
  const previewOpt =
    previewQ && previewIdx >= 0 && previewIdx < previewQ.options.length ? previewQ.options[previewIdx] : undefined;

  const dialogStyle = dragPos
    ? {
        left: Math.min(dragPos.x, Math.max(8, window.innerWidth - 80)),
        top: Math.min(dragPos.y, Math.max(8, window.innerHeight - 80)),
      }
    : undefined;

  // Minimized: a single pill at the bottom of the chat view. No overlay, so
  // the transcript is fully readable and scrollable; answers are kept and
  // clicking the pill restores the full dialog. Esc still cancels (the
  // keydown handler stays mounted). Mirrors the TUI's Ctrl+] collapse.
  if (minimized) {
    return (
      <div
        className="qq-collapsed-bar"
        role="button"
        tabIndex={0}
        title="点击恢复问卷"
        onClick={() => setMinimized(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setMinimized(false);
          }
        }}
      >
        <span>问卷已收起 — 点击恢复</span>
        <span className="qq-collapsed-actions">Esc 取消</span>
      </div>
    );
  }

  return (
    <div className="dialog-overlay ui-dialog-overlay">
      <div
        ref={dialogRef}
        className={`dialog ui-dialog qq-dialog${dragPos ? " positioned" : ""}${dragging ? " dragging" : ""}`}
        style={dialogStyle}
      >
        <div
          className="dialog-title qq-title-bar"
          onMouseDown={startDrag}
          onDoubleClick={centerAgain}
          title="拖动移动 · 双击恢复居中"
        >
          <span>{tab < submitTab ? `问题 ${tab + 1}/${submitTab}` : "确认提交"}</span>
          {q?.multiSelect && <span className="qq-multi-badge">可多选</span>}
          <span className="qq-title-spacer" />
          <button className="qq-icon-btn" title="最小化（保留答案）" disabled={submitting} onClick={() => setMinimized(true)}>
            ─
          </button>
          <button className="qq-icon-btn" title="取消（Esc）" disabled={submitting} onClick={onCancel}>
            ✕
          </button>
        </div>

        {/* Tab bar — click a tab to go back to any earlier question. */}
        <div className="qq-tabs">
          {questions.map((qq, i) => (
            <button
              key={i}
              className={`qq-tab${tab === i ? " active" : ""}${answered[i] ? " answered" : ""}`}
              onClick={() => goto(i)}
            >
              {answered[i] ? "✓ " : ""}
              {qq.header || `Q${i + 1}`}
            </button>
          ))}
          <button
            className={`qq-tab qq-tab-submit${tab === submitTab ? " active" : ""}${allAnswered ? " answered" : ""}`}
            onClick={() => goto(submitTab)}
          >
            {allAnswered ? "✓ " : ""}提交
          </button>
        </div>

        <div className="dialog-body">
          {q && <div className="qq-question">{q.question}</div>}
          {q && (
            <div className={`qq-layout${previewQ ? " with-preview" : ""}`}>
              <div className="qq-options">
                {q.options.map((opt, idx) => {
                  // Single-select: exactly one highlight, and none until the
                  // user actually picks (no invisible default). Custom mode
                  // clears every option highlight — only the "Type something."
                  // row is blue then. Multi keeps its checkbox state so leaving
                  // custom mode restores it.
                  const sel =
                    !inCustom(tab) &&
                    (isMulti(tab) ? (selected[tab] ?? []).includes(idx) : focus[tab] === idx);
                  return (
                    <div
                      key={idx}
                      className={`qq-option${sel ? " selected" : ""}`}
                      onClick={() => pickOption(tab, idx)}
                    >
                      <input type={isMulti(tab) ? "checkbox" : "radio"} checked={sel} readOnly tabIndex={-1} />
                      <div className="qq-option-body">
                        <div className="qq-option-label">{opt.label}</div>
                        {opt.description && <div className="qq-option-desc">{opt.description}</div>}
                      </div>
                    </div>
                  );
                })}
                {/* "Type something." custom-answer row */}
                <div
                  className={`qq-option qq-option-custom${inCustom(tab) ? " selected" : ""}`}
                  onClick={() => enterCustom(tab)}
                >
                  <input type={isMulti(tab) ? "checkbox" : "radio"} checked={inCustom(tab)} readOnly tabIndex={-1} />
                  <div className="qq-option-body">
                    <div className="qq-option-label">{sentinelLabel || DEFAULT_SENTINEL_LABEL}</div>
                    {inCustom(tab) && (
                      <input
                        className="dialog-input qq-custom-input"
                        autoFocus
                        value={customOf(tab)}
                        onChange={(e) => {
                          setCustomText((m) => ({ ...m, [tab]: e.target.value }));
                          if (e.target.value.trim()) markAnswered(tab);
                        }}
                        placeholder="输入自定义答案…"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          // TUI parity: Esc in the custom input returns to the options.
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setCustomMode((m) => ({ ...m, [tab]: false }));
                          }
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
              {previewQ && (
                <div className="qq-preview-pane">
                  <div className="qq-preview-title">预览{previewOpt ? ` — ${previewOpt.label}` : ""}</div>
                  <pre className="qq-preview-body">{previewOpt?.preview ?? "（无预览）"}</pre>
                </div>
              )}
            </div>
          )}

          {tab === submitTab && (
            <div className="qq-submit">
              {questions.map((qq, i) => {
                const a = derived[i]!;
                let summary: string;
                if (!answered[i]) summary = "未回答";
                else if (a.kind === "option") summary = qq.options[a.index]?.label ?? "";
                else if (a.kind === "multi")
                  summary = a.selected.length ? a.selected.map((x) => qq.options[x]?.label ?? "").join("、") : "（未选择）";
                else summary = a.text || "（空白）";
                return (
                  <div key={i} className={`qq-summary-row${answered[i] ? "" : " unanswered"}`}>
                    <span className="qq-summary-q">{qq.header || `Q${i + 1}`}</span>
                    <span className="qq-summary-a">{summary}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="qq-footer">
          <span className="qq-hint">
            {submitting
              ? "正在提交…"
              : tab === submitTab
                ? "Enter 提交 • Esc 取消"
                : "← 上一步 / 下一步 → • Esc 取消"}
          </span>
          <div className="qq-footer-nav">
            {tab === submitTab ? (
              <>
                <button className="btn" onClick={prev} disabled={submitting}>
                  ← 返回
                </button>
                <button className="btn btn-primary" onClick={submit} disabled={!allAnswered || submitting}>
                  提交
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={prev} disabled={submitting || tab === 0}>
                  ← 上一步
                </button>
                <button className="btn" onClick={next} disabled={submitting}>
                  下一步 →
                </button>
              </>
            )}
            <button className="btn" onClick={onCancel} disabled={submitting}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
