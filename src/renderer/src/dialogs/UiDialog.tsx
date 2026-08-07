/**
 * Native dialog for pi's extension UI sub-protocol (select/confirm/input/
 * editor). Rendered per-tab inside ChatPane; answers flow back through
 * window.api.rpcUiResponse. Fire-and-forget methods (notify, setStatus,
 * setWidget, setTitle, set_editor_text) are handled by the caller.
 */
import { useEffect, useRef, useState } from "react";
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

export function UiDialog({ tabId, req, onClose }: { tabId: string; req: UiRequest; onClose: () => void }) {
  const [text, setText] = useState(req.prefill ?? "");
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

  return (
    <div className="dialog-overlay" onClick={cancel}>
      <div className="dialog ui-dialog" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          {req.method === "select" && (
            <div className="ui-select-list">
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
          {req.method === "confirm" && (
            <div className="ui-confirm-msg">{req.message ?? title}</div>
          )}
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
        <div className="ui-dialog-actions">
          <button className="btn" onClick={cancel}>
            取消
          </button>
          {req.method === "select" && req.options?.length ? (
            <button
              className="btn btn-primary"
              onClick={() => respond({ value: req.options![selected] })}
            >
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
