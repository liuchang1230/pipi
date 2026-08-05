// Small UI primitives for the file tree: right-click context menu + prompt/confirm dialogs.
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface CtxMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Positioned right-click menu. Closes on outside click / blur / right-click. */
export function FileContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CtxMenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const menuW = 176;
  const menuH = items.length * 33 + 8;
  const left = Math.max(4, Math.min(x, window.innerWidth - menuW - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - menuH - 4));

  return (
    <>
      <div
        className="ctx-menu-overlay"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="ctx-menu" role="menu" style={{ left, top, width: menuW }}>
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            className={`ctx-menu-item${item.danger ? " danger" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function PromptDialog({
  title,
  placeholder,
  initial = "",
  hint,
  confirmLabel = "确定",
  onConfirm,
  onCancel,
}: {
  title: string;
  placeholder?: string;
  initial?: string;
  hint?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = () => {
    const v = value.trim();
    if (v) onConfirm(v);
  };
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          <input
            ref={inputRef}
            className="dialog-input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
              else if (e.key === "Escape") onCancel();
            }}
          />
          {hint && <div className="dialog-hint">{hint}</div>}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!value.trim()} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  danger = false,
  confirmLabel = "确定",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="dialog-overlay"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{message}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel} autoFocus>
            取消
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
