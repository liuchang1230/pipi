// pipi-ask-user-question —— 结构化提问扩展。单测两层：
//   1. 纯函数层：问卷走查（假 ui）、参数归一、答案信封 —— 行为本身；
//   2. 跨边界契约层：本文件钉住走查发出的**确切字符串**（标题前缀、选项行、
//      哨兵行、后续输入标题）；渲染层那边的 questionnaire.test.ts 钉住
//      ChatPane 的匹配器接受同样的字面量。两侧任一单独漂移，一边先红。
//      （不直接 import QuestionnaireDialog.tsx —— main 的 tsc 工程不开 jsx。）
// 假件纪律：fake ui 只回答测试显式排队的答案；调用顺序/参数全部记录并断言。
import { describe, expect, it } from "vitest";
import pipiAskUserQuestion from "../extensions/pipi-ask-user-question";
import {
  alreadyProvidesAskUserQuestion,
  ASK_USER_QUESTION_SCHEMA,
  buildAnswerEnvelope,
  formatOptionLine,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  normalizeParams,
  parseIndex,
  questionTitlePrefix,
  RESERVED_LABELS,
  SENTINEL_LABEL,
  walkQuestionnaire,
  type AskAnswer,
  type AskParams,
  type AskQuestion,
  type DialogUi,
} from "../extensions/pipi-ask-user-question";
import { SHIPPED_EXTENSIONS } from "../extension-sync";

// --- 假件 -------------------------------------------------------------------

function fakeUi(script: Array<{ kind: "select" | "input"; reply: string | undefined }>): {
  ui: DialogUi;
  calls: Array<{ method: string; title: string; arg?: string | string[] }>;
} {
  const calls: Array<{ method: string; title: string; arg?: string | string[] }> = [];
  let i = 0;
  return {
    calls,
    ui: {
      async select(title, options) {
        calls.push({ method: "select", title, arg: options });
        const step = script[i++];
        return step?.kind === "select" ? (step.reply as string) : undefined;
      },
      async input(title, placeholder) {
        calls.push({ method: "input", title, arg: placeholder });
        const step = script[i++];
        return step?.kind === "input" ? (step.reply as string) : undefined;
      },
    },
  };
}

const Q_SINGLE: AskQuestion = {
  question: "Which library should we use for date formatting?",
  header: "Library",
  options: [
    { label: "date-fns", description: "functional, tree-shakeable" },
    { label: "luxon", description: "mutable, powerful parsing" },
  ],
};

const Q_MULTI: AskQuestion = {
  question: "Which features do you want to enable?",
  multiSelect: true,
  options: [
    { label: "search", description: "full text search" },
    { label: "export", description: "pdf export" },
    { label: "themes", description: "color themes" },
  ],
};

// --- 走查：单选 --------------------------------------------------------------

