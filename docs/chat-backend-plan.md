# 聊天视图原生接入 pi agent —— 实施计划

状态：已实施（2026-08-10）
目标：双后端架构——本地（Windows）tab 走 SDK 进程内（worker_thread），WSL/远程 tab 保持 `pi --mode rpc` 子进程。两个后端实现同一协议面（rpc.md 命令 + 事件），渲染层无感知。

## 0. 背景与实测数据

现状：每 tab spawn 一个完整 `pi --mode rpc` 子进程，JSONL 通信。聊天视图已消费大部分事件流（message_update / tool_execution_* / agent_* / compaction / auto_retry / extension_error / extension_ui_request），但：

| 差距 | 数据/证据 | 根因 |
|---|---|---|
| 速度：每 tab 冷启动 **~1900ms**（spawn→get_state 实测 3 次均值） | SDK 进程内：冷 330ms / 热 2ms（实测） | 进程边界：ModelRuntime / loader / settings 每 tab 重建 |
| 斜杠命令无补全/无列表 | 协议**已有 `get_commands`**，app 从未调用 | UI 层没消费协议能力 |
| Skill 零 UI | `get_commands` 返回 `skill:` 前缀条目 | 同上 |
| 扩展无清单/无诊断 | RPC 只有 `extension_error` 事件；SDK 有 `LoadExtensionsResult`（清单+errors） | 协议面窄 |
| `queue_update` / `turn_start` / `turn_end` 被丢弃 | chatStore.ts:510 注释显式忽略 | UI 层没消费 |
| `get_state` 的 steeringMode / followUpMode / autoCompactionEnabled 不展示 | — | UI 层没消费 |
| 树导航靠桥扩展 | RPC 无 `navigate_tree`，SDK 原生 `session.navigateTree()` | 协议缺能力 |

关键洞察（决定方案形态）：

1. **RPC 协议面 = SDK 会话能力的序列化形态**。`runRpcMode` 内部就是 `session.bindExtensions({ uiContext })` + 把扩展 UI 请求转成 `extension_ui_request` 帧；SDK 事件（message_update / tool_execution_* / agent_settled / queue_update）与 RPC 帧同构。因此"事件归一化"几乎是免费的：SDK backend 直接把 SDK 事件转发成 RPC 帧形状即可，**渲染层事件处理零改动**。
2. 双后端共享的接口**已经由 rpc.md 定义**（`get_state` / `get_commands` / `prompt` / `steer` / `abort` / `set_model` / `cycle_model` / `get_available_models` / `set_thinking_level` / `fork` / `new_session` / `switch_session` / `compact` / `set_session_name` / `get_session_stats` / `set_steering_mode` / `set_follow_up_mode` / `set_auto_compaction` / `set_auto_retry` …）。SDK backend = "进程内实现同一命令面 + 事件面"。
3. **WSL 保持 RPC**：SDK 在 Windows 侧跑、cwd 指向 `\\wsl$` UNC 时，bash 工具会拿到 Windows shell（cmd/powershell），工具语义错误。agent 必须跑在文件所在的操作系统。WSL 走 RPC = "WSL 内跑 pi"，语义天然正确。未来若想 WSL 也提速，可在 WSL 内做常驻 node host，但等价于 RPC 换壳，收益低，不在本计划内。

## 1. 目标与非目标

### 目标

- 本地 tab：首个会话创建 < 600ms（含 worker 启动），后续 < 50ms；无 pi 子进程
- 斜杠命令补全弹层、skill 列表、队列指示器、扩展面板（本地全量/远程降级）
- 扩展代码运行在 worker_thread（崩溃不拖垮 app，可自动重启）
- 渲染层（ChatPane / chatStore / 对话框）**不做后端感知重构**；事件流形状不变

### 非目标

- 不改 pi 上游协议（不 fork）
- 不把远程/WSL 改成 SDK（见洞察 3）
- 不做扩展热加载（v1 启动时 reload 一次）
- 不做每会话独立 worker（v1 单 worker 多会话；接口预留升级空间）

## 2. 总体架构

