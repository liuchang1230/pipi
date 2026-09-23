/**
 * ErrorBoundary — the last line of defence against the "white window".
 *
 * React unmounts the entire tree when a render throws and no boundary catches
 * it, which is exactly what a single malformed chat card (a tool call with
 * model-authored args) used to cause. The boundary keeps the shell alive,
 * reports the crash to the diagnostic log, and offers a way out.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: unknown;
}

/** Errors can be thrown as any value (string, number, object) — always render text. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    try {
      const where = (info.componentStack ?? "").split("\n").filter((l) => l.trim()).slice(0, 3).join(" | ");
      const stack = (error instanceof Error ? (error.stack ?? "") : "").split("\n").slice(0, 3).join(" | ");
      window.api.debug.log(`renderer-REACT-CRASH ${describeError(error)} | ${stack} |${where}`);
    } catch {
      /* preload missing (tests) — never rethrow from a crash handler */
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-panel">
          <div className="crash-title">界面渲染出错，已阻止白屏</div>
          <div className="crash-hint">
            某个会话或面板渲染失败，其他数据没有丢失。可先「重试渲染」，仍失败则重新加载窗口。
          </div>
          <pre className="crash-detail">{describeError(error)}</pre>
          <div className="crash-actions">
            <button className="crash-btn" onClick={() => window.location.reload()}>
              重新加载窗口
            </button>
            <button className="crash-btn crash-btn-ghost" onClick={() => this.setState({ error: null })}>
              重试渲染
            </button>
          </div>
        </div>
      </div>
    );
  }
}
