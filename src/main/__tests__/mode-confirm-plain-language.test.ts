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
import { describeBashIntent, summarizeBash, summarizeWrite } from "../extensions/pipi-mode-switch";

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

  it("describes a file edit by scale instead of dumping the first line", () => {
    const text = summarizeWrite("edit", {
      path: "src/a.ts",
      oldText: "const a = 1;\nconst b = 2;",
      newText: "const a = 42;\nconst b = 2;\nconst c = 3;",
    });
    expect(text).toContain("改写为 3 行");
    expect(text).toContain("src/a.ts");
    expect(splitConfirmMessage(text).detail).toContain("删掉: const a = 1;");
    expect(splitConfirmMessage(text).detail).toContain("换成: const a = 42;");
  });

  it("calls out a whitespace-only change", () => {
    const text = summarizeWrite("edit", { path: "a.ts", oldText: "a  b", newText: "a b" });
    expect(text).toContain("空白");
  });

  it("describes an insert and a whole-file write", () => {
    expect(summarizeWrite("edit", { path: "a.ts", oldText: "", newText: "x\ny" })).toContain("新增 2 行");
    const wrote = summarizeWrite("write", { path: "new.ts", content: "line1\nline2\n" });
    expect(wrote).toContain("整份覆盖");
    expect(wrote).toContain("new.ts");
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