```
┌─ Renderer（不变，Phase 2 后仍走同一 IPC）────────────────────┐
│ ChatPane / chatStore / UiDialog / SlashMenu / SkillChips     │
│   └─ window.api.tab.rpcSend / onRpcEvent / rpcRequest        │
└──────────────┬───────────────────────────────────────────────┘
┌─ Main（index.ts）───────────────────────────────────────────┐
│ TabRegistry（pty.ts 现有 registerExternalTab 复用）           │
│ dispatch: tab:create → 本地? SdkHost.openSession            │
│                        : WSL/远程? RpcSession.createRpcTab   │
│ tab:rpc-send → SdkHost.handle  |  RpcSession.send           │
│ forwardEvent（同一通道广播 tab:rpc-event:{id}）               │
│ closeAllSessions → 两端一起关                                 │
├──────────────────────────────────────────────────────────────┤
│ SdkHost（manager）      │   RpcSession（现有，适配为 backend）│
│   spawn/respawn worker  │   spawn pi --mode rpc              │
│   tab↔sessionId 映射     │   JSONL 帧协议                     │
└──────────┬──────────────┴────────────────────────────────────┘
┌─ AgentWorker（worker_thread，仅本地）────────────────────────┐
│ ModelRuntime ×1（共享）                                       │
│ DefaultResourceLoader ×1（共享，含 extensions/skills/prompts）│
│ SettingsManager ×1                                           │
│ AgentSessionRuntime ×N（每 tab 一个，createAgentSessionFrom  │
│   Services；支持 newSession/switchSession/fork 替换）          │
│ bindExtensions({ uiContext }) —— UI 请求转 extension_ui_request│
│ 消息协议: {kind:"cmd", tabId, id, cmd} / {kind:"evt", tabId,   │
│   event} / {kind:"resp", id, data|error}                     │
└──────────────────────────────────────────────────────────────┘
```

要点：

- **SDK backend 是一个进程内"rpc.md 命令处理器"**：输入 rpc.md 命令对象 → 调对应 session API → 事件经映射层转 RPC 帧形状 → 走与 RpcSession 相同的 `forwardEvent` 路径。渲染层收 `tab:rpc-event:{id}` 的方式不变。
- **事件映射层极薄**：SDK 事件与 RPC 帧同构（同一核心产出），只需：合成 `state_ready`（用 get_state 数据）、补齐 `agent_settled` 语义（SDK 已有）、`get_session_stats` 响应（SDK 导出 SessionStats）、extension_ui_request（uiContext 桥，照抄 rpc-mode.js 的 createExtensionUIContext 模式）。
- **`navigateTree`**：SDK backend 原生 `session.navigateTree()`；RPC backend 保持现有 `/pipi-tree-nav` 命令桥。TreeDialog 无感知。
- **`pipi-tree-nav` / `pipi-static-indicator` 扩展保留**（远程/WSL 还要用；本地 SDK 模式不再需要但不影响）。

## 3. Phase 1：RPC 能力 UI 补齐（先行，两个后端通用）

> 原则：所有 UI 只通过"rpc.md 命令面"取数/触发，Phase 2 切换后端时零改动。

### P1-1 队列指示器 + turn 事件（chatStore）
- `src/renderer/src/stores/chatStore.ts`：放开 `queue_update`（新增 state：`steeringQueue: string[]` / `followUpQueue: string[]`，应用 `applyEvent`），`turn_start`/`turn_end` 记录最近 turn 状态（供 UI 展示"回合 N"）。
- ChatPane：agent 处理中若有队列消息，渲染"⏳ 排队中：…"气泡（样式复用 compaction 横幅）。
- 测试：`stores/__tests__/chatStore.test.ts` 增 queue_update 用例。

### P1-2 斜杠命令补全（SlashMenu）
- 新组件 `src/renderer/src/components/SlashMenu.tsx`：输入框输入 `/` 后弹出；数据源 `get_commands`；展示 `{name, description, source 徽标（extension/prompt/skill）}`；上下键 + Enter 补全（`/name` 插入输入框，不直接发送）；Esc/失焦关闭；输入 `/fix` 时按 name 前缀过滤。
- `src/renderer/src/panes/ChatPane.tsx`：`/` keydown 触发、候选渲染、补全写入。
- 数据获取：挂载/聚焦时拉取一次并缓存（命令集在会话生命周期内静态）。

### P1-3 渲染层 request/response 包装
- `src/preload/index.ts` + `src/renderer/src/global.d.ts`：`window.api.tab.rpcRequest(tabId, cmd)` → 发送带 `id` 的命令，监听对应 `response` 帧 resolve（复用 main 现有 request 机制，仅加渲染侧 promise 包装；15s 超时）。
- 供 SlashMenu / SkillChips / 对话框使用（现有代码仍可走原 onRpcEvent 特判路径，不强制迁移）。

