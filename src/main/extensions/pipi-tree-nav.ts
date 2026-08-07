import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pipi 随 app 分发的扩展：会话树导航桥。
 *
 * RPC 模式没有 navigate_tree 命令，但扩展命令的 ctx.navigateTree() 可用
 * （等价 TUI /tree 的导航：原地切换 leaf，可选分支摘要）。聊天界面通过
 * `/pipi-tree-nav` 调用它，实现与 /tree 一致的操作语义。
 *
 * 用法：/pipi-tree-nav <entryId> [--summarize] [--instructions <文本>]
 *        [--label <文本>] [--replace]
 *
 * 该文件由主进程启动时写入 ~/.pi/agent/extensions/（见 extension-sync.ts）。
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("pipi-tree-nav", {
    description: "Navigate session tree to a point (pipi chat bridge)",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      const entryId = tokens[0] ?? "";
      if (!entryId) {
        await ctx.ui.notify("用法: /pipi-tree-nav <entryId> [--summarize] [--instructions 文本] [--label 文本] [--replace]", "warning");
        return;
      }
      const flags = new Set<string>();
      let summarize = false;
      let customInstructions: string | undefined;
      let label: string | undefined;
      let replaceInstructions: boolean | undefined;
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok === "--summarize") {
          summarize = true;
        } else if (tok === "--replace") {
          replaceInstructions = true;
        } else if (tok === "--instructions" || tok === "--label") {
          const key = tok === "--instructions" ? "instructions" : "label";
          const rest = tokens.slice(i + 1).join(" ");
          if (rest) {
            if (key === "instructions") customInstructions = rest;
            else label = rest;
          }
          break; // consumed the rest
        } else if (!flags.has("ignore")) {
          // tolerate stray tokens
        }
      }
      try {
        const result = await ctx.navigateTree(entryId, {
          summarize,
          customInstructions,
          replaceInstructions,
          label,
        });
        if (result.cancelled) {
          await ctx.ui.notify("导航已取消", "info");
        }
      } catch (e) {
        await ctx.ui.notify(`导航失败: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
