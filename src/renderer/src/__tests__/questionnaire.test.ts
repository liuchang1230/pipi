/**
 * Pure-function tests for the chat-view questionnaire (QuestionnaireDialog).
 * Covers the three helpers shared with ChatPane:
 *   - parseQuestionsFromArgs: args JSON → typed questions
 *   - walkerTitleStarts: recognizing / correlating the rpiv walker's dialogs
 *   - buildFlushSteps: emission order of the walker's dialogs for an answer set
 */
import { describe, it, expect } from "vitest";
import {
  buildFlushResponse,
  buildFlushSteps,
  extractSentinelLabel,
  parseQuestionsFromArgs,
  walkerTitleStarts,
  type QQuestion,
} from "../dialogs/QuestionnaireDialog";

const ARGS = JSON.stringify({
  questions: [
    {
      header: "范围",
      question: "这次改动涉及哪些范围？",
      options: [
        { label: "核心逻辑", description: "只改主流程" },
        { label: "全栈", description: "前后端一起", preview: "# mock\n```ts\nconst x = 1\n```" },
      ],
    },
    {
      question: "优先级如何？",
      options: [
        { label: "高", description: "今天做完" },
        { label: "低", description: "下周再说" },
      ],
    },
    {
      header: "多选",
      question: "选几个方案？",
      multiSelect: true,
      options: [
        { label: "A 方案", description: "第一条" },
        { label: "B 方案", description: "第二条" },
      ],
    },
  ],
});

describe("parseQuestionsFromArgs", () => {
  it("parses a full questionnaire with headers, previews and multiSelect", () => {
    const qs = parseQuestionsFromArgs(ARGS);
    expect(qs).not.toBeNull();
    expect(qs).toHaveLength(3);
    expect(qs![0]!.header).toBe("范围");
    expect(qs![0]!.multiSelect).toBe(false);
    expect(qs![0]!.options[1]!.preview).toContain("# mock");
    expect(qs![2]!.multiSelect).toBe(true);
  });

  it("returns null for empty / invalid args", () => {
    expect(parseQuestionsFromArgs("")).toBeNull();
    expect(parseQuestionsFromArgs("not json")).toBeNull();
    expect(parseQuestionsFromArgs(JSON.stringify({ questions: [] }))).toBeNull();
    expect(parseQuestionsFromArgs(JSON.stringify({ questions: [{ question: "", options: [] }] }))).toBeNull();
  });

  it("skips malformed questions but keeps valid ones", () => {
    const qs = parseQuestionsFromArgs(
      JSON.stringify({
        questions: [
          { question: "ok?", options: [{ label: "yes" }] },
          { question: "", options: [{ label: "x" }] },
          { question: "no options?", options: [] },
          { options: [{ label: "x" }] },
        ],
      }),
    );
    expect(qs).toHaveLength(1);
    expect(qs![0]!.question).toBe("ok?");
  });

  it("drops non-string headers", () => {
    const qs = parseQuestionsFromArgs(
      JSON.stringify({ questions: [{ header: 42, question: "ok?", options: [{ label: "yes" }] }] }),
    );
    expect(qs).toHaveLength(1);
    expect(qs![0]!.header).toBeUndefined();
  });
});

describe("walkerTitleStarts", () => {
  const q0 = parseQuestionsFromArgs(ARGS)![0]!;
  const q1 = parseQuestionsFromArgs(ARGS)![1]!;
  const q2 = parseQuestionsFromArgs(ARGS)![2]!;

  it("matches the walker's select title (header prefix)", () => {
    expect(walkerTitleStarts("[范围] 这次改动涉及哪些范围？", q0)).toBe(true);
  });

  it("matches the walker's select title with preview block appended", () => {
    expect(walkerTitleStarts("[范围] 这次改动涉及哪些范围？\n\n--- 2. 全栈 preview ---\n...", q0)).toBe(true);
  });

  it("matches the walker's multi-select input title (question + list)", () => {
    expect(walkerTitleStarts("[多选] 选几个方案？\n\n1. A 方案 — 第一条\n2. B 方案 — 第二条\n\nEnter the numbers…", q2)).toBe(true);
  });

  it("matches the walker's custom-answer follow-up input", () => {
    expect(walkerTitleStarts("[范围] 这次改动涉及哪些范围？\n\nType your answer:", q0)).toBe(true);
  });

  it("matches a question without a header", () => {
    expect(walkerTitleStarts("优先级如何？", q1)).toBe(true);
  });

  it("rejects unrelated titles and empty input", () => {
    expect(walkerTitleStarts("其他对话框", q0)).toBe(false);
    expect(walkerTitleStarts(undefined, q0)).toBe(false);
    // Same header but different question text must not match.
    expect(walkerTitleStarts("[范围] 另一个问题", q0)).toBe(false);
  });

  it("matches titles with special characters in header or question text", () => {
    const bracketQ: QQuestion = { header: "a]b", question: "选[x]哪个？", options: [{ label: "a" }] };
    expect(walkerTitleStarts("[a]b] 选[x]哪个？", bracketQ)).toBe(true);
    const emptyHeaderQ: QQuestion = { header: "", question: "嗯？", options: [{ label: "a" }] };
    expect(walkerTitleStarts("嗯？", emptyHeaderQ)).toBe(true);
    const multilineQ: QQuestion = { question: "第一行\n第二行", options: [{ label: "a" }] };
    expect(walkerTitleStarts("第一行\n第二行\n\nType your answer:", multilineQ)).toBe(true);
  });
});

