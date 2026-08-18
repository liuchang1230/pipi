/**
 * pi agent auto-install progress dialog. Main-driven: `pi-install:begin` opens
 * it, `pi-install:progress` updates the stage text, `pi-install:result` moves
 * it to done/error/cancelled. Self-contained (own state, no store traffic) —
 * App renders it unconditionally, it returns null when idle. The cancel button
 * asks the main process to kill the npm child.
 */
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "installing" | "done" | "error" | "cancelled" | "notice";

export function PiInstallDialog() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState("正在安装…");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startElapsed = () => {
    startedAtRef.current = Date.now();
    setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - (startedAtRef.current ?? Date.now())) / 1000));
    }, 1000);
  };
  const stopElapsed = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    const offBegin = window.api.piInstall.onBegin(() => {
      // A previous result's auto-close timer must not fire mid-install.
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setPhase("installing");
      setStage("正在安装…");
      setError(null);
      setCancelling(false);
      setNotice(null);
      startElapsed();
    });
    const offProgress = window.api.piInstall.onProgress((p) => {
      if (p.stage) setStage(p.stage);
    });
    const offResult = window.api.piInstall.onResult((r) => {
      stopElapsed();
      if (r.cancelled) {
        setPhase("cancelled");
      } else if (r.ok) {
        setPhase("done");
      } else {
        setPhase("error");
        setError(r.error ?? "未知错误");
      }
      // Success / cancelled: brief confirmation, then close.
      if (r.ok || r.cancelled) {
        closeTimerRef.current = setTimeout(() => setPhase("idle"), 1000);
      }
    });
    const offNotice = window.api.piInstall.onNotice((n) => {
      setNotice("未检测到全局 pi agent，已使用内置版本运行。");
      setPhase("notice");
    });
    return () => {
      offBegin();
      offProgress();
      offResult();
      offNotice();
      stopElapsed();
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "idle") return null;

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const close = () => setPhase("idle");
  const cancel = () => {
    setCancelling(true);
    void window.api.piInstall.cancel();
  };
  const installGlobal = () => {
    setPhase("installing");
    setNotice(null);
    void window.api.piInstall.run();
  };

  return (
    <div className="dialog-overlay" onClick={phase === "installing" ? undefined : close}>
      <div className="dialog pi-install-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">安装 pi agent</div>
        <div className="dialog-body">
          {phase === "notice" && (
            <>
              <div className="pi-install-result">{notice}</div>
              <div className="pi-install-hint">
                使用内置版本不影响 AI 终端功能；安装全局版后可在终端中直接使用 <code>pi</code> 命令。
              </div>
            </>
          )}
          {phase === "installing" && (
            <>
              <div className="pi-install-stage">
                {cancelling ? "正在取消…" : stage}
                <span className="pi-install-elapsed">{fmt(elapsed)}</span>
              </div>
              <div className="pi-install-bar">
                <div className="pi-install-bar-fill" />
              </div>
              <div className="pi-install-hint">首次安装约需 1-3 分钟，取决于网络。安装过程中请勿关闭应用。</div>
            </>
          )}
          {phase === "done" && (
            <div className="pi-install-result ok">✓ pi agent 已安装完成，现在可以使用 AI 终端。</div>
          )}
          {phase === "cancelled" && (
            <div className="pi-install-result">已取消安装。内置版本仍可正常使用。</div>
          )}
          {phase === "error" && (
            <div className="pi-install-error">
              <div className="pi-install-result err">✗ 自动安装 pi agent 失败。</div>
              <div className="pi-install-error-detail">{error}</div>
              <div className="pi-install-hint">
                可手动安装：<code>npm install -g --ignore-scripts @earendil-works/pi-coding-agent</code>
              </div>
            </div>
          )}
        </div>
        <div className="ui-dialog-actions">
          {phase === "notice" && (
            <>
              <button className="btn" onClick={close}>
                知道了
              </button>
              <button className="btn btn-primary" onClick={installGlobal}>
                安装全局版
              </button>
            </>
          )}
          {phase === "installing" && (
            <button className="btn" onClick={cancel} disabled={cancelling}>
              {cancelling ? "正在取消…" : "取消"}
            </button>
          )}
          {(phase === "done" || phase === "error" || phase === "cancelled") && (
            <button className="btn btn-primary" onClick={close}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
