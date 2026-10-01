import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pipi 随 app 分发的扩展：结构化提问（`ask_user_question`）。
 *
 * 为什么需要它：pi 自身**不含**这个工具。生态里目前只有第三方 npm 包
 * `@juicesharp/rpiv-ask-user-question`（MIT）提供它，而 app 不分发第三方包
 * （见 .out-of-scope/）。于是 app 里那套完整问卷界面
 * （src/renderer/src/dialogs/QuestionnaireDialog.tsx：选项卡 / 并排预览 / 多选 /
 * 返回）对绝大多数用户是**死代码** —— 没有工具调用，聊天流里就不会出现被
 * ChatPane 拦截的那个 dialog。本扩展把「一次问 1-4 个带选项的问题，拿回结构化
 * 答案」变成每台 pipi 都有的原语。
 *
 * 线协议是**与渲染层共享的契约**（任何一侧都不能单方面改）：
 *   - 工具名必须是 `ask_user_question`：ChatPane 按工具名找那次运行中的调用
 *     （src/renderer/src/panes/ChatPane.tsx `findRunningAskUserQuestion`）。
 *   - 参数形状必须是 `{ questions: [{ question, header?, options: [{ label,
 *     description, preview? }], multiSelect? }] }`：`parseQuestionsFromArgs`
 *     逐字段读取（src/renderer/src/dialogs/QuestionnaireDialog.tsx:79）。
 *   - RPC（本地 SDK 与远程 `pi --mode rpc` 都是）里 pi 只给 select/input 两个
 *     双向对话框原语（`ui.custom()` 在这些模式返回 undefined），所以问法是
 *     **一问一个对话框**：单选题用 select，选项行 `N. label — description`，
 *     末尾追加哨兵行 `N+1. Type something.`；多选题用 input，选项清单折进标题，
 *     占位符 `1,3`。对话框标题必须以 `[header] question`（无 header 时
 *     `question`）开头 —— ChatPane 靠这个前缀把后续 dialog 对回问题并喂回用户
 *     收集的答案（`walkerTitleStarts`，同文件 :120；发射顺序见 :131
 *     `buildFlushSteps`）。所以答案解析必须容忍「返回的是整行选项文本」而非纯序号。
 *   - 答案信封（模型看到的那段文字）沿用这个工具家族的惯例措辞
 *     （"User has answered your questions: ..." / "User declined to answer
 *     questions"）：模型对这个形状有很强的先验，改措辞只会降低可读性。
 * 渲染层因此**零改动**。
 *
 * 终端视图（TUI）的降级：本扩展只走 select/input，没有自定义覆盖层，所以终端里
 * 是一问一个 pi 原生选择框 —— 没有选项卡、没有并排预览、多选是 "1,3" 文本输入。
 * 聊天视图拿到的是完整问卷界面。这个降级是刻意选的代价（ADR 0005 补记六），
 * 不要在功能文本里承诺终端也有覆盖层。
 *
 * 参数 schema 用**纯 JSON Schema，不 import typebox**：pi-ai 的
 * validateToolArguments 对没有 TypeBox.Kind 符号的 schema 显式走
 * coerceWithJsonSchema 分支（node_modules/@earendil-works/pi-ai/dist/utils/
 * validation.js:285），纯 JSON Schema 是一等公民；而 typebox 在本仓库根**不可
 * 解析**（只在 pi 自己的 node_modules 里），一旦 import，这个文件就再也不能被
 * vitest 直接单测了。代价是 `params` 在类型上是 `unknown`，所以归一与校验由
 * 下面的 `normalizeParams` 负责 —— 顺带让「边界值 + 保留标签」变成可测的纯函数，
 * 而不是只活在 schema 字符串里。（pi 表面在这个仓库的类型清单见
 * src/main/extensions/pi-api-stub.d.ts —— 它就是「我们承认依赖什么」的账本。）
 *
 * 命名冲突：用户自己装了 rpiv 时我们让路。注册放在 `session_start`（那一刻所有
 * 扩展都已加载完，`pi.getAllTools()` 看得见别人注册的同名工具），不是模块加载时
 * （那时扩展加载顺序未定）。装了 rpiv 的人保留它的完整 TUI 覆盖层。
 *
 * 不加 `promptGuidelines`：它们是**每轮驻留**的系统提示文本（rpiv 那三条约
 * 1200 字符 ≈ 300 token/轮），而关键约束（边界、保留标签、一次问完、多选、
 * preview）已经写在 tool description 里 —— 同样驻留、不重复付钱。`promptSnippet`
 * 只有一行，留着。
 *
 * 该文件由主进程启动时写入 ~/.pi/agent/extensions/（见 extension-sync.ts）。
 */

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/** 边界值。这些数字同时是渲染层与模型的契约：问答界面的选项卡设计按 4 个问题
 *  排版，模型侧的 description 逐字复述它们。改这里必须同步改 description 文案
 *  （shipped-text 测试会盯住）。 */
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/** 自动追加的「自己打一个答案」哨兵行标签。必须与渲染层的默认值一致
 *  （QuestionnaireDialog.tsx `DEFAULT_SENTINEL_LABEL`）：ChatPane 从这个标签
 *  反解出问卷里的自定义行文案。 */