### P1-4 skill 列表（SkillChips）
- 新组件 `src/renderer/src/components/SkillChips.tsx`：`get_commands` 中 `source === "skill"` 的条目渲染为 chips（侧边栏底部或输入框上方）；点击插入 `/skill:xxx` 到输入框。
- ChatPane 接线。

### P1-5 会话状态展示（ChatPane 会话菜单）
- **实现落点与计划差异**：原计划放在 ModelConfigDialog，实际改为 ChatPane 头部的「会话 ▾」菜单——steeringMode/followUpMode/autoCompactionEnabled 是**会话级**状态（get_state 按会话返回），而 ModelConfigDialog 是模型 CRUD 配置模块，两者职责不同。
- 菜单内容：steer 排队模式（all/one-at-a-time → `set_steering_mode`）、follow-up 排队模式（→ `set_follow_up_mode`）、自动压缩开关（→ `set_auto_compaction`）；乐观更新 + `get_state` 回读确认（复用思考级别菜单的既有模式）。
- 状态来源：`get_state` 响应（渲染层已有处理器）扩展补齐三个字段；挂载时若缺失则主动补拉一次 get_state（覆盖创建握手与订阅的竞态）。

### P1-6 扩展可用性提示
- 聊天页通知条扩展：`get_commands` 中 `source === "extension"` 计数 + `extension_error` 事件 → "N 个扩展已加载 / 扩展异常"（完整面板留给 Phase 2）。

**Phase 1 验收**：本地/WSL/远程 tab 均可用斜杠补全（含 `skill:` 条目）；发送中再输入消息出现排队指示；对话框可切 steering/followUp/autoCompaction；零协议改动、零后端改动。

## 4. Phase 2：双后端 + AgentWorker

### P2-0 Spike（先行验证，独立脚本）
- 在 worker_thread 中跑 `ModelRuntime.create()` + `DefaultResourceLoader` + `createAgentSession` + `session.prompt` + 事件订阅 + `bindExtensions({uiContext})`（uiContext 实现仅收集请求，验证 extension_ui_request 桥可复刻）。
- 验证 Electron main 环境（electron-vite 构建下）worker 内可 require 纯 node 包。
- 产出：可用性结论 + 事件形状 diff（SDK 事件 vs RPC 帧，列出所有字段差异）。

### P2-1 BackendSession 接口
- 新文件 `src/main/chat-backend/types.ts`：`BackendSession` 接口 = rpc.md 命令面方法集（`handle(cmd): Promise<ResponseData>`）+ `onEvent(cb)` + `onUiRequest(cb)` + `kill()` + `onExit(cb)` + `getSessionFile()`。
- `RpcSession`（rpc-session.ts）适配该接口（方法薄封装，行为不变）。

### P2-2 AgentWorker（worker 入口）
- 新文件 `src/main/chat-backend/sdk-worker.ts`：
  - 启动：`ModelRuntime.create()` → `DefaultResourceLoader`（cwd/agentDir 来自 host）→ `reload()` → `SettingsManager.create()`。
  - 每 tab：`createAgentSessionServices({cwd})` + `createAgentSessionFromServices(...)` + `SessionManager.create/open/continueRecent(cwd)`（照 SDK 文档 runtime 工厂模式，支持 `newSession`/`switchSession`/`fork` 后替换 session 并重新 `bindExtensions`）。
  - 命令处理器：rpc.md 命令 → session API 映射（`prompt` 含 images/streamingBehavior；`get_commands` 由 loader.getPrompts + 扩展注册命令 + loader.getSkills 组装，形状与 rpc.md 一致）。
  - 事件转发：`session.subscribe` → 映射为 RPC 帧形状 → `postMessage({kind:"evt", tabId, event})`。
  - `bindExtensions({ uiContext })`：uiContext 实现照抄 rpc-mode.js `createExtensionUIContext()`（select/confirm/input/editor + fire-and-forget），输出 `extension_ui_request` 帧。
  - `get_commands` 之外新增扩展元数据：`{kind:"cmd", cmd:"get_extensions"}` 返回 `LoadExtensionsResult`（extensions + errors）——SDK 侧专属，RPC 侧降级为 get_commands 派生。

