/**
 * pi 扩展是**按 TUI 写的**：它们用主题给文本上色（`ctx.ui.theme.fg("dim", …)`、
 * `theme.dim(…)`），拿到的是带 SGR 转义序列的字符串。pi 自己的终端会把它们渲染
 * 成颜色，我们的 DOM 没有终端来解释它们——原样上屏就是用户看到的那串乱码：
 *
 *     [38;5;241m◆ [39m[38;5;244m3 checkpoints[39m      // 输入框上方
 *
 * 所以「扩展写的文本 → 可显示文本」这一步只在**进 DOM 的地方**做，不改数据：
 * 面上（`extension-ui-view`）与对话框里（`UiDialog`）剥掉控制序列，主进程持有的
 * 面仍是 pi 声明的原文（要排查「扩展到底声明了什么」时看的是原文）。
 *
 * 颜色本身不复原：我们的调色板不是 pi 的 TUI 调色板，把 256 色硬译成 CSS 只会
 * 猜错；这里只保证**没有控制字符漏进 DOM**。
 */

/** CSI：`ESC [ 参数 中间 终止`（颜色、光标、清屏……）。 */
const CSI = /\u001b\[[0-9;?<=>!]*[ -/]*[@-~]/g;
/** OSC：`ESC ] …` 直到 `BEL` 或 `ESC \`（终端标题、超链接）。 */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
/** 两字符转义（`ESC \`、`ESC 7` 等）。 */
const SIMPLE = /\u001b[@-Z\\-_]/g;
/** 落单的 ESC / OSC 尾部的 BEL。 */
const STRAY = /[\u001b\u0007]/g;

/** 去掉 ANSI 控制序列，其余（含中日韩字符、emoji）原样保留。 */
export function stripAnsi(text: string): string {
  if (!text) return text;
  // 顺序有讲究：OSC 的内容里可能含 `[`，必须先于 CSI 剥掉，否则会被切成两截。
  return text.replace(OSC, "").replace(CSI, "").replace(SIMPLE, "").replace(STRAY, "");
}
