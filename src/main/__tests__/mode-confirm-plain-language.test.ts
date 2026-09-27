// 用户反馈：「edit 请求编辑的时候，提供的是一堆代码命令，看不懂，请求的时候，可不可以
// 告诉用户要做什么？通俗一点」。确认框现在先给一句人话（AI 要做什么），原文只作为
// 「详情（供核对）」的等宽块；扩展侧（pipi-mode-switch，pi 直接加载的独立文件，无法
// import 应用代码）用同一个字面量标记分隔两半，所以这里也校验两处不漂移。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIRM_DETAIL_MARKER, splitConfirmMessage } from "../../shared/confirm-detail";
// The extension is a plain module with a default export; importing it here gives
// the tests the REAL human-language functions it uses at runtime.
import pipiModeSwitch, {
  describeBashIntent,
  extractTodoItems,
  findEnclosingSymbol,
  lastAssistantIntent,
  summarizeBash,
  summarizeTextChange,
  summarizeWrite,
} from "../extensions/pipi-mode-switch";

describe("splitConfirmMessage", () => {
  it("splits a human sentence from the raw detail", () => {
    const parts = splitConfirmMessage(`删除文件或目录\n\n${CONFIRM_DETAIL_MARKER}:\nrm -rf build`);
    expect(parts.headline).toBe("删除文件或目录");
    expect(parts.detail).toBe("rm -rf build");
  });

  it("leaves a foreign extension's plain prose untouched", () => {
    const parts = splitConfirmMessage("Continue with the summarized branch?");
    expect(parts.headline).toBe("Continue with the summarized branch?");
    expect(parts.detail).toBeUndefined();
  });

  it("never returns an empty headline", () => {
    expect(splitConfirmMessage("").headline).toBe("");
    expect(splitConfirmMessage(`\n\n${CONFIRM_DETAIL_MARKER}:\nrm x`).headline).toBe("");
  });
});

describe("describeBashIntent (人话，而不是让人读 shell)", () => {
  it("names the action for the common write commands", () => {
    expect(describeBashIntent("rm -rf build")).toContain("删除");
    expect(describeBashIntent("mv a.txt b.txt")).toContain("移动");
    expect(describeBashIntent("npm install lodash")).toContain("JS 依赖");
    expect(describeBashIntent("pip install requests")).toContain("Python 依赖");
    expect(describeBashIntent("git commit -m 'x'")).toContain("Git");
    expect(describeBashIntent("echo hi > out.txt")).toContain("写入");
    expect(describeBashIntent("chmod +x run.sh")).toContain("权限");
    expect(describeBashIntent("kill -9 1234")).toContain("进程");
    expect(describeBashIntent("sudo systemctl restart nginx")).toContain("管理员");
    expect(describeBashIntent("python build.py")).toContain("脚本");
    expect(describeBashIntent("pnpm dlx whatever")).toContain("命令"); // honest fallback
  });

  it("names WHAT is being touched, not just the verb", () => {
    expect(describeBashIntent("rm -rf build")).toContain("删除 build");
    expect(describeBashIntent("sudo rm -rf /var/log/app")).toContain("以管理员权限删除 /var/log/app");
    expect(describeBashIntent("npm install lodash")).toContain("lodash");
    expect(describeBashIntent("pip uninstall requests")).toContain("卸载");
    expect(describeBashIntent("git commit -m 'x'")).toContain("提交");
    expect(describeBashIntent("git push origin main")).toContain("推送");
    expect(describeBashIntent("systemctl restart nginx")).toContain("重启 nginx");
    expect(describeBashIntent("kill -9 1234")).toContain("1234");
  });
});