describe("walkQuestionnaire — single select", () => {
  it("picks an option by the full line the app returns (not a bare index)", async () => {
    const { ui, calls } = fakeUi([{ kind: "select", reply: "2. luxon — mutable, powerful parsing" }]);
    const result = await walkQuestionnaire(ui, [Q_SINGLE]);
    expect(result.cancelled).toBe(false);
    expect(result.answers[0]).toEqual({
      questionIndex: 0,
      question: Q_SINGLE.question,
      kind: "option",
      answer: "luxon",
    });
    // 标题以 [header] question 开头；选项行 N. label — description，哨兵在末尾。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("select");
    expect(calls[0]!.title.startsWith("[Library] Which library")).toBe(true);
    expect(calls[0]!.arg).toEqual(["1. date-fns — functional, tree-shakeable", "2. luxon — mutable, powerful parsing", `3. ${SENTINEL_LABEL}`]);
  });

  it("appends the sentinel row and follows it with a custom-answer input", async () => {
    const { ui, calls } = fakeUi([
      { kind: "select", reply: `3. ${SENTINEL_LABEL}` },
      { kind: "input", reply: "use Intl.DateTimeFormat" },
    ]);
    const result = await walkQuestionnaire(ui, [Q_SINGLE]);
    expect(result.cancelled).toBe(false);
    expect(result.answers[0]).toEqual({
      questionIndex: 0,
      question: Q_SINGLE.question,
      kind: "custom",
      answer: "use Intl.DateTimeFormat",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("input");
    expect(calls[1]!.title.startsWith("[Library] Which library")).toBe(true);
  });

  it("treats a dismissal as cancelling the whole questionnaire, keeping partial answers", async () => {
    const { ui } = fakeUi([{ kind: "select", reply: "1. date-fns — functional, tree-shakeable" }, { kind: "select", reply: undefined }]);
    const result = await walkQuestionnaire(ui, [Q_SINGLE, Q_MULTI]);
    expect(result.cancelled).toBe(true);
    expect(result.answers).toHaveLength(1);
    expect(buildAnswerEnvelope(result)).toBe("User declined to answer questions");
  });

  it("treats an off-list reply like a dismissal instead of inventing an answer", async () => {
    const { ui } = fakeUi([{ kind: "select", reply: "not an offered option" }]);
    const result = await walkQuestionnaire(ui, [Q_SINGLE]);
    expect(result).toEqual({ answers: [], cancelled: true });
  });

  it("folds previews into the select title (terminal view has no side-by-side pane)", async () => {
    const q: AskQuestion = {
      question: "Q?",
      options: [
        { label: "A", description: "a", preview: "mockup A" },
        { label: "B", description: "b" },
      ],
    };
    const { ui, calls } = fakeUi([{ kind: "select", reply: "1. A — a" }]);
    await walkQuestionnaire(ui, [q]);
    expect(calls[0]!.title).toContain("--- 1. A preview ---");
    expect(calls[0]!.title).toContain("mockup A");
  });
});

// --- 走查：多选 --------------------------------------------------------------

describe("walkQuestionnaire — multi select", () => {
  it("parses '1,3' into the selected labels", async () => {
    const { ui, calls } = fakeUi([{ kind: "input", reply: "1,3" }]);
    const result = await walkQuestionnaire(ui, [Q_MULTI]);
    expect(result.answers[0]).toEqual({
      questionIndex: 0,
      question: Q_MULTI.question,
      kind: "multi",
      answer: null,
      selected: ["search", "themes"],
    });
    expect(calls[0]!.method).toBe("input");
    expect(calls[0]!.title.startsWith("Which features do you want to enable?")).toBe(true);
    expect(calls[0]!.arg).toBe("1,3");
  });

  it("an empty commit means nothing selected (deliberate)", async () => {
    const { ui } = fakeUi([{ kind: "input", reply: "   " }]);
    const result = await walkQuestionnaire(ui, [Q_MULTI]);
    expect(result.answers[0]).toMatchObject({ kind: "multi", selected: [] });
  });

  it("a non-index token is a typed custom answer, kept verbatim", async () => {
    const { ui } = fakeUi([{ kind: "input", reply: "only the export one, but pdf AND csv" }]);
    const result = await walkQuestionnaire(ui, [Q_MULTI]);
    expect(result.answers[0]).toEqual({
      questionIndex: 0,
      question: Q_MULTI.question,
      kind: "custom",
      answer: "only the export one, but pdf AND csv",
    });
  });
});

// --- 走查：顺序 --------------------------------------------------------------

describe("walkQuestionnaire — dialog order", () => {
  it("walks questions in order and interleaves the custom follow-up", async () => {
    const { ui, calls } = fakeUi([
      { kind: "input", reply: "2" }, // Q0 multi
      { kind: "select", reply: `3. ${SENTINEL_LABEL}` }, // Q1 select → 哨兵行
      { kind: "input", reply: "neither, honestly" }, // Q1 custom
    ]);
    const result = await walkQuestionnaire(ui, [Q_MULTI, Q_SINGLE]);
    expect(result.cancelled).toBe(false);
    expect(result.answers.map((a) => a.kind)).toEqual(["multi", "custom"]);
    expect(calls.map((c) => c.method)).toEqual(["input", "select", "input"]);
  });
});

// --- 参数归一 ----------------------------------------------------------------

describe("normalizeParams", () => {
  it("accepts a minimal valid call (header/multiSelect optional, empty preview dropped)", () => {
    const params = normalizeParams({
      questions: [{ question: "Q?", options: [{ label: "A", description: "a", preview: "" }, { label: "B", description: "b" }] }],
    });
    expect(params.questions[0]).toEqual({
      question: "Q?",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    });
  });

  it("rejects empty, oversized question sets with a model-readable message", () => {
    expect(() => normalizeParams({ questions: [] })).toThrow(/needs 1-4 questions/);
    expect(() => normalizeParams(undefined)).toThrow(/needs 1-4 questions/);
    const tooMany: unknown[] = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
      question: `Q${i}?`,
      options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
    }));
    expect(() => normalizeParams({ questions: tooMany })).toThrow(/at most 4 questions/);
  });

  it("enforces the option bounds and both hard length limits", () => {
    const one = [{ label: "A", description: "a" }];
    const five = ["A", "B", "C", "D", "E"].map((l) => ({ label: l, description: "d" }));
    const base = (options: unknown[]) => ({ questions: [{ question: "Q?", options }] });
    expect(() => normalizeParams(base(one))).toThrow(new RegExp(`must have ${MIN_OPTIONS}-${MAX_OPTIONS} entries`));
    expect(() => normalizeParams(base(five))).toThrow(new RegExp(`must have ${MIN_OPTIONS}-${MAX_OPTIONS} entries`));
    const longLabel = { label: "x".repeat(MAX_LABEL_LENGTH + 1), description: "d" };
    expect(() => normalizeParams(base([longLabel, longLabel]))).toThrow(new RegExp(`the limit is ${MAX_LABEL_LENGTH}`));
    const longHeader = { question: "Q?", header: "x".repeat(MAX_HEADER_LENGTH + 1), options: one.concat(one) };
    expect(() => normalizeParams({ questions: [longHeader] })).toThrow(new RegExp(`the limit is ${MAX_HEADER_LENGTH}`));
  });

  it("rejects reserved sentinel labels, case-insensitively, naming the actual label", () => {
    const base = (label: string) => ({ questions: [{ question: "Q?", options: [{ label, description: "d" }, { label: "B", description: "b" }] }] });
    expect(() => normalizeParams(base("Other"))).toThrow(/is reserved/);
    expect(() => normalizeParams(base("  type SOMETHING. "))).toThrow(/is reserved/);
  });

  it("demands a non-empty description — it is what the option row shows", () => {
    const base = (description: unknown) => ({ questions: [{ question: "Q?", options: [{ label: "A", description }, { label: "B", description: "b" }] }] });
    expect(() => normalizeParams(base(undefined))).toThrow(/description must be a non-empty string/);
    expect(() => normalizeParams(base("   "))).toThrow(/description must be a non-empty string/);
  });
});