export const SENTINEL_LABEL = "Type something.";

/** 模型不得自己写这两个标签：`Other` 是 Claude Code 习惯带来的重复行，
 *  `Type something.` 我们已经无条件追加。多选 TUI 里的 `Next` 行我们两个渲染
 *  面都没有，所以**不**在保留集里（比要求更严只会白白拒绝合法请求）。 */
export const RESERVED_LABELS: readonly string[] = ["Other", SENTINEL_LABEL];

export const DECLINE_MESSAGE = "User declined to answer questions";
const NO_INPUT_PLACEHOLDER = "(no input)";

/** 折进 select 标题的单个预览上限（字节近似值，按字符计）。 */
const MAX_PREVIEW_CHARS = 600;

export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskParams {
  questions: AskQuestion[];
}

/**
 * 我们需要的 ctx.ui 切片。结构类型（不是 pi 的 ExtensionUIContext）：这样
 * walkQuestionnaire 可以直接用假 UI 单测，也让「只依赖 select/input」成为
 * 类型层面的约束 —— 谁想在这个文件里调 ui.custom() 会先编译不过。
 */
export interface DialogUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export type AskAnswer =
  | { questionIndex: number; question: string; kind: "option"; answer: string }
  | { questionIndex: number; question: string; kind: "custom"; answer: string }
  | { questionIndex: number; question: string; kind: "multi"; answer: null; selected: string[] };

export interface QuestionnaireResult {
  answers: AskAnswer[];
  cancelled: boolean;
}

/** 问询参数 schema。纯 JSON Schema（见文件头：pi 显式支持无 TypeBox.Kind 的
 *  schema）。描述文案是**模型唯一读到的说明**，逐字包含硬边界。 */