### P2-3 SdkHost（main 侧 manager）
- 新文件 `src/main/chat-backend/sdk-host.ts`：
  - 懒启动：首个本地 tab 才 spawn worker（避免 app 启动即付 330ms）。
  - tab↔sessionId 映射、命令路由（`tab:rpc-send` 按 mode 分发）、事件/UI 请求转发（复用 `forwardEvent` 通道）。
  - 崩溃恢复：worker `exit`（非预期）→ 标记该 worker 的 tab 为错误态（横幅"agent 工作进程已重启"）→ 自动 respawn 空 worker；会话都在磁盘（sessionFile 已 link），用户重开会话即恢复。
  - `closeAllSessions` 参与 app 退出。

### P2-4 main 接线（index.ts / rpc-session.ts）
- `tab:create`：`opts.remote || 平台为 WSL → RpcSession`；本地 Windows → `SdkHost.openSession({cwd, sessionPath?|continueRecent})`。
- `emitTabs()`：tab mode 增 `"sdk"`；标题/session 链接复用 `linkTabSession`（从 rpc-session.ts 抽到共享模块，或 SdkHost 复用现有导出）。
- `tab:rpc-switch-terminal`：SDK 模式暂不支持切到 pty TUI（本地 tab 的终端视图=Windows shell，语义不同）——UI 上隐藏该按钮（或保留创建独立 shell tab 路径，不做切换）。
- 回退开关：settings.json `"pipi.backend": "rpc"` 或 env `PIPI_SDK_BACKEND=0` → 全部走 RPC。

### P2-5 扩展面板
- 新文件 `src/renderer/src/panes/ExtensionsView.tsx` + IPC `tab:rpc-extensions`：
  - SDK backend：`get_extensions`（名称、路径、加载错误、注册命令）。
  - RPC backend：`get_commands` 的 extension 条目 + 会话内 `extension_error` 事件聚合（降级视图）。
- SidebarPane 入口。

### P2-6 依赖与打包
- `package.json` 增 `@earendil-works/pi-coding-agent`（版本锁定；纯 JS 无原生模块，可进 asar）。
- 验证 electron-vite build 产物中 worker 入口可被 `new Worker(new URL(...))` 正确加载（`?module` / node 条件导出）。
- 双后端事件一致性测试：`src/main/chat-backend/__tests__/`——同一 prompt 分别走 SDK backend（进程内）与 RPC backend（spawn），规范化事件流 diff，断言形状一致（不比较时序）。

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SDK 在 worker_thread 不可用（环境假设） | 高 | P2-0 spike 先行；不可用则退化为 main 进程直跑（隔离降级，功能不变） |
| SDK 事件与 RPC 帧存在字段差异 | 中 | P2-0 产出形状 diff；映射层集中处理；一致性测试守护 |
| worker 内多会话并发（LLM 请求并发、共享 loader） | 中 | 每会话独立 Agent 实例；loader/settings 只读共享；spike 中验证并发 prompt |
| 扩展崩溃 worker | 中 | respawn + 横幅；会话在磁盘可恢复 |
| Electron 打包 worker 入口 | 低 | P2-6 验证；electron-vite 有现成 worker 支持 |
| `get_commands` 在 RPC/WSL/远程的行为差异 | 低 | 协议定义一致；Phase 1 验收覆盖三种 backend |

## 6. 任务顺序与里程碑

1. **M1（Phase 1 全部）**：P1-1..P1-6 —— 纯 UI + 协议消费，风险低，立即可交付。
2. **M2（Spike）**：P2-0 —— 决定 worker 可行性，产出事件形状 diff。
3. **M3（双后端）**：P2-1..P2-4 —— 后端切换，本地 tab 提速。
4. **M4**：P2-5 扩展面板 + P2-6 依赖/打包/一致性测试。

## 7. 验收标准（总）

- [ ] 本地 tab 创建后任务管理器无 `pi`/`cli.js` 子进程；首个会话 < 600ms 就绪，后续 < 50ms
- [ ] 斜杠补全、skill chips、队列指示器在本地（SDK）/WSL/远程（RPC）三端行为一致
- [ ] 扩展面板（本地）显示全部扩展 + 加载错误；扩展抛错时出现 `extension_error` 横幅且 app 不崩
- [ ] 手动 kill worker（调试手段）后 app 存活，横幅提示，重开会话恢复
- [ ] 设置 `PIPI_SDK_BACKEND=0` 后行为与今日完全一致（回退路径）
- [ ] 双后端事件一致性测试通过；`npm run typecheck` / `npm test` 全绿

