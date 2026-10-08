/**
 * What the transcript area shows while there is nothing to read yet.
 *
 * Why this is a pure module and not two `&&` conditions in the render: the
 * decision has FIVE inputs (boot stage, boot deadline, history arrival, the
 * download task's phase, whether anything is on screen) and the bug it was
 * extracted from was exactly a wrong combination of two of them — the
 * placeholder was gated on `booted` alone, so the moment pi reported ready
 * (`state_ready`, ~2s on a warm link) the "正在启动 Pi…" line vanished while the
 * multi-MB transcript was still crossing SFTP/SSH (measured 17–45s on a slow
 * link) and the area looked blank — "卡住了？". Every branch is now decided
 * here and unit-tested (chat-transcript-wait.test.ts).
 */
import type { AppError } from "../../../shared/outcome";
import type { TaskPhase } from "../stores/tasksStore";

/**
 * The transcript download is a TASK, not a flag (invariants #2): a boolean can
 * be forgotten in the off position, and `historyLoaded` — false from the mount
 * until the payload lands — is exactly the state that used to be invisible.
 *
 * T1 is the honesty threshold, not a suspicion: at 15s the line starts saying
 * how long the user has been waiting (a big remote session legitimately takes
 * that long). T2 sits ABOVE the request's own budget (60s file attempt + 120s
 * RPC), so a healthy-but-slow download is never painted as a failure; the
 * terminal state arrives from the request's own settle when it does give up.
 */
export const HISTORY_TASK_STALL_MS = 15_000;
export const HISTORY_TASK_FAIL_MS = 200_000;
export const HISTORY_TASK_POLICY = { stallMs: HISTORY_TASK_STALL_MS, failMs: HISTORY_TASK_FAIL_MS };

/** One label per tab: the task registry is global, the wait is per chat. */
export const HISTORY_TASK_LABEL = "正在读取会话历史";
export function historyTaskKey(tabId: string): string {
  return `chat:history:${tabId}`;
}

/** The empty-session hint. `chat-placeholder` copy for the one state where the
 *  absence of content is the truth rather than a wait. */
export const EMPTY_TRANSCRIPT_HINT = "输入问题开始对话（鼠标可直接点击、选中、编辑输入内容）";

export interface TranscriptWaitInput {
  /** pi answered `state_ready` (or the SDK answered get_state). */
  booted: boolean;
  /** Boot progress from the backend: connecting → starting → ready. */
  bootStage?: "connecting" | "starting" | "ready";
  /** The 30s boot deadline tripped (pi missing / auth hang / dead link). */
  bootTimedOut: boolean;
  /** The backend process is gone — the exit bar owns that explanation. */
  exited: boolean;
  /** Messages already rendered. Any content on screen wins over a wait line. */
  messageCount: number;
  /** A transcript snapshot has been applied at least once. */
  historyLoaded: boolean;
  /** Phase of this tab's transcript task (`undefined` before the first request). */
  historyPhase?: TaskPhase;
  /** When the current download attempt started (task `startedAt`). */
  historyStartedAt?: number;
  /** The task's terminal error, when it has one. */
  historyError?: AppError;
  /** Why the download is slow, from the task (`detail`). */
  historyDetail?: string;
}

export type TranscriptWait =
  /** Content (or the exit bar / a banner) already explains the state. */
  | { kind: "none" }
  /** pi is ready, the transcript is loaded, and the session is empty. */
  | { kind: "empty"; text: string }
  | { kind: "boot-connecting"; text: string }
  | { kind: "boot-starting"; text: string }
  | { kind: "boot-timeout"; text: string }
  /** pi is up, the transcript is still downloading. `retry` once T1 has passed. */
  | { kind: "history"; text: string; retry: boolean }
  /** The download gave up: terminal, with a retry that re-requests over RPC. */
  | { kind: "history-failed"; text: string; detail?: string; hint?: string; retry: true };

/** `formatSeconds`-style elapsed, bounded to whole seconds. */
function elapsedSeconds(startedAt: number | undefined, now: number): number {
  if (startedAt === undefined) return 0;
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

export function deriveTranscriptWait(input: TranscriptWaitInput, now: number = Date.now()): TranscriptWait {
  // 1. Anything already rendered outranks a wait line: never cover content
  //    (a tab switch while the live turn streams, or a refreshed snapshot).
  if (input.messageCount > 0) return { kind: "none" };
  // 2. pi is gone: the exit bar below the timeline says why, and a retry here
  //    would be a lie (the process cannot be revived — only resumed).
  if (input.exited) return { kind: "none" };
  // 3. Still booting.
  if (!input.booted) {
    if (input.bootTimedOut) {
      return {
        kind: "boot-timeout",
        text: "pi 启动超时（远程服务器可能未安装 pi，或连接失败）。可切换到终端视图排查。",
      };
    }
    return input.bootStage === "connecting"
      ? { kind: "boot-connecting", text: "正在连接远程 Pi…" }
      : { kind: "boot-starting", text: "正在启动 Pi…" };
  }
  // 4. pi is ready but the transcript has not landed. This is the window the
  //    placeholder used to fall into: `booted` flips when the process answers
  //    `state_ready` (~2s), while the transcript crosses a SEPARATE, far slower
  //    path (file-first over SFTP/SSH, 17–45s measured on a slow link). Gating
  //    the line on `booted` alone therefore dropped it onto a blank area — and
  //    the empty-session hint below made that area look like an opened session
  //    with nothing in it. `historyLoaded` is the signal that says the session
  //    has actually been read.
  if (!input.historyLoaded) {
    if (input.historyPhase === "error") {
      // Invariant #8: a failure carries a human title, the technical cause and
      // the advice — the task registry already built all three.
      return {
        kind: "history-failed",
        text: input.historyError?.title ?? `${HISTORY_TASK_LABEL}失败`,
        detail: input.historyError?.cause ?? input.historyDetail,
        hint: input.historyError?.hint,
        retry: true,
      };
    }
    const waited = elapsedSeconds(input.historyStartedAt, now);
    // T1 convention (tasksStore / LoadState): plain label while normal work is
    // plausible, elapsed time + a retry once the wait is worth mentioning.
    const stalled = input.historyPhase === "stalled" || waited * 1000 >= HISTORY_TASK_STALL_MS;
    return {
      kind: "history",
      text: stalled
        ? `${HISTORY_TASK_LABEL}…（已等待 ${waited}s${input.historyDetail ? ` · ${input.historyDetail}` : ""}）`
        : `${HISTORY_TASK_LABEL}…`,
      retry: stalled,
    };
  }
  // 5. pi is ready and the transcript really is empty.
  return { kind: "empty", text: EMPTY_TRANSCRIPT_HINT };
}