export const ASK_USER_QUESTION_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: `Questions to ask the user (1-${MAX_QUESTIONS}). Put every question you need answered now in this one call — do not stack several ask_user_question calls back-to-back.`,
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
          },
          header: {
            type: "string",
            maxLength: MAX_HEADER_LENGTH,
            description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
          },
          options: {
            type: "array",
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            description: `The available choices for this question. Must have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The '${SENTINEL_LABEL}' row is appended automatically — do NOT author it.`,
            items: {
              type: "object",
              required: ["label", "description"],
              properties: {
                label: {
                  type: "string",
                  maxLength: MAX_LABEL_LENGTH,
                  description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice. If you recommend a specific option, put it first and append "(Recommended)" to its label.`,
                },
                description: {
                  type: "string",
                  description:
                    "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
                },
                preview: {
                  type: "string",
                  description:
                    "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. In the chat view it renders as markdown in a monospace box beside the options; the terminal view folds it into the question text.",
                },
              },
            },
          },
          multiSelect: {
            type: "boolean",
            default: false,
            description:
              "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
          },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
};

const TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when a decision is the user's to make and the choices can be enumerated: clarifying ambiguous instructions, gathering preferences, or offering directions to take. Ask up to ${MAX_QUESTIONS} questions per call.

Usage notes:
- Every question has ${MIN_OPTIONS}-${MAX_OPTIONS} options, each with a concise label (1-5 words) and a description of its trade-offs. A header is an optional short chip (max ${MAX_HEADER_LENGTH} characters); a label is at most ${MAX_LABEL_LENGTH} characters.
- Users can always type a custom answer through the automatically appended "${SENTINEL_LABEL}" row, or dismiss the questionnaire (Escape) to abandon it — the result then says the user declined. Do NOT author "Other" or "${SENTINEL_LABEL}" labels yourself: reserved labels are rejected.
- Set multiSelect: true when several answers are valid. The "${SENTINEL_LABEL}" row is available on every question, including when options carry a preview.
- Use the optional \`preview\` field when the user needs to compare concrete artifacts: ASCII mockups of UI layouts, code snippets, diagrams, configuration examples. When any option has a preview, the chat view switches to a side-by-side layout. Do not use previews for simple preference questions where labels and descriptions suffice.
- If you recommend a specific option, make it the first option and append "(Recommended)" to its label.
- Group all clarifying questions into a single call rather than asking them one after another.`;

/** 「已经有同名工具了」判定。抽成纯函数是为了可测：在 session_start 里我们要
 *  靠它决定让路（见文件头「命名冲突」）。 */
export function alreadyProvidesAskUserQuestion(toolNames: readonly string[]): boolean {
  return toolNames.includes(ASK_USER_QUESTION_TOOL_NAME);
}

/** 对话框标题前缀。**与渲染层共享的契约**：ChatPane 的 walkerTitleStarts 用
 *  同样的拼法把后续 dialog 对回问题，两侧任一改动都会让问卷在提交后错位。 */
export function questionTitlePrefix(q: AskQuestion): string {
  return q.header ? `[${q.header}] ${q.question}` : q.question;
}

/** 选项行。ChatPane 把整行原样回传（buildFlushResponse），所以解析必须读行首
 *  数字而不是整串比较。 */
export function formatOptionLine(option: AskOption, index: number): string {
  return `${index + 1}. ${option.label} — ${option.description}`;
}

/** 读「行首数字」为 0 基下标；越界/非数字返回 null（宿主返回了清单外的东西 = 当作
 *  放弃，而不是编一个答案出来）。 */
export function parseIndex(token: string, count: number): number | null {
  const i = Number.parseInt(token, 10) - 1;
  return i >= 0 && i < count ? i : null;
}

/** 单选没有并排预览面板时，把预览折进提问标题（终端视图唯一的展示位）。 */
function previewBlock(q: AskQuestion): string {
  const blocks = q.options.flatMap((o, i) =>
    o.preview && o.preview.length > 0 ? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`] : [],
  );
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

/** 一问一个对话框地走完问卷。任何一步被放弃（原语返回 undefined）就整体取消 ——
 *  部分答案照旧带回，与生态惯例一致。 */
export async function walkQuestionnaire(ui: DialogUi, questions: readonly AskQuestion[]): Promise<QuestionnaireResult> {
  const answers: AskAnswer[] = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    const answer = q.multiSelect ? await askMultiSelect(ui, q, qi) : await askSingleSelect(ui, q, qi);
    if (answer === undefined) return { answers, cancelled: true };
    answers.push(answer);
  }
  return { answers, cancelled: false };
}

/** undefined = 用户关掉了对话框（整卷取消）。 */
async function askSingleSelect(ui: DialogUi, q: AskQuestion, questionIndex: number): Promise<AskAnswer | undefined> {
  const prefix = questionTitlePrefix(q);
  const options = q.options.map(formatOptionLine);
  options.push(`${q.options.length + 1}. ${SENTINEL_LABEL}`);
  const chosen = await ui.select(`${prefix}${previewBlock(q)}`, options);
  if (chosen == null) return undefined;
  const idx = parseIndex(chosen, options.length);
  if (idx == null) return undefined;
  if (idx < q.options.length) {
    return { questionIndex, question: q.question, kind: "option", answer: q.options[idx]!.label };
  }
  const typed = await ui.input(`${prefix}\n\nType your answer:`, "");
  if (typed == null) return undefined;
  return { questionIndex, question: q.question, kind: "custom", answer: typed };
}

/** undefined = 用户关掉了对话框（整卷取消）。 */
async function askMultiSelect(ui: DialogUi, q: AskQuestion, questionIndex: number): Promise<AskAnswer | undefined> {
  const prefix = questionTitlePrefix(q);
  const list = q.options.map(formatOptionLine).join("\n");
  const value = await ui.input(
    `${prefix}\n\n${list}\n\nEnter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.`,
    "1,3",
  );
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // 故意空提交 = 一个都没勾（与 TUI 里直接点「下一步」同义）。
    return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] };
  }
  const tokens = trimmed.split(/[,\s]+/).filter((t) => t.length > 0);
  const indices = tokens.map((t) => (/^\d+\.?$/.test(t) ? parseIndex(t, q.options.length) : null));
  if (indices.every((i): i is number => i != null)) {
    const selected: string[] = [];
    for (const i of indices) {
      const label = q.options[i]!.label;
      if (!selected.includes(label)) selected.push(label);
    }
    return { questionIndex, question: q.question, kind: "multi", answer: null, selected };
  }
  // 任何一个 token 不是合法序号（词、或 3 个选项却填 "13"）都当「用户自己打了
  // 一段话」——原样保留，别把他的输入悄悄丢掉。这也是多选的自定义答案出口。
  return { questionIndex, question: q.question, kind: "custom", answer: trimmed };
}

/**
 * 归一 + 校验原始参数。pi 会用 schema 校验一遍，但 schema 表达不了的（保留标签）
 * 和 schema 只保证类型不保证语义的（空串、超长）都在这里兜住；错误信息是写给
 * **模型**看的，要能直接改对。
 */
export function normalizeParams(raw: unknown): AskParams {
  const params = raw as { questions?: unknown } | null | undefined;
  const rawQuestions = params?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error(`ask_user_question needs 1-${MAX_QUESTIONS} questions`);
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    throw new Error(
      `ask_user_question accepts at most ${MAX_QUESTIONS} questions per call (got ${rawQuestions.length}) — pick the ones you need answered now`,
    );
  }
  const questions = rawQuestions.map((rawQ, qi) => normalizeQuestion(rawQ, qi));
  return { questions };
}

function normalizeQuestion(raw: unknown, index: number): AskQuestion {
  const q = (raw ?? {}) as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
  const where = `questions[${index}]`;
  if (typeof q.question !== "string" || q.question.trim().length === 0) {
    throw new Error(`${where}.question must be a non-empty string`);
  }
  let header: string | undefined;
  if (q.header !== undefined && q.header !== null) {
    if (typeof q.header !== "string" || q.header.trim().length === 0) {
      throw new Error(`${where}.header must be a non-empty string when provided`);
    }
    if (q.header.length > MAX_HEADER_LENGTH) {
      throw new Error(`${where}.header is ${q.header.length} characters — the limit is ${MAX_HEADER_LENGTH}`);
    }
    header = q.header;
  }
  if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
    throw new Error(`${where}.options must have ${MIN_OPTIONS}-${MAX_OPTIONS} entries`);
  }
  const options = q.options.map((rawO, oi) => normalizeOption(rawO, `${where}.options[${oi}]`));
  return {
    question: q.question,
    ...(header === undefined ? {} : { header }),
    options,
    ...(q.multiSelect === true ? { multiSelect: true } : {}),
  };
}

function normalizeOption(raw: unknown, where: string): AskOption {
  const o = (raw ?? {}) as { label?: unknown; description?: unknown; preview?: unknown };
  if (typeof o.label !== "string" || o.label.trim().length === 0) {
    throw new Error(`${where}.label must be a non-empty string`);
  }
  const label = o.label;
  if (label.length > MAX_LABEL_LENGTH) {
    throw new Error(`${where}.label is ${label.length} characters — the limit is ${MAX_LABEL_LENGTH}`);
  }
  if (RESERVED_LABELS.some((reserved) => reserved.toLowerCase() === label.trim().toLowerCase())) {
    throw new Error(
      `${where}.label "${label}" is reserved — the "${SENTINEL_LABEL}" row is appended automatically, so name the choice itself`,
    );
  }
  if (typeof o.description !== "string" || o.description.trim().length === 0) {
    throw new Error(`${where}.description must be a non-empty string explaining the choice`);
  }
  const option: AskOption = { label: o.label, description: o.description };
  if (typeof o.preview === "string" && o.preview.length > 0) option.preview = o.preview;
  return option;
}

/** 答案信封（模型读到的那段文字）。措辞沿用生态惯例，见文件头。 */
export function buildAnswerEnvelope(result: QuestionnaireResult): string {
  if (result.cancelled) return DECLINE_MESSAGE;
  const segments = result.answers.map((a) => `"${a.question}"="${answerScalar(a)}".`);
  if (segments.length === 0) return DECLINE_MESSAGE;
  return `User has answered your questions: ${segments.join(" ")} You can now continue with the user's answers in mind.`;
}

function answerScalar(answer: AskAnswer): string {
  switch (answer.kind) {
    case "multi":
      return answer.selected.length > 0 ? answer.selected.join(", ") : NO_INPUT_PLACEHOLDER;
    case "custom":
      return answer.answer.length > 0 ? answer.answer : NO_INPUT_PLACEHOLDER;
    case "option":
      return answer.answer;
  }
}

/** pi 的工具结果包一层（内容 + 详情）。详情不参与渲染，留给会话回放与测试断言。 */
function toolResult(result: QuestionnaireResult, text: string) {
  return { content: [{ type: "text" as const, text }], details: { answers: result.answers, cancelled: result.cancelled } };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    if (alreadyProvidesAskUserQuestion(pi.getAllTools().map((t) => t.name))) {
      // 别人（例如用户自己装的 rpiv）已经提供同名工具 —— 让路。
      // 这里刻意不 console.*：pi 在 rpc 模式下用 stdout 传 JSON 协议，
      // 扩展往 stdout 打日志会污染协议流（本仓库所有分发扩展都不打）。
      return;
    }
    pi.registerTool({
      name: ASK_USER_QUESTION_TOOL_NAME,
      label: "Ask User Question",
      description: TOOL_DESCRIPTION,
      promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`,
      parameters: ASK_USER_QUESTION_SCHEMA,
      // 等人回答的工具不该和别的工具并发跑：并发会让对话框和别的工具输出交错，
      // 也让「先答完再动手」的语义变得不可依赖。
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        if (!ctx.hasUI) {
          return toolResult(
            { answers: [], cancelled: true },
            "Error: ask_user_question needs an interactive session — this run mode has no dialog UI (use print/json mode without it)",
          );
        }
        let params: AskParams;
        try {
          params = normalizeParams(rawParams);
        } catch (e) {
          return toolResult({ answers: [], cancelled: true }, `Error: ${e instanceof Error ? e.message : String(e)}`);
        }
        const result = await walkQuestionnaire(ctx.ui, params.questions);
        return toolResult(result, buildAnswerEnvelope(result));
      },
    });
  });
}