## 8. 实施记录（2026-08-10 落地）

### M2 Spike 结论
- **worker_thread 内 SDK 完全可用**：`ModelRuntime.create()` 28ms / 会话冷 3ms / 热 <1ms（spike 脚本 `scripts/sdk-worker-spike.mjs`）。
- **runRpcMode 可完整复用**：伪造 stdin/stdout 后 `runRpcMode(runtime)` 全命令面正常工作（`scripts/sdk-rpc-spike.mjs`）。最终实现未采用（多会话需自实现命令循环），但该 spike 验证了 32 命令映射与上游逐行一致。
- **import 成本是主导**：`@earendil-works/pi-coding-agent` import ~1.1s（rpc-mode 501ms + index 648ms）——必须单 worker 共享，否则每 tab 都要付。

### M3 落地（实际实现）
| 文件 | 说明 |
|---|---|
| `src/main/chat-backend/sdk-worker.ts` | worker：共享 ModelRuntime（一次）；每 tab `AgentSessionRuntime`（`createAgentSessionRuntime` + 动态 import SDK，因 undici polyfill 需先于 SDK 执行）；32 命令分发（镜像上游 rpc-mode.js handleCommand）；`toJsonEvent` 内联；`bindExtensions` UI 桥（select/confirm/input/editor/notify/setStatus/setTitle/set_editor_text/setWidget）；open 期间 close 用 tombstone 防泄漏 |
| `src/main/chat-backend/sdk-host.ts` | main 侧：单 worker 管理；`send/request/onExit` 表面与 RpcSession 同形；request id 关联；crash → flush pending + 通知 `tab:rpc-exit` + respawn；`prewarmSdkWorker()` 后台预热 |
| `src/main/chat-backend/pi-agent-sdk.d.ts` | ambient 声明（包内 .d.ts 的 `.ts` 后缀 specifier 在 composite tsconfig 下解析失败） |
| `src/main/index.ts` | 本地 tab → `openSdkSession`；WSL/远程 → `createRpcTab`；`PIPI_SDK_BACKEND=0` / `pipi.backend:"rpc"` 回退；`tab:rpc-send/alive/close/ui-response` 按 tab 分发；`emitTabs/tab:list` 含 sdk mode；quit 双后端齐关 |
| `electron.vite.config.ts` | `sdk-worker` 第二 main 入口；`@earendil-works/pi-coding-agent` external |
| renderer | `mode: "sdk"` 类型扩展；ChatView 渲染 sdk tab；ChatPane 隐藏「终端视图」（无 pty 可切） |

### 实测数据
- **本地 tab 冷（含 SDK import）**：~1.3-1.9s（预热后首 tab ~1.5s）
- **本地 tab 热（第二 tab 起）**：**~9ms**（vs 原 RPC 每 tab 1.9s，~200 倍）
- **真实 agent 对话**（SDK 后端）：prompt → 事件流 → agent_settled 全通（`scripts/chat-sdk-smoke.mjs` PASS）
- **扩展/skills 一致**：get_commands 返回 6 扩展 + 7 skills，与 RPC 后端一致（`scripts/sdk-real-probe.mjs`）
- **回退**：`PIPI_SDK_BACKEND=0` 走 RPC，行为不变（`chat-smoke.mjs` PASS）

### 关键坑（已解决）
1. **undici 8.x × Electron worker**：`webidl.util.markAsUncloneable` 在 Node 20（Electron 34）的 worker 里是 undefined（Node 22 才有）→ `new CacheStorage()` 崩溃。解法：worker 顶部 `createRequire` 补 `markAsUncloneable`，且 SDK 用**动态 import**（ESM 静态 import 会先求值 SDK）。
2. **ESM 静态提升**：polyfill 必须在 import SDK 之前跑 → SDK 全部改为 `await import(...)`。
3. **`createAgentSessionServices` 不认 `resourceLoader` key**：共享 loader 是死代码；改为只共享 ModelRuntime，services 自建 per-cwd loader（项目级 skills/settings 语义正确）。

