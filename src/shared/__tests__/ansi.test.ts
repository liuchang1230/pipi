// 扩展文本里带颜色的字符串必须在进 DOM 之前剥掉——用户报的乱码就是这个：
// 输入框上方显示 `[38;5;241m◆ [39m[38;5;244m3 checkpoints[39m`。
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../ansi";

const ESC = "\u001b";

describe("stripAnsi", () => {
  it("strips the exact string the user saw (theme.fg 256-colour status)", () => {
    const status = `${ESC}[38;5;241m◆ ${ESC}[39m${ESC}[38;5;244m3 checkpoints${ESC}[39m`;
    expect(stripAnsi(status)).toBe("◆ 3 checkpoints");
  });

  it("strips the basic 16-colour and bold forms", () => {
    expect(stripAnsi(`${ESC}[1;31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`${ESC}[2mdim${ESC}[22m`)).toBe("dim");
  });

  it("strips an OSC sequence (terminal title / hyperlink) without eating the text after it", () => {
    expect(stripAnsi(`${ESC}]0;window title\u0007hello`)).toBe("hello");
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link`)).toBe("link");
  });

  it("leaves plain text, CJK and emoji untouched", () => {
    expect(stripAnsi("3 checkpoints")).toBe("3 checkpoints");
    expect(stripAnsi("上下文 42% · ⏳")).toBe("上下文 42% · ⏳");
    expect(stripAnsi("")).toBe("");
  });

  it("removes a lone escape or stray BEL (an unterminated sequence must not reach the DOM)", () => {
    expect(stripAnsi(`half${ESC}`)).toBe("half");
    expect(stripAnsi("a\u0007b")).toBe("ab");
  });

  it("is idempotent — a status already clean passes through the view layer unchanged", () => {
    const clean = stripAnsi(`${ESC}[31mx${ESC}[0m`);
    expect(stripAnsi(clean)).toBe(clean);
  });
});