// --- 信封 --------------------------------------------------------------------

describe("buildAnswerEnvelope", () => {
  it("formats the answered envelope in the ecosystem shape", () => {
    const answers: AskAnswer[] = [
      { questionIndex: 0, question: "Library?", kind: "option", answer: "date-fns" },
      { questionIndex: 1, question: "Features?", kind: "multi", answer: null, selected: ["search", "export"] },
      { questionIndex: 2, question: "Notes?", kind: "custom", answer: "keep it small" },
    ];
    const text = buildAnswerEnvelope({ answers, cancelled: false });
    expect(text).toBe(
      'User has answered your questions: "Library?"="date-fns". "Features?"="search, export". "Notes?"="keep it small". ' +
        "You can now continue with the user's answers in mind.",
    );
  });

  it("an empty multi selection and an empty custom answer render as (no input), not as silence", () => {
    const answers: AskAnswer[] = [
      { questionIndex: 0, question: "Features?", kind: "multi", answer: null, selected: [] },
      { questionIndex: 1, question: "Notes?", kind: "custom", answer: "" },
    ];
    expect(buildAnswerEnvelope({ answers, cancelled: false })).toContain('"Features?"="(no input)". "Notes?"="(no input)".');
  });

  it("declined or empty results both say the user declined", () => {
    expect(buildAnswerEnvelope({ answers: [], cancelled: true })).toBe("User declined to answer questions");
    expect(buildAnswerEnvelope({ answers: [], cancelled: false })).toBe("User declined to answer questions");
  });
});

// --- 与渲染层的跨边界契约 ------------------------------------------------------
// ChatPane 拦截器认对话框靠三个字面量（见 questionnaire.test.ts，那边钉的是
// 渲染层匹配器接受这些字面量；这边钉的是我们的走查发出的就是这些字面量）：
//   标题前缀 `[header] question` / `question`（walkerTitleStarts）
//   选项行 `N. label — description`，哨兵行 `N+1. Type something.`（extractSentinelLabel）
//   后续输入标题 `前缀\n\nType your answer:`

