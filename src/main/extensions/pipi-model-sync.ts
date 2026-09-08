import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pipi 随 app 分发的扩展：模型配置热同步桥（RPC 后端专用）。
 *
 * App 的模型配置对话框保存 ~/.pi/agent/models.json / auth.json（本机直写或
 * 经 SFTP 写远程同名文件）后，正在运行的 pi 进程不会自动重读——上游只在
 * 启动时加载一次，连它自己的 /reload 也刻意不刷新模型注册表。没有这座桥，
 * 聊天页左上角的模型菜单要等所有会话重启才能看到新配置的模型。
 *
 * 聊天视图通过 RPC prompt 调用 /pipi-model-sync（渲染层会先经 get_commands
 * 确认本命令存在才发送，避免未知斜杠命令漏成普通用户消息）。命令内部调用
 * ctx.modelRegistry.refresh() —— pi 官方暴露的 models.json 重载接口，
 * allowNetwork:false 保持纯离线（目录在启动时已抓取，这里只重组 provider
 * 与可用性快照）。
 *
 * 该文件由主进程启动时写入 ~/.pi/agent/extensions/（见 extension-sync.ts），
 * 并随连接分发到远程/WSL（与 pipi-tree-nav 同机制）。
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("pipi-model-sync", {
    description: "Reload models.json/auth.json into the running session (pipi bridge)",
    handler: async (_args, ctx) => {
      try {
        const result = await ctx.modelRegistry.refresh({ allowNetwork: false });
        const failed = [...result.errors.keys()];
        if (failed.length > 0) {
          await ctx.ui.notify(`模型配置已重载，但部分 provider 刷新失败：${failed.join("、")}`, "warning");
        } else {
          await ctx.ui.notify("模型配置已重载，模型菜单可立即选用新配置", "info");
        }
      } catch (e) {
        await ctx.ui.notify(`模型配置重载失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