### Slash「全面一致」（本轮追加）
- 22 个 builtin 全部列出（镜像上游 `slash-commands.js`），按原生顺序 + 分组标题（Pi 内建 / Skills / Prompt Templates / Extensions）。
- 聊天视图可用（supportedInChat）：settings→模型配置对话框、model→模型选择器、export→export_html、copy→剪贴板、name→会话名、session→统计、fork→会话树、clone→克隆、tree→会话树、new→新会话、compact→压缩、resume→会话树导航、reload→SDK reload（RPC 提示不支持）。
- 仅 TUI（disabled 标注）：scoped-models/import/share/changelog/hotkeys/trust/login/logout/quit。
- 验证：`scripts/chat-slash-smoke.mjs` PASS（分组 + 22 项 + disabled 标记）。

### 遗留
- M4 扩展面板（P2-5）未做：SDK 后端可经 `get_extensions` 暴露 LoadExtensionsResult，RPC 降级。
- worker 崩溃后重开会话恢复路径已就绪（tab:rpc-exit → 用户重开），但未做「自动 respawn 后静默恢复」。
- 双后端事件一致性自动化测试（P2-6）未写；当前靠 spike/smoke 脚本人工验证。

### 修复：SDK 模式不再要求系统 pi（2026-08-10 追加）
用户反馈"没有检测到系统的 pi agent"——`tab:create` 对本地 tab 无条件调用 `ensurePiReady()`，它检查**系统全局 pi**（`hasGlobalPiInstalled` → `findPiBin` + `pi --version`）。SDK 后端在 app 的 worker_thread 内运行项目依赖 `@earendil-works/pi-coding-agent`，**不依赖系统 pi 二进制**，因此该检测错误拦截。

修复（`src/main/index.ts` `tab:create`）：
- SDK 模式（本地 + 未禁用）**跳过 ensurePiReady**——不弹"未检测到 pi agent"安装对话框。
- RPC 模式（`PIPI_SDK_BACKEND=0` / `pipi.backend:"rpc"`）和远程/WSL tab 保持原有检测（它们确实需要 shell 到 pi）。
- 兜底：worker 启动/import 失败时，`opened` 带 error → markExited → renderer 显示"pi 已退出"。

### 修复：打开会话报 "Cannot read properties of undefined (reading 'fg')"（2026-08-10）
用户反馈打开会话 5s 后报错。排查发现两层问题：

1. **扩展 theme 崩溃**：`pi-rewind` 等扩展在 `session_start` 调用 `ctx.ui.theme.fg(...)`。worker 的 `createExtensionUIContext` 缺 `get theme()`，导致 `theme` 为 undefined。RPC 模式不崩是因为 `main.js` 先调 `initTheme()` 且 rpc-mode 的 uiContext 有 theme getter。
   - 修复（sdk-worker.ts）：uiContext 补 `get theme()`（从 `globalThis[Symbol.for(...)]` 读 initTheme 存入的实例 + 兜底 proxy）；`ensureSharedInfra` 里调 `initTheme(settings.getTheme())`；补齐 `getAllThemes/getTheme/setTheme/getToolsExpanded/addAutocompleteProvider/setEditorComponent/getEditorComponent`（对齐上游 rpc-mode.js 完整 surface）。

2. **SDK 快速响应暴露历史加载竞态**：RPC 模式 worker 慢（1.9s）> renderer 订阅建立时间，所以 mount 后发 get_messages 必达；SDK 模式 worker 快（~50ms），mount 时的 get_messages 在**会话注册前**发出 → worker 返回 "Tab session not found" → 该 error 响应被 `initMessages` 当空历史消费 → `historyLoaded=true` → 后续 ready 信号不再补发 → 历史永空。
   - 修复：
     - sdk-host.ts：opened 后 forward `state_ready` 合成事件 + get_state 响应（对齐 createRpcTab 握手）。
     - ChatPane.tsx：`get_messages` 仅 success 才 initMessages（error 不置 historyLoaded）；`get_state` 响应到达时若 historyLoaded 未置则补发 get_messages；mount 无条件补发（去掉 active 守卫）。
     - chatStore.ts：新增 `historyLoaded` 字段 + `markHistoryLoading` action。

验证：`scripts/chat-open-session-smoke.mjs` 打开已有会话（sessionPath）→ msgs=60、无错误横幅；`scripts/chat-sdk-smoke.mjs` 新会话发消息 PASS。

### 性能优化：打开会话提速（2026-08-11）
用户反馈"打开会话还是需要 5s"。分阶段实测定位并优化：

