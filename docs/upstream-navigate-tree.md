# 上游 PR 参考：为 `pi --mode rpc` 添加原生 `navigate_tree` 命令

> Fire-and-forget 提案。合入前本 app 的远程/WSL 聊天树导航继续走
> `pipi-tree-nav` 扩展桥（扩展已随 app 分发到远程/WSL agent 目录），
> 本地 SDK 路径已用 sdk-worker.ts 里的同款 `navigate_tree` case。
> 上游合入后三端统一，扩展桥退役。**此文件不参与构建，仅作提交参考。**

## 动机

RPC 协议目前只有**只读**的 `get_entries` / `get_tree`（pi 0.80.3+）。
导航（TUI `/tree` 的"导航到某一点"）只能通过扩展 `ctx.navigateTree`
（`commandContextActions.navigateTree`）间接实现——客户端必须自备扩展
并把它部署到运行 pi 的机器上，失败时导航命令会静默退化成一条普通
LLM prompt。把 `navigateTree()` 暴露为原生 RPC 命令后：

- 客户端一行 `{"type":"navigate_tree","entryId":...}` 即可静默导航，
  不进入 prompt 通道、不产生用户消息、不触发 agent turn（与
  `AgentSession.navigateTree` 语义一致，即 TUI `/tree` 导航的等价操作）。
- `get_tree` / `get_entries` 的 `leafId` 会反映新位置，客户端可据此刷新。

## 改动 1：`src/modes/rpc/rpc-mode.ts` 的 `handleCommand` switch

在 `get_tree` case 之后新增（参考本仓库 sdk-worker.ts 中已验证的实现，
仅把 `as boolean | undefined` 等 TS 断言去掉）：

```ts
case "navigate_tree": {
    const entryId = command.entryId;
    if (!entryId) {
        return error(id, "navigate_tree", "entryId is required");
    }
    try {
        const result = await session.navigateTree(entryId, {
            summarize: command.summarize,
            customInstructions: command.customInstructions,
            replaceInstructions: command.replaceInstructions,
            label: command.label,
        });
        return success(id, "navigate_tree", result);
    } catch (e) {
        return error(id, "navigate_tree", e instanceof Error ? e.message : String(e));
    }
}
```

要点：

- `session.navigateTree` 是 `AgentSession` 的公开方法（`dist/core/agent-session.d.ts`
  有声明），与扩展桥 `ctx.navigateTree` 走同一条内部实现；RPC 模式启动时
  `bindExtensions` 已把 `commandContextActions.navigateTree` 绑定到它。
- `summarize` 为 true 时会触发一次模型调用（分支摘要），耗时较长；
  客户端应自行给 `navigate_tree` 设长超时（app 用 180s）。
- 导航期间可能触发扩展的 `session_before_tree` 拦截（如 pi-rewind 的
  "Restore Options"），会弹扩展 UI 对话框——客户端需能应答 `extension_ui_request`。

## 改动 2：`docs/rpc.md` 新增命令文档

```markdown
#### navigate_tree

Navigate to a different point in the session tree (the RPC equivalent of the
TUI /tree navigate action and the extension `ctx.navigateTree`). It is a
silent session operation: nothing is recorded as a user message and no agent
turn is started — the session just lands at the target and waits for input.

```json
{"type": "navigate_tree", "entryId": "abc123"}
```

Optional: `summarize` (generate a branch summary of the abandoned path —
runs a model call, expect a slow response), `customInstructions` (override
the summary prompt), `replaceInstructions` (replace instead of append), and
`label` (set a label on the target entry).

Response:

```json
{
  "type": "response",
  "command": "navigate_tree",
  "success": true,
  "data": {"cancelled": false}
}
```

`data.cancelled` is true when an extension's `session_before_tree` hook
cancelled the navigation. After a successful navigation, re-fetch with
`get_tree` or `get_entries` — their `leafId` reflects the new position.
```

## 改动 3（建议）：协议测试

`src/modes/rpc/__tests__` 下加一个与 `get_tree` 同级的用例：打开一个
含多分支的会话 → `navigate_tree` 到旧分支某 entry → `get_entries` 的
`leafId` 变为目标 → `navigate_tree` 指向不存在的 id → `success:false`。

## 兼容性

纯新增命令，不影响既有 RPC 客户端。远程/本地 pi 版本 >= 合入版本后，
app 可将 TreeDialog 的导航从 `/pipi-tree-nav` 扩展桥切换为原生命令
（`sdk-worker.ts` 的 `navigate_tree` case 已是同款语义，可作迁移模板）。
