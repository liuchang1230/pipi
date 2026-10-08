// The transcript area's decision table, plus the regression that produced it:
// opening a session (especially remote) showed 「正在启动 Pi…」, then pi answered
// `state_ready` and the line DISAPPEARED while the multi-MB transcript was
// still downloading (17–45s on a slow link) — the user read the blank area as
// "卡住了".
//
// The store-driven case below runs the REAL sequence (mount → markHistoryLoading
// → state_ready → initMessages) through the real stores: it goes red on the
// old rule (placeholder gated on `booted` alone) and green once the wait is
// gated on the transcript instead.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toAppError } from "../../../../shared/outcome";
import { useChatStore } from "../../stores/chatStore";
import { stopTaskTimerForTests, useTasksStore } from "../../stores/tasksStore";
import {
  EMPTY_TRANSCRIPT_HINT,
  HISTORY_TASK_LABEL,
  HISTORY_TASK_POLICY,
  deriveTranscriptWait,
  historyTaskKey,
  type TranscriptWaitInput,
} from "../chat-transcript-wait";

const T = "tab-transcript-wait";

/** A fully "pi is ready, nothing rendered yet" input; override per case. */
function input(overrides: Partial<TranscriptWaitInput> = {}): TranscriptWaitInput {
  return {
    booted: true,
    bootStage: "ready",
    bootTimedOut: false,
    exited: false,
    messageCount: 0,
    historyLoaded: true,
    historyPhase: "done",
    historyStartedAt: Date.now(),
    ...overrides,
  };
}

describe("deriveTranscriptWait", () => {
  it("names the boot stage before pi is ready", () => {
    expect(deriveTranscriptWait(input({ booted: false, bootStage: "connecting", historyLoaded: false })).kind).toBe("boot-connecting");
    expect(deriveTranscriptWait(input({ booted: false, bootStage: "starting", historyLoaded: false })).kind).toBe("boot-starting");
    expect(deriveTranscriptWait(input({ booted: false, bootStage: "ready", historyLoaded: false })).kind).toBe("boot-starting");
  });

  it("turns the boot deadline into a terminal banner, not a forever spinner", () => {
    const wait = deriveTranscriptWait(input({ booted: false, bootTimedOut: true, historyLoaded: false }));
    expect(wait.kind).toBe("boot-timeout");
    if (wait.kind === "boot-timeout") expect(wait.text).toContain("启动超时");
  });

  it("keeps a loading line while the transcript is still downloading", () => {
    const wait = deriveTranscriptWait(input({ historyLoaded: false, historyPhase: "running" }));
    expect(wait.kind).toBe("history");
    if (wait.kind === "history") expect(wait.text).toContain(HISTORY_TASK_LABEL);
  });

  it("says how long it has been waiting once the wait is worth mentioning", () => {
    const startedAt = 1_000_000;
    const wait = deriveTranscriptWait(
      input({ historyLoaded: false, historyPhase: "stalled", historyStartedAt: startedAt }),
      startedAt + 21_000,
    );
    expect(wait.kind).toBe("history");
    if (wait.kind === "history") {
      expect(wait.text).toContain("已等待 21s");
      expect(wait.retry).toBe(true); // an impatient user is never trapped
    }
  });

  it("reports a given-up download as a terminal failure with the reason", () => {
    const wait = deriveTranscriptWait(
      input({
        historyLoaded: false,
        historyPhase: "error",
        historyError: toAppError(new Error("get_messages 无响应"), { title: `${HISTORY_TASK_LABEL}超时` }),
      }),
    );
    expect(wait.kind).toBe("history-failed");
    if (wait.kind === "history-failed") {
      expect(wait.text).toContain("超时");
      expect(wait.detail).toContain("get_messages 无响应");
      expect(wait.retry).toBe(true);
    }
  });

  it("never covers content that is already on screen", () => {
    expect(deriveTranscriptWait(input({ messageCount: 3, historyLoaded: false, historyPhase: "stalled" })).kind).toBe("none");
  });

  it("leaves the explanation to the exit bar once pi is gone", () => {
    expect(deriveTranscriptWait(input({ exited: true, historyLoaded: false, historyPhase: "running" })).kind).toBe("none");
  });

  it("only calls a session empty once the transcript has actually been read", () => {
    const wait = deriveTranscriptWait(input());
    expect(wait).toEqual({ kind: "empty", text: EMPTY_TRANSCRIPT_HINT });
  });
});

describe("opening a (remote) session: the loading line outlives the boot", () => {
  beforeEach(() => {
    useChatStore.getState().clear(T);
    useChatStore.getState().ensure(T);
    useTasksStore.setState({ tasks: {} });
  });
  afterEach(() => {
    stopTaskTimerForTests();
    useTasksStore.setState({ tasks: {} });
  });

  /** Read the decision straight out of the live stores. */
  function waitNow(now = Date.now()) {
    const st = useChatStore.getState().states[T]!;
    const task = useTasksStore.getState().tasks[historyTaskKey(T)];
    return deriveTranscriptWait(
      {
        booted: st.booted,
        bootStage: st.bootStage,
        bootTimedOut: false,
        exited: st.exited,
        messageCount: st.messages.length,
        historyLoaded: !!st.historyLoaded,
        historyPhase: task?.phase,
        historyStartedAt: task?.startedAt,
        historyError: task?.error,
      },
      now,
    );
  }

  it("stays on a transcript line when pi is ready but the history has not landed", () => {
    // Mount: the download is claimed (markHistoryLoading + the task) …
    useChatStore.getState().markHistoryLoading(T);
    useTasksStore.getState().begin(historyTaskKey(T), { label: HISTORY_TASK_LABEL, policy: HISTORY_TASK_POLICY });
    // … pi reports ready seconds later …
    useChatStore.getState().applyEvent(T, { type: "state_ready", model: { id: "m", name: "m", provider: "p" } });
    expect(useChatStore.getState().states[T]!.booted).toBe(true);

    // … and the transcript is still crossing the link. THE symptom: this used
    // to be the empty-session hint over a blank area.
    const wait = waitNow(Date.now() + 9_000);
    expect(wait.kind).toBe("history");
    expect(wait.kind === "history" && wait.text).not.toContain(EMPTY_TRANSCRIPT_HINT);
  });

  it("hands over to the transcript the moment it arrives", () => {
    useChatStore.getState().markHistoryLoading(T);
    useTasksStore.getState().begin(historyTaskKey(T), { label: HISTORY_TASK_LABEL, policy: HISTORY_TASK_POLICY });
    useChatStore.getState().applyEvent(T, { type: "state_ready", model: { id: "m" } });
    expect(waitNow().kind).toBe("history");

    useChatStore.getState().initMessages(T, [
      { id: "u1", role: "user", content: [{ type: "text", text: "昨天那个 bug" }] },
    ]);
    useTasksStore.getState().settle(historyTaskKey(T));
    expect(waitNow().kind).toBe("none");
  });

  it("says 输入问题开始对话 only for a transcript that really is empty", () => {
    useChatStore.getState().markHistoryLoading(T);
    useTasksStore.getState().begin(historyTaskKey(T), { label: HISTORY_TASK_LABEL, policy: HISTORY_TASK_POLICY });
    useChatStore.getState().applyEvent(T, { type: "state_ready", model: { id: "m" } });
    useChatStore.getState().initMessages(T, []);
    expect(waitNow()).toEqual({ kind: "empty", text: EMPTY_TRANSCRIPT_HINT });
  });
});
