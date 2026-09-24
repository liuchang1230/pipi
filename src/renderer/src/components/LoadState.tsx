/**
 * LoadState — the one way a pane renders "waiting".
 *
 * Rendering from a task (see stores/tasksStore.ts) instead of a hand-set
 * boolean means the four states a user can actually be in are always
 * distinguishable:
 *
 *   running  → 加载中…            (nothing to say yet)
 *   stalled  → 已等待 12s · 原因   + [重试]   (worth saying, still working)
 *   error    → 标题 / 原因 / 建议   + [重试]   (terminal, actionable)
 *   idle/done → empty 内容 or nothing
 *
 * The stalled state is the point: an "eternal spinner" is not only a hang, it is
 * a UI that cannot tell the user that it has been waiting, why, or what they can
 * do about it.
 */
import type { ReactNode } from "react";
import { useTask } from "../stores/tasksStore";

export interface LoadStateProps {
  /** Task key, e.g. "viewer:open" / "tree:load". */
  taskKey: string;
  /** Shown for the idle/done phase when there is nothing else to render. */
  empty?: ReactNode;
  /** Extra retry control when the task has no retry of its own. */
  onRetry?: () => void;
  className?: string;
}

export function LoadState({ taskKey, empty = null, onRetry, className }: LoadStateProps) {
  const task = useTask(taskKey);
  const base = className ? `${className} ` : "";
  const retry = onRetry ?? task?.retry;

  if (!task || task.phase === "idle" || task.phase === "done") return <>{empty}</>;

  if (task.phase === "running") {
    return (
      <div className={`${base}placeholder`.trim()}>
        {task.label}
      </div>
    );
  }

  if (task.phase === "stalled") {
    const waited = Math.round((Date.now() - task.startedAt) / 1000);
    return (
      <div className={`${base}placeholder load-stalled`.trim()}>
        <div>
          {task.label}（已等待 {waited}s{task.detail ? ` · ${task.detail}` : ""}）
        </div>
        {retry && (
          <button className="btn load-retry" onClick={() => retry()}>
            重试
          </button>
        )}
      </div>
    );
  }

  const error = task.error;
  return (
    <div className={`${base}placeholder load-error`.trim()}>
      <div className="load-error-title">{error?.title ?? `${task.label}失败`}</div>
      {error?.cause && <div className="load-error-cause">{error.cause}</div>}
      {error?.hint && <div className="load-error-hint">{error.hint}</div>}
      {retry && (
        <button className="btn load-retry" onClick={() => retry()}>
          重试
        </button>
      )}
    </div>
  );
}