**实测数据（worker 直测，真实 agentDir）**
- 冷启动（无预热）：SDK import 1.1s → opened 1.49s
- 预热后（启动 5s 后才打开）：open→opened 仅 0.34s
- 打开已有会话（预热后）：total=323ms = infra 0ms + session 24ms(JSONL 索引) + runtime-services 299ms(资源加载) + bind-queued 0ms

**三处优化**
1. **真实基础设施预热（P1）**：`prewarmSdkWorker(agentDir)` 现在向 worker 发 `{ kind: "warm" }`，后台执行 `ensureSharedInfra`（ModelRuntime.create + refresh + SettingsManager + initTheme），而非仅 spawn worker。省约 1.1s。
2. **扩展绑定后台化（P2）**：openTab 里 `rebindSession`（bindExtensions + session_start + resources_discover）从 opened 之前移到 opened 之后异步执行；事件订阅改为在 bind 之前同步建立（不再丢 session_start 帧）。opened 不再被扩展加载阻塞。
3. **分段耗时日志**：`[sdk/open] total/infra/session/runtime-services/bind-queued` 各阶段毫秒级输出，后续可定位具体瓶颈。

**安全性验证**
- opened 后立即 prompt 可用（accepted=true），agent 正常跑完（扩展绑定不阻塞 prompt，agent 在运行时才发现工具）
- 打开已有会话 GUI 冒烟：msgs=60、无错误横幅
- bind 失败只发 extension_error 事件，不会影响会话

**后续候选（按数据驱动）**
- runtime-services 299ms 是当前唯一大头（资源加载），可考虑按 cwd 缓存 skills/prompts/themes 扫描结果
- 大 JSONL 会话的旁路索引缓存（session=24ms 已很快，暂不需要）

### 修复：远程/WSL tab 误报"未检测到 pi agent"（2026-08-11）
**症状**：本地 SDK 模式启用后（不再需要本地 pi 二进制），打开远程/WSL tab 仍弹"未检测到 pi agent"。

**根因**：`tab:create` 里 pi 检测条件过宽——原 `if (!sdkLocal)` 对所有非 SDK 本地 tab（含远程/WSL）调用 `ensurePiReady()`，而它检查的是**本机** pi。实际架构：
- 本地 SDK：pi 在 app 进程内 worker_thread 运行 → 不需要本地 pi
- WSL：`wsl.exe … bash -ic "pi --mode rpc"` → pi 在 distro 内运行
- 远程：`ssh … bash -ic "pi --mode rpc"` → pi 在远端运行
- **本地 RPC fallback**（`PIPI_SDK_BACKEND=0` / `pipi.backend=rpc`）→ 唯一 shell 到本地 pi 的场景

**修复**：检测条件从 `!sdkLocal` 收紧为 `localRpcFallback = !opts.remote && !opts.wsl && !sdkBackendEnabled()`。

**验证**：WSL Ubuntu-22.04 端到端冒烟（create→boot→prompt→settle）通过，全程无本地 pi 检测弹窗；105 单测全绿。

## 9. 方向调整：默认终端形式（2026-08-11）

用户决定：**新 tab 默认终端（pty TUI），聊天视图降级为可选功能**（TabBar「聊天视图」按钮）。原因：聊天视图（无论 RPC 还是 SDK 后端）仍无法稳定"原生接入" pi agent，终端形式是更可靠的主路径。

改动：
- `tab:create` 不再分发 SDK/RPC——所有 pi tab（本地/WSL/远程）一律 `createTab`（pty TUI）；本地 tab 重新启用 `ensurePiReady`（pty TUI 需要系统 pi 二进制）。
- `tab:rpc-switch-chat`：本地 pty tab → `switchTerminalToSdk`（进程内，热切换 ~9ms）；WSL/远程 → `switchTerminalToRpc`（`pi --mode rpc`）。`PIPI_SDK_BACKEND=0` 时本地也走 RPC。
- 新增 `switchTerminalToSdk` / `switchSdkToTerminal`（sdk-host.ts）：pty↔SDK 双向切换，同 tab id 语义与 RPC 切换一致。
- ChatPane「终端视图」按钮对 SDK tab 也可见（此前隐藏）——SDK 聊天 tab 可切回终端。
- 渲染层乐观 mode 全部改为 `"pty"`（tabsStore / sessionsStore）；TabBar「聊天视图」按钮仅对 pty pi tab 显示。
- SDK worker 仍在启动时后台预热（prewarmSdkWorker），切聊天时零等待。

验收：`npm run typecheck` / `npm test` 全绿（105 单测）。