describe("cross-boundary contract with the app's questionnaire interceptor", () => {
  it("every dialog title starts with the exact prefix the interceptor matches", async () => {
    const { ui, calls } = fakeUi([
      { kind: "input", reply: "1" }, // multi: input title
      { kind: "select", reply: "1. date-fns — functional, tree-shakeable" },
    ]);
    await walkQuestionnaire(ui, [Q_MULTI, Q_SINGLE]);
    expect(calls).toHaveLength(2);
    // 钉字节：前缀就是拦截器认的那个拼法（含 preview 折叠时也不破前缀）。
    expect(calls[0]!.title.startsWith("Which features do you want to enable?")).toBe(true);
    expect(calls[1]!.title.startsWith("[Library] Which library should we use for date formatting?")).toBe(true);
  });

  it("the sentinel row is the exact string extractSentinelLabel reads back", async () => {
    const { ui, calls } = fakeUi([{ kind: "select", reply: "1. date-fns — functional, tree-shakeable" }]);
    await walkQuestionnaire(ui, [Q_SINGLE]);
    const options = calls[0]!.arg as string[];
    const last = options[options.length - 1]!;
    // 渲染层用 /^\d+\.\s*(.*)$/ 反解哨兵标签 —— 我们的行必须匹配同一模式。
    const m = /^\d+\.\s*(.*)$/.exec(last);
    expect(last).toBe(`3. ${SENTINEL_LABEL}`);
    expect(m?.[1]).toBe(SENTINEL_LABEL);
  });

  it("the custom-answer follow-up input title starts with the same prefix", async () => {
    const { ui, calls } = fakeUi([
      { kind: "select", reply: `3. ${SENTINEL_LABEL}` },
      { kind: "input", reply: "use Intl.DateTimeFormat" },
    ]);
    await walkQuestionnaire(ui, [Q_SINGLE]);
    expect(calls[1]!.title.startsWith("[Library] Which library should we use for date formatting?")).toBe(true);
  });

  it("formatOptionLine round-trips through parseIndex", () => {
    const line = formatOptionLine(Q_SINGLE.options[0]!, 0);
    expect(parseIndex(line, 3)).toBe(0);
    expect(parseIndex("3. whatever", 3)).toBe(2);
    expect(parseIndex("13. beyond", 3)).toBeNull();
    expect(parseIndex("", 3)).toBeNull();
  });
});

// --- 注册与让路 ---------------------------------------------------------------

type FakePi = {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  getAllTools(): Array<{ name: string }>;
  registerTool(tool: Record<string, unknown>): void;
};

function fakePi(toolNames: string[]): { pi: FakePi; registered: Record<string, unknown>[]; start: () => void } {
  const registered: Record<string, unknown>[] = [];
  let handler: (() => void) | undefined;
  const pi: FakePi = {
    on(event, h) {
      if (event === "session_start") handler = () => h({}, {});
    },
    getAllTools: () => toolNames.map((name) => ({ name })),
    registerTool: (tool) => registered.push(tool),
  };
  return { pi, registered, start: () => handler?.() };
}

/** 单点强转：分发件的默认导出接收桩型 ExtensionAPI，假件只实现用到的三个成员。 */
function registerOn(pi: FakePi): void {
  (pipiAskUserQuestion as unknown as (p: FakePi) => void)(pi);
}

