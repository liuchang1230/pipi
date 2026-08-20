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
    setCustomMode((m) => ({ ...m, [i]: true }));
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
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "Enter" && tab === submitTab && allAnswered) {
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
  const previewIdx = previewQ ? focusOf(tab) : -1;
  const previewOpt =
    previewQ && previewIdx >= 0 && previewIdx < previewQ.options.length ? previewQ.options[previewIdx] : undefined;

  return (
    <div className="dialog-overlay ui-dialog-overlay">
      <div className="dialog ui-dialog qq-dialog">
        <div className="dialog-title">
          {tab < submitTab ? `问题 ${tab + 1}/${submitTab}` : "确认提交"}
          {q?.multiSelect && <span className="qq-multi-badge">可多选</span>}
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
                  const sel = isMulti(tab) ? (selected[tab] ?? []).includes(idx) : focusOf(tab) === idx;
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
