/**
 * Native dialog for pi's extension UI sub-protocol (select/confirm/input/
 * editor). Rendered per-tab inside ChatPane; answers flow back through
 * window.api.rpcUiResponse. Fire-and-forget methods (notify, setStatus,
 * setWidget, setTitle, set_editor_text) are handled by the caller.
 */
import { useEffect, useRef, useState } from "react";
import { splitConfirmMessage } from "../../../shared/confirm-detail";
import { useUiStore } from "../stores/uiStore";

export interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  prefill?: string;
  text?: string;
  notifyType?: string;
  [key: string]: unknown;
}

/**
 * A confirmation dialog has to answer "AI 想做什么？" in one plain sentence before
 * it shows the raw material. The extension sends a plain sentence, then
 *   `详情（供核对）:` and the raw command/diff on the following lines
 * (see src/shared/confirm-detail.ts); the raw half goes into a monospace block so it
 * is verifiable without being the first thing the user has to parse. A confirm
 * from anywhere else has no marker and renders exactly as before.
 */
function ConfirmMessage({ req, title }: { req: UiRequest; title: string }) {
  const { headline, detail } = splitConfirmMessage(req.message ?? title);
  // 用户反馈：「用户不需要知道你执行什么命令，只需要知道你要干什么」。So the plain
  // sentence IS the dialog — big, centred, first. The exact command/diff stays one
  // click away, for the times you DO want to verify before allowing.
  const [showDetail, setShowDetail] = useState(false);
  const structured = detail !== undefined || req.message === undefined;
  /**
   * The headline is now a small block: 「AI 说：…」 (the model's own stated purpose)
   * + what/where + 「· 要点」 bullets. 用户反馈：「只有写什么、覆盖什么，然后就是一堆代码…根本
   * 不知道要授权来做什么」 — so 目的 first, 要点 next, code last (and collapsed).
   */
  const lines = (headline || title).split("\n").map((l) => l.trim()).filter(Boolean);
  const purpose = lines.filter((l) => l.startsWith("AI 说："));
  const heading = lines.filter((l) => !l.startsWith("AI 说：") && !l.startsWith("· "));
  const bullets = lines.filter((l) => l.startsWith("· ")).map((l) => l.slice(2));
  return (
    <>
      {structured ? (
        <div className="ui-confirm-msg">
          {purpose.map((p, i) => (
            <div key={`p${i}`} className="ui-confirm-purpose-line">{p}</div>
          ))}
          {heading.map((h, i) => (
            <div key={`h${i}`} className="ui-confirm-head">{h}</div>
          ))}
          {bullets.length > 0 ? (
            <ul className="ui-confirm-bullets">
              {bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="ui-confirm-msg">{headline || title}</div>
      )}
      {detail ? (
        showDetail ? (
          <>
            <pre className="ui-confirm-detail">{detail}</pre>
            <button className="link-btn ui-confirm-toggle" onClick={() => setShowDetail(false)}>
              ▾ 收起具体内容
            </button>
          </>
        ) : (
          <button className="link-btn ui-confirm-toggle" onClick={() => setShowDetail(true)}>
            ▸ 查看具体内容
          </button>
        )
      ) : null}
      <div className="ui-confirm-hint">允许 → AI 继续做；不允许 → 这次不做，它会换个办法。</div>
    </>
  );
}

export function UiDialog({ tabId, req, onClose }: { tabId: string; req: UiRequest; onClose: () => void }) {
  const [text, setText] = useState(req.prefill ?? "");
  /**
   * 收起 (minimize): pi's dialogs are modal, and a long plan/confirm question can
   * cover the very conversation the user needs to read before answering. The
   * request stays pending — the body is just hidden and the overlay stops
   * swallowing clicks, so the app behind is usable again.
   */
  const [minimized, setMinimized] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (req.method === "input") inputRef.current?.focus();
  }, [req.method]);

  const respond = (payload: Record<string, unknown>) => {
    void window.api.rpcUiResponse(tabId, { id: req.id, ...payload });
    onClose();
  };
  const cancel = () => respond({ cancelled: true });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.stopPropagation();
      if (req.method === "select" && req.options?.length) {
        respond({ value: req.options[selected] });
      } else if (req.method === "input") {
        respond({ value: text });
      }
    }
  };

  const title = req.title || "pi";
  // A structured confirm is OUR OWN (the extension marks it, see
  // shared/confirm-detail.ts): it gets the purpose-first layout and 允许/不允许
  // wording. Anything else keeps 确定/取消 — "允许" would be nonsense for e.g.
  // "Continue with the summarized branch?".
  const structuredConfirm =
    req.method === "confirm" && splitConfirmMessage(req.message ?? "").detail !== undefined;

  return (
    <div className={`dialog-overlay ui-dialog-overlay${minimized ? " minimized" : ""}`} onClick={cancel}>
      <div
        className={`dialog ui-dialog${minimized ? " minimized" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-title">
          <span className="dialog-title-text">{title}</span>
          <button
            className="dialog-min-btn"
            onClick={() => setMinimized((v) => !v)}
            title={minimized ? "展开对话框" : "收起对话框，先看下面的上下文（问题仍然在等你回答）"}
            aria-label={minimized ? "展开对话框" : "收起对话框"}
          >
            {minimized ? "▢" : "—"}
          </button>
        </div>
        <div className={`dialog-body${structuredConfirm ? " ui-dialog-body-confirm" : ""}`} hidden={minimized}>
          {req.method === "select" && (
            <div className="ui-select-list ui-select-list-lg">
              {(req.options ?? []).map((opt, i) => (
                <div
                  key={i}
                  className={`ui-select-item${i === selected ? " selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => respond({ value: opt })}
                >
                  {opt}
                </div>
              ))}
              {!req.options?.length && <div className="ui-select-empty">（无选项）</div>}
            </div>
          )}
          {req.method === "confirm" && <ConfirmMessage req={req} title={title} />}
          {req.method === "input" && (
            <input
              ref={inputRef}
              className="dialog-input ui-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入内容…"
            />
          )}
          {req.method === "editor" && (
            <textarea
              className="dialog-input ui-editor"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入内容…"
              rows={8}
              spellCheck={false}
            />
          )}
        </div>
        {/* 允许 on the LEFT, 不允许 on the right — the affirmative first, which is
            what the user reads for ("我同意继续做这件事"). */}
        <div className={`ui-dialog-actions${structuredConfirm ? " ui-dialog-actions-confirm" : ""}`}>
          {structuredConfirm ? (
            <>
              <button className="btn btn-primary btn-lg" onClick={() => respond({ confirmed: true })}>
                允许
              </button>
              <button className="btn btn-lg" onClick={cancel}>
                不允许
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={cancel}>
                取消
              </button>
              {req.method === "select" && req.options?.length ? (
                <button className="btn btn-primary" onClick={() => respond({ value: req.options![selected] })}>
                  选择
                </button>
              ) : req.method === "confirm" ? (
                <button className="btn btn-primary" onClick={() => respond({ confirmed: true })}>
                  确定
                </button>
              ) : req.method === "input" || req.method === "editor" ? (
                <button className="btn btn-primary" onClick={() => respond({ value: text })}>
                  确定
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Handle fire-and-forget extension UI methods. Returns true if consumed. */
export function handleFireAndForget(req: UiRequest, onSetEditorText?: (text: string) => void): boolean {
  if (req.method === "notify") {
    const type = req.notifyType === "error" ? "err" : "ok";
    useUiStore.getState().showToast(String(req.message ?? ""), type);
    return true;
  }
  if (req.method === "set_editor_text" && typeof req.text === "string") {
    onSetEditorText?.(req.text);
    return true;
  }
  if (req.method === "setStatus" || req.method === "setWidget" || req.method === "setTitle" || req.method === "set_editor_text") {
    return true; // M2: displayed by chat UI in later milestones
  }
  return false;
}
