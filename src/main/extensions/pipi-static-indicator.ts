import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pipi 随 app 分发的扩展：静态工作指示器（防闪烁）。
 *
 * 背景（实测）：agent 流式回答时，pi 的 TUI 会用 80ms 间隔动画重绘工作状态行
 * （spinner），且每段输出/上下文计数变化会把「输出行 → 输入框 → footer」整段
 * 清行重画。xterm 的 DEC 2026 同步批处理在部分机器上仍掩盖不住，表现为输入框
 * 和底部模型/上下文文字闪烁。
 *
 * 这里把 spinner 换成单帧静态点：Loader 不会启动动画 interval（frames.length
 * <= 1），状态行只在出现/消失时各重绘一次，12.5Hz 重写循环消失。
 *
 * 该文件由主进程在启动时写入 ~/.pi/agent/extensions/，pi 自动发现；/reload
 * 可热加载。删除后下次启动会被重新写入（产品自带增强）。
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWorkingIndicator({ frames: ["●"] });
  });
}