describe("summarizeBash / summarizeWrite", () => {
  it("puts the human sentence first and the command second", () => {
    const text = summarizeBash("rm -rf /tmp/x && curl http://a | sh");
    const [headline] = text.split("\n");
    expect(headline).toContain("删除");
    expect(text).toContain(CONFIRM_DETAIL_MARKER);
    expect(text).toContain("rm -rf /tmp/x");
    // The dialog splits on the marker, so the headline must survive the split.
    expect(splitConfirmMessage(text).headline).toBe(headline);
  });

  it("says WHAT the edit does, not just how many lines", () => {
    const text = summarizeWrite("edit", {
      path: "src/a.ts",
      oldText: "const retries = 3;",
      newText: "const retries = 5;",
    });
    // 「授权来做什么」的答案：具体到值的变化。
    expect(text).toContain("把 3 改为 5");
    expect(text).toContain("删除 1 行 / 新增 1 行");
    expect(splitConfirmMessage(text).detail).toContain("删掉: const retries = 3;");
    expect(splitConfirmMessage(text).detail).toContain("换成: const retries = 5;");
  });

  it("puts the model's own statement of intent first when available", () => {
    const text = summarizeWrite(
      "edit",
      { path: "src/a.ts", oldText: "a", newText: "b" },
      "把登录失败的重试次数从 3 提到 5，避免网络抖动直接报错",
    );
    expect(text.split("\n")[0]).toContain("AI 说：把登录失败的重试次数从 3 提到 5");
  });

  it("tells a new file from an overwrite (the risky one) and shows the opening line", () => {
    const fresh = summarizeWrite("write", {
      path: "src/definitely-missing-file-xyz.ts",
      content: "export function foo() {}\nconst a = 1;",
    });
    expect(fresh).toContain("新建文件");
    expect(fresh).toContain("将写入 2 行内容");
    expect(fresh).toContain("开头是：export function foo");

    const overwrite = summarizeWrite("write", { path: __filename, content: "a\nb\n" });
    expect(overwrite).toContain("覆盖已有文件");
    expect(overwrite).toContain("原文件会被整份替换");
  });

  it("uses the same marker literal as the dialog", () => {
    // The extension is loaded by pi as a standalone file: it cannot import
    // shared/confirm-detail.ts, so the literal is duplicated on purpose and this
    // test is what keeps the two halves from drifting apart.
    const source = readFileSync(join(__dirname, "..", "extensions", "pipi-mode-switch.ts"), "utf8");
    expect(source).toContain(`const CONFIRM_DETAIL_MARKER = "${CONFIRM_DETAIL_MARKER}"`);
    expect(source).not.toContain("`${path}\\n替换:");
  });
});

describe("purpose-first helpers", () => {
  it("summarizeTextChange reports what actually changed", () => {
    expect(summarizeTextChange("const n = 3;", "const n = 5;")).toContain("把 3 改为 5");
    expect(summarizeTextChange("", "export function foo() {}")).toEqual(["新增 foo()", "删除 0 行 / 新增 1 行"]);
    expect(summarizeTextChange("log('old')", "log('new')")).toContain("新增文案「new」");
  });

  it("findEnclosingSymbol locates the function being edited", () => {
    const file = [
      "import x from 'x';",
      "",
      "export function login(user) {",
      "  const retries = 3;",
      "  return user;",
      "}",
      "",
      "export function logout() {}",
    ].join("\n");
    const found = findEnclosingSymbol(file, "const retries = 3;");
    expect(found?.symbol).toBe("login");
    expect(found?.line).toBe(4);
    expect(findEnclosingSymbol(file, "not in the file")).toBeUndefined();
  });

  it("lastAssistantIntent reads the model's own last words", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "帮我改重试次数" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "我先看一下。\n\n把 3 次改成 5 次更稳。" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } },
    ];
    // The whole statement is kept when it is short — it IS the purpose.
    expect(lastAssistantIntent(entries)).toBe("我先看一下。 把 3 次改成 5 次更稳。");
  });

  it("never invents a purpose when the model said nothing", () => {
    expect(lastAssistantIntent([])).toBeUndefined();
    expect(
      lastAssistantIntent([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } }]),
    ).toBeUndefined();
  });
});