describe("buildFlushSteps", () => {
  const qs = parseQuestionsFromArgs(ARGS)!;

  it("emits select steps for single-select questions and a custom follow-up", () => {
    const steps = buildFlushSteps(qs, {
      0: { kind: "option", index: 0 },
      1: { kind: "option", index: 1 },
      2: { kind: "multi", selected: [0] },
    });
    expect(steps).toEqual([
      { qi: 0, kind: "select" },
      { qi: 1, kind: "select" },
      { qi: 2, kind: "multi" },
    ]);
  });

  it("adds a custom follow-up input after a single-select custom answer", () => {
    const steps = buildFlushSteps(qs, {
      0: { kind: "custom", text: "我自己写" },
      1: { kind: "option", index: 0 },
      2: { kind: "multi", selected: [] },
    });
    expect(steps).toEqual([
      { qi: 0, kind: "select" },
      { qi: 0, kind: "custom" },
      { qi: 1, kind: "select" },
      { qi: 2, kind: "multi" },
    ]);
  });

  it("adds a custom follow-up input after the LAST question's custom answer", () => {
    const steps = buildFlushSteps(qs, {
      0: { kind: "option", index: 0 },
      1: { kind: "custom", text: "随意" },
      2: { kind: "multi", selected: [1] },
    });
    expect(steps).toEqual([
      { qi: 0, kind: "select" },
      { qi: 1, kind: "select" },
      { qi: 1, kind: "custom" },
      { qi: 2, kind: "multi" },
    ]);
  });

  it("skips unanswered questions (defensive: submit is gated on allAnswered)", () => {
    const steps = buildFlushSteps(qs, { 1: { kind: "option", index: 0 } });
    expect(steps).toEqual([
      { qi: 0, kind: "select" },
      { qi: 1, kind: "select" },
      { qi: 2, kind: "multi" },
    ]);
  });
});

// Keep the type import used in tests even if a branch drops it.
export type { QQuestion };

describe("buildFlushResponse", () => {
  const OPTIONS = ["1. 核心逻辑 — 只改主流程", "2. 全栈 — 前后端一起", "3. Type something."];

  it("returns the exact offered option line for an option answer", () => {
    expect(buildFlushResponse({ qi: 0, kind: "select" }, { kind: "option", index: 1 }, OPTIONS)).toEqual({
      value: OPTIONS[1],
    });
  });

  it("returns the sentinel line for a custom answer (walker then opens the follow-up input)", () => {
    expect(buildFlushResponse({ qi: 0, kind: "select" }, { kind: "custom", text: "自写" }, OPTIONS)).toEqual({
      value: OPTIONS[OPTIONS.length - 1],
    });
  });

  it("encodes multi-select as 1-based comma text, empty as empty commit", () => {
    expect(buildFlushResponse({ qi: 2, kind: "multi" }, { kind: "multi", selected: [0, 2] }, OPTIONS)).toEqual({
      value: "1,3",
    });
    expect(buildFlushResponse({ qi: 2, kind: "multi" }, { kind: "multi", selected: [] }, OPTIONS)).toEqual({ value: "" });
  });

  it("passes custom text through the multi input (walker treats non-index tokens as custom)", () => {
    expect(buildFlushResponse({ qi: 2, kind: "multi" }, { kind: "custom", text: "先都看看" }, OPTIONS)).toEqual({
      value: "先都看看",
    });
  });

  it("answers the custom follow-up input with the typed text", () => {
    expect(buildFlushResponse({ qi: 0, kind: "custom" }, { kind: "custom", text: "自写" }, OPTIONS)).toEqual({
      value: "自写",
    });
  });

  it("returns null when a select dialog carries no options (caller aborts)", () => {
    expect(buildFlushResponse({ qi: 0, kind: "select" }, { kind: "option", index: 0 }, [])).toBeNull();
  });
});

describe("extractSentinelLabel", () => {
  it("strips the leading index from the walker's last option line", () => {
    expect(extractSentinelLabel(["1. a", "2. 自定义输入…"])).toBe("自定义输入…");
  });
  it("falls back to the default when options are absent or malformed", () => {
    expect(extractSentinelLabel(undefined)).toBe("Type something.");
    expect(extractSentinelLabel([])).toBe("Type something.");
    expect(extractSentinelLabel(["no index"])).toBe("Type something.");
  });
});