describe("registration — defer to an existing provider", () => {
  it("registers the tool on session_start when nobody else provides it", () => {
    const { pi, registered, start } = fakePi(["read", "bash"]);
    registerOn(pi);
    start();
    expect(registered).toHaveLength(1);
    const tool = registered[0] as { name: string; executionMode?: string };
    expect(tool.name).toBe("ask_user_question");
    expect(tool.executionMode).toBe("sequential");
  });

  it("stays out of the way when another provider already ships the tool", () => {
    const { pi, registered, start } = fakePi(["read", "ask_user_question"]);
    registerOn(pi);
    start();
    expect(registered).toHaveLength(0);
  });

  it("alreadyProvidesAskUserQuestion is the exact rule the session_start path uses", () => {
    expect(alreadyProvidesAskUserQuestion(["read", "bash"])).toBe(false);
    expect(alreadyProvidesAskUserQuestion(["read", "ask_user_question"])).toBe(true);
  });

  it("execute: no dialog UI → a decline-style error, not a hang", async () => {
    const { pi, registered, start } = fakePi([]);
    registerOn(pi);
    start();
    const tool = registered[0] as { execute: (id: string, params: unknown, signal: undefined, onUpd: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };
    const result = await tool.execute("t1", { questions: [Q_SINGLE] }, undefined, undefined, { hasUI: false });
    expect(result.content[0]!.text).toMatch(/no dialog UI/);
  });

  it("execute: normalizes invalid args into a model-readable error before any dialog", async () => {
    const { pi, registered, start } = fakePi([]);
    registerOn(pi);
    start();
    const tool = registered[0] as { execute: (id: string, params: unknown, signal: undefined, onUpd: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };
    const result = await tool.execute("t1", { questions: [] }, undefined, undefined, { hasUI: true, ui: fakeUi([]).ui });
    expect(result.content[0]!.text).toMatch(/^Error: ask_user_question needs 1-4 questions/);
  });

  it("execute: end-to-end through the registered tool with a fake ui", async () => {
    const { pi, registered, start } = fakePi([]);
    registerOn(pi);
    start();
    const tool = registered[0] as {
      execute: (id: string, params: unknown, signal: undefined, onUpd: undefined, ctx: unknown) => Promise<{
        content: Array<{ text: string }>;
        details: { cancelled: boolean };
      }>;
    };
    const { ui } = fakeUi([{ kind: "select", reply: "1. date-fns — functional, tree-shakeable" }]);
    const params: AskParams = normalizeParams({ questions: [Q_SINGLE] });
    const result = await tool.execute("t1", params, undefined, undefined, { hasUI: true, ui });
    expect(result.details.cancelled).toBe(false);
    expect(result.content[0]!.text).toContain('User has answered your questions: "Which library should we use for date formatting?"="date-fns".');
  });
});

// --- 分发件本身 --------------------------------------------------------------

// 真 pi-ai 校验器（pi 运行时用的那份）：我们 schema 的第一条防线是它在 pi 里
// 真的生效。pi-ai 的 exports map 全锁（且 typebox 不可从仓库根解析），所以用
// createRequire 从 pi 包内图加载 —— 布局变了这里会加载失败，那也是信号。
import { createRequire } from "node:module";
import { join } from "node:path";

const requireFromPi = createRequire(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "index.js"));
const { validateToolArguments } = requireFromPi("./node_modules/@earendil-works/pi-ai/dist/utils/validation.js") as {
  validateToolArguments: (tool: { name: string; parameters: unknown }, call: { name?: string; arguments: unknown }) => unknown;
};

const schemaTool = { name: "ask_user_question", parameters: ASK_USER_QUESTION_SCHEMA };

/** 真 pi-ai 校验器过一遍。返回归一后的参数；拒绝则抛出 pi 自己的错误文案。 */
function piValidate(args: unknown): unknown {
  return validateToolArguments(schemaTool, { name: "ask_user_question", arguments: args });
}

describe("shipped artifact", () => {
  const shipped = SHIPPED_EXTENSIONS.find((e) => e.fileName === "pipi-ask-user-question.ts");
  it("ships as an app-owned (overwrite) extension file", () => {
    expect(shipped).toBeDefined();
    expect(shipped!.content).toContain('name: ASK_USER_QUESTION_TOOL_NAME');
    expect(shipped!.content).toContain('executionMode: "sequential"');
  });
  it("keeps the file dependency-free at runtime (no value imports beyond types)", () => {
    // 这条是「能被单测」的前提：文件里不允许出现非 type-only 的包导入。
    const imports = [...shipped!.content.matchAll(/^import\s+(?!type\b)([^;]+)$/gm)].map((m) => m[1]!);
    expect(imports).toEqual([]);
  });
  it("description quotes the exact bounds the schema enforces (they must drift together)", () => {
    // 扩展注释承诺过：改常量必须同步改 description 文案。钉法：schema JSON 里
    // 的每个数字（1/2/4/16/60）必须同时出现在 TOOL_DESCRIPTION 里。
    const desc = shipped!.content;
    for (const n of [MAX_QUESTIONS, MIN_OPTIONS, MAX_OPTIONS, MAX_HEADER_LENGTH, MAX_LABEL_LENGTH]) {
      expect(desc).toContain(String(n));
    }
    // 保留标签同理：description 警告了这两个名字。
    for (const label of RESERVED_LABELS) {
      expect(desc).toContain(label);
    }
  });

  it("the real pi-ai validator (the one pi runs) enforces this schema", () => {
    // 上一轮的残余风险当场关闭：不用等真实对话，pi 运行时用的那个校验器
    // 在这里直接跑。它接受合法参数、拒绝越界参数。
    const valid = {
      questions: [{ question: "Q?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
    };
    expect((piValidate(valid) as { questions: unknown[] }).questions).toHaveLength(1);

    const five = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
      question: `Q${i}?`,
      options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
    }));
    expect(() => piValidate({ questions: five })).toThrow(/Validation failed/);
    expect(() => piValidate({ questions: [{ question: "Q?", options: [{ label: "A", description: "a" }] }] })).toThrow(
      /Validation failed/,
    );
    expect(() =>
      piValidate({ questions: [{ question: "Q?", header: "x".repeat(MAX_HEADER_LENGTH + 1), options: valid.questions![0]!.options }] }),
    ).toThrow(/Validation failed/);
  });

  it("the schema's required description is enforced by pi (and again by our normalize)", () => {
    // 双层防线的一致性：pi 拒绝缺 description（schema required），即使将来
    // pi 层松了，normalizeParams 仍在。两侧都要断言，防的是「只改一侧」。
    const args = { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] };
    expect(() => piValidate(args)).toThrow(/must have required properties description/);
    expect(() => normalizeParams(args)).toThrow(/description must be a non-empty string/);
  });
});