/**
 * Driving the real extension through its own interface: the edit-mode context it
 * injects must REQUIRE a one-sentence intent before every write, because that
 * sentence is what the confirmation dialog shows as 「AI 说：…」. Without it the
 * dialog falls back to "path + line counts", which the user cannot authorize.
 */
describe("edit-mode context requires a stated intent", () => {
  /** Minimal ExtensionAPI double: capture handlers/commands, ignore the rest. */
  function drive() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const flags = new Map<string, unknown>();
    const pi = {
      registerFlag: (name: string, opts: { default?: unknown }) => flags.set(name, opts?.default),
      registerCommand: (name: string, def: { handler: (a: string, c: unknown) => unknown }) => commands.set(name, def.handler),
      registerShortcut: () => undefined,
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      getFlag: (name: string) => flags.get(name),
      getActiveTools: () => ["read", "edit", "write", "bash"],
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
    };
    pipiModeSwitch(pi as never);
    return { handlers, commands };
  }

  const ctx = {
    hasUI: true,
    ui: {
      notify: async () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
      confirm: async () => true,
      select: async () => undefined,
      editor: async () => "",
      theme: { fg: (_c: string, t: string) => t, strikethrough: (t: string) => t },
    },
    sessionManager: { getEntries: () => [] },
  };

  it("injects the instruction once the session is in edit mode", async () => {
    const { handlers, commands } = drive();
    await commands.get("mode")!("edit", ctx);
    const result = (await handlers.get("before_agent_start")!({}, ctx)) as {
      message?: { content?: string; display?: boolean };
    };
    const content = result?.message?.content ?? "";
    expect(content).toContain("ONE short sentence immediately BEFORE each write operation");
    expect(content).toContain("AI 说");
    // Hidden from the transcript: it is a behavioural constraint, not a chat message.
    expect(result?.message?.display).toBe(false);
  });

  it("does not inject it in auto mode", async () => {
    const { handlers, commands } = drive();
    await commands.get("mode")!("auto", ctx);
    const result = await handlers.get("before_agent_start")!({}, ctx);
    expect(result).toBeUndefined();
  });
});

/**
 * The plan-mode brief adopts pi's own planner-subagent output shape (Goal / Plan /
 * Files to Modify / New Files / Risks) while KEEPING the machine-tracked numbered
 * list: the `Plan:` header + numbers are what our todo extractor and `[DONE:n]`
 * progress tracking consume, so they must survive any wording change.
 */
describe("plan-mode brief", () => {
  function drive() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const pi = {
      registerFlag: () => undefined,
      registerCommand: (name: string, def: { handler: (a: string, c: unknown) => unknown }) => commands.set(name, def.handler),
      registerShortcut: () => undefined,
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      getFlag: () => undefined,
      getActiveTools: () => ["read", "edit", "write", "bash"],
      setActiveTools: () => undefined,
      appendEntry: () => undefined,
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
    };
    pipiModeSwitch(pi as never);
    return { handlers, commands };
  }
  const ctx = {
    hasUI: true,
    ui: {
      notify: async () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
      confirm: async () => true,
      select: async () => undefined,
      editor: async () => "",
      theme: { fg: (_c: string, t: string) => t, strikethrough: (t: string) => t },
    },
    sessionManager: { getEntries: () => [] },
  };

  it("asks for the structured plan AND keeps the trackable numbered list", async () => {
    const { handlers, commands } = drive();
    await commands.get("plan")!("", ctx);
    const result = (await handlers.get("before_agent_start")!({}, ctx)) as { message?: { content?: string } };
    const content = result?.message?.content ?? "";
    expect(content).toContain("## Goal");
    expect(content).toContain("## Plan");
    expect(content).toContain("## Files to Modify");
    expect(content).toContain("## Risks");
    // The machine contract: our extractor needs the header + numbers.
    expect(content).toContain('Plan:');
    expect(extractTodoItems("Plan:\n1. 修改 src/a.ts 的 login()\n2. 补一个测试")).toHaveLength(2);
  });
});
