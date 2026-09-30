/**
 * FailureCenter — the persistent, actionable record of what went wrong.
 *
 * A 3s toast cannot carry a failure: by the time the user looks, it is gone,
 * and it never said what to do. This renders the newest failure as a bar that
 * stays until it is dismissed or retried, with the full list (title, technical
 * cause, advice, target, repeat count) one click away — and a "复制全部" so the
 * user can hand a maintainer something better than "it broke".
 */
import { useState } from "react";
import { useFailureStore, type FailureRecord } from "../stores/failureStore";
import { useOverlayDismiss } from "./overlay-dismiss";

function copyableLine(f: FailureRecord): string {
  const when = new Date(f.at).toISOString();
  const where = f.target ? ` [${[f.target.host, f.target.path].filter(Boolean).join(":")}]` : "";
  const count = f.count > 1 ? ` (x${f.count})` : "";
  return `${when} ${f.code}${count} ${f.title}${where} — ${f.cause ?? ""}`;
}

export function FailureCenter() {
  const failures = useFailureStore((s) => s.failures);
  const [open, setOpen] = useState(false);
  // Backdrop dismissal needs a press AND a release on the backdrop itself, else a
  // text selection dragged past the dialog edge closes it (overlay-dismiss.ts).
  const overlayDismiss = useOverlayDismiss(() => setOpen(false));
  const newest = failures[0];
  if (!newest) return null;

  const dismiss = () => useFailureStore.getState().dismiss(newest.id);
  const retry = newest.retry;

  return (
    <>
      <div className="failure-bar">
        <div className="failure-main">
          <div className="failure-title">
            {newest.title}
            {newest.count > 1 ? `（${newest.count} 次）` : ""}
          </div>
          {newest.cause && <div className="failure-cause">{newest.cause}</div>}
          {newest.hint && <div className="failure-hint">{newest.hint}</div>}
        </div>
        <div className="failure-actions">
          {retry && (
            <button
              className="btn"
              onClick={() => {
                dismiss();
                retry();
              }}
            >
              重试
            </button>
          )}
          {failures.length > 1 && (
            <button className="btn" onClick={() => setOpen(true)}>
              全部 {failures.length}
            </button>
          )}
          <button className="failure-dismiss" title="忽略这条" onClick={dismiss}>
            ×
          </button>
        </div>
      </div>

      {open && (
        <div className="dialog-overlay" {...overlayDismiss}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 640 }}>
            <div className="dialog-title">最近的失败（{failures.length}）</div>
            <div className="dialog-body failure-list">
              {failures.map((f) => (
                <div key={f.id} className="failure-row">
                  <div className="failure-row-head">
                    <span className="failure-code">{f.code}</span>
                    <span className="failure-row-title">
                      {f.title}
                      {f.count > 1 ? `（${f.count} 次）` : ""}
                    </span>
                    <span className="failure-time">{new Date(f.at).toLocaleTimeString()}</span>
                  </div>
                  {f.cause && <div className="failure-cause">{f.cause}</div>}
                  {f.hint && <div className="failure-hint">{f.hint}</div>}
                  {f.target && (
                    <div className="failure-target">
                      {[f.target.host, f.target.path].filter(Boolean).join(":")}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="dialog-actions">
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(failures.map(copyableLine).join("\n"))
                    .catch(() => undefined);
                }}
              >
                复制全部
              </button>
              <button className="btn" onClick={() => useFailureStore.getState().clearAll()}>
                清空
              </button>
              <button className="btn btn-primary" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
