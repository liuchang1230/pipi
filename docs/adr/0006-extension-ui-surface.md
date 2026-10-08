# ADR 0006：扩展界面面（pi 原生 UI 声明的家）

Status: **accepted**（2026-10-04）　实施：已落地（本文件末「实施状态」）

## 动机

`ctx.ui` 上的三条「即发即忘」声明——`setStatus` / `setWidget` / `setTitle`——是扩展在聊天视图里唯一的界面出口（`setWorkingIndicator` 之类要么结构性收不到，要么另有归属，见决策 1）。它们在我们的聊天视图里**根本没有家**，而且是三重丢失，各自都能单独让扩展白干：

**一、它们被当成一次性事件转发，而唯一的接收者半时间不在场。** 两条后端的 `extension_ui_request` 都汇聚到 `forwardUiRequest`（`src/main/index.ts:1156`），原先无条件 `win.webContents.send('tab:rpc-ui-request:' + tabId, req)`；而消费它的只有 ChatView 里那个订阅（`src/renderer/src/panes/ChatPane.tsx:1416`）。ChatView 在 tab 切到终端视图时卸载、pi 还没起完时卸载；更要命的是**开 tab 的首帧必丢**——`tab:create` 是先建后端再发 tab 列表的（`src/main/index.ts`），所以 `session_start` 里扩展声明的 status 发出时，渲染层还不知道这个 tab 存在。帧是**一次性**的：pi 不重发，`get_state` 的 13 个字段里也没有它们（渲染层只读其中 6 个）。丢了就是永久丢。

**二、就算收到了，渲染层也是把它们扔掉的。** `src/renderer/src/dialogs/UiDialog.tsx` 的 `handleFireAndForget` 里，这三个方法命中一个空分支：

```ts
if (req.method === "setStatus" || req.method === "setWidget" || req.method === "setTitle" || ...) {
  return true; // M2: displayed by chat UI in later milestones
}
```

而 ChatPane 的契约是「返回 true = 我已消化，不要弹对话框」（`if (!consumed)` 才渲染 `<UiDialog>`）。于是这三个方法**连同一个调试日志都没有**就被吃掉了——最坏的一种降级：扩展以为自己声明了，用户什么都没看到，日志也没有。

**三、两台后端发的是不同的形状。** 远程后端是用户自己的 `pi --mode rpc`，字段名自然是上游的 `widgetKey` / `widgetLines` / `widgetPlacement`；本地 SDK worker（`src/main/chat-backend/sdk-worker.ts`）却自己拼了 `widgetContent` 并把 placement 展平在顶层（`...(options ?? {})`）。同一台扩展，本地 tab 的 widget 到远程后一半字段是 `undefined`，`setWidget` 于是静默无效。字段名错位不是「少一个功能」，是**同一个动作在两台后端上行为不同**，而我们没有一处能拦住它。

**顺带记一条不属于本 ADR 的缺陷**（故意不折进来）：`sessionName` 在界面上**没有任何可见元素**——它只出现在模型按钮的 `title`（`ChatPane.tsx:2325`）和导出文件名（`1855`、`1915`）里。会话名对用户是可感知身份，却看不见；但它的来源是 `get_state`（不是扩展），修法与本 ADR 无关。

## 决策

**给 pi 的原生 UI 声明**一个**面**（surface）：一个按 tab 存活的、形状由 shared 独占定义、权威状态住主进程的模块；声明到达时被**累积**而不是被转发；渲染层只做它的镜像与观看。具体：

1. **只接 4 个成员**：`setStatus` / `setWidget` / `setTitle` / `set_editor_text`。**`setWorkingIndicator` 不接**（撤回）。撤回理由：远程/WSL 的 chat→终端切换是**真的在 pty 里跑一个 TUI**（`switchRpcToTerminal`），那里 `setWorkingIndicator` 本来就生效；聊天视图里的转圈是我们自己的 DOM/CSS，没有闪烁可言。给它做一条搬运通道，价值约等于 0，代价是在 pi 自己的 TUI footer 里多一个 `●` chip。`src/main/extensions/pipi-static-indicator.ts`（把 spinner 换成单帧静态点的防闪烁扩展）因此**一个字没动**——它服务的是终端视图，那里它是对的。
   其余 9 个成员 + 3 个组件工厂进**降级名单**（`shared/extension-ui.ts` 的 `DEGRADED_UI_MEMBERS`，带 `why`）：`setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` / `setFooter` / `setHeader` / `custom` / `getEditorText`（上游返回空串）/ `onTerminalInput`（上游注释写着 need TUI access，rpc 不传输——远程后端就是用户自己的 pi 二进制，我们从外部补不上），加 `addAutocompleteProvider` / `setEditorComponent` / `getEditorComponent`（TUI 组件工厂是函数，跨 JSON seam 送不过去）。

2. **形状住 shared，权威状态住 main，判定与观看分开。** `src/shared/extension-ui.ts` 定义 `ExtensionUiSurface`（status 表 + widget 表 + title）与帧形状；`src/main/extension-ui.ts` 是权威状态（按 tab 的 `{surface, seq}`，附件式的 `observeUiRequest` / `clearUiSurface` / `forgetUiSurface` / `getUiSurface`）；`src/renderer/src/stores/extensionUiStore.ts` 是镜像；`src/renderer/src/stores/extension-ui-view.ts` 是纯函数观看规则（可测、无 DOM）。**权威住 main 的三个理由**：(a) 首帧必丢（动机一）只有把状态放在不会被卸载的那一层才解掉；(b) 它是 pi 永不重发的一次性帧的**唯一缓存**；(c) 会话身份变更全都经过 `tab:rpc-send` 这**一个**漏斗（`index.ts:2115`），清理规则因此只需实现一次，两台后端共用。

3. **面挂在 tab 的寿命上，不挂在视图的 mount 上。** `TerminalPane`（唯一知道哪些 tab 活着的地方，`TerminalPane.tsx:266`）用它的 tab 列表驱动 `extensionUiStore.syncAttached(ids)`：新 tab 订阅**然后**拉一次 `tab:rpc-ui-snapshot`，消失的 tab 退订并清掉镜像。`seq` 保证迟到的快照不会把面回滚（快照在途时来了增量，旧的那个被丢）。被退回的方案：`tabsStore` 持有 `window.api` 订阅（数据 store 不该持有窗口订阅）、由 ChatView mount 驱动（就是动机一那个 bug 本身）。

4. **清理规则（谁让面失效）**：会话身份变更 **5** 条命令（`new_session` / `switch_session` / `fork` / `clone` / `reload`，`SESSION_IDENTITY_COMMANDS`）→ 在 `tab:rpc-send` 的漏斗里清；视图切换 chat↔终端 → 在两个 switch handler 里清（那是另一个 pi 进程，它的声明我们看不见）；pi 退出 → 两条后端各自的退出点清；tab 关闭 → 连 `seq` 一起忘掉（同一个 tabId 复用不能继承旧面）。**不在 `state_ready` 上清**（那是快照，不是新会话）；**不在 `set_session_name` 上清**（改名是同一个会话，扩展的声明仍然成立）；**不在 `navigate_tree` 上清**——它在初稿里，评审时删掉了：上游 `navigateTree` 只发 `session_tree`、不重绑扩展 runner（`core/agent-session.js:2617-2624`），所以声明它的扩展还是同一个实例。清掉就是永久丢失（帧是一次性的，pi 不会重发），而远程后端走 `/pipi-tree-nav` 提示词到达同一个 `navigateTree`、从来不清——同一动作两台后端不一致。判据最终定成：**这条命令是否让 pi 重绑扩展 runner**（SDK 侧就是 `sdk-worker.ts` 里真的调 `rebindSession` 的那几条）。`/reload` 会发 `session_shutdown{reason:"reload"}` 再发 `session_start{reason:"reload"}`（上游 `core/agent-session.js:2217-2237`），所以清完新实例会重新声明——清空不是丢状态，是拒绝让上一个会话的声明冒充当前的。

5. **落点**：
   - `setTitle` → `chat-header` **左侧**组里一个新元素，**非空才渲染**，`title` = 全文。左组全是只读信息，右组全是动作按钮——一个只读文本放进按钮堆里会被当成可点的。
   - `status` → **`chat-input-bar` 里紧跟 `chat-input-stats`（`↑… ↓… · 缓存… · 26.5%`）之后，同一行**（`ExtensionStatusChips`）。理由：两者都是**本会话的事实**，一行读完才对（用户反馈：「◆ 3 checkpoints」应该排在用量后面）；单独占 composer 上方一行时，它看起来像一条**没人发过的消息**。这一行**不换行**（换行会把发送按钮挤下去）：整个状态组 `flex: 0 1 auto; max-width: 34%`，单个 status 超出省略，`title` 给全文。
   - widget → `aboveEditor` 的在 composer 上方（`SkillChips` 之后）、`belowEditor` 的在 `chat-input-bar` 下方；区域左边一条竖线（`.chat-ext-zone` 的 `border-left`），是「扩展声明的」与「pi 自己说的」的唯一视觉区分。status 不进这个区域（它是单行小字，不是块）。
   - widget 的行数上限 **10**（对齐 pi 自己的 `InteractiveMode.MAX_WIDGET_LINES = 10`），但**不丢信息**：超出的行用「展开全部（还有 N 行）」看到。pi 自己的做法是渲染一行 `... (widget truncated)` 然后丢掉——我们保留。但“保留”也得有界：展开最多再给 `WIDGET_REST_MAX = 200` 行，再多就在区域里直接写「另有 N 行未显示」——widget 来自扩展，即来自我们没写过的代码，一次坏循环不该变成几千个 DOM 节点，而且截断要看得见（不是静默丢）。
   - status 文本单行截断（80 字符），`title` 里是全文；空串与纯空白视为「扩展声明了但为空」，不画（扩展清 status 的常见写法就是设 `""`）。

9. **扩展写的文本进 DOM 前先剥 ANSI。** 扩展是按 TUI 写的：`ctx.ui.theme.fg("dim", …)` 给出的是带 SGR 转义序列的字符串，pi 的终端把它渲染成颜色，DOM 没有终端——原样上屏就是用户报的那串乱码（输入框上方：`[38;5;241m◆ [39m[38;5;244m3 checkpoints[39m`）。剥的位置是**进 DOM 的两个口**：面的观看规则（`extension-ui-view.ts`：status / widget 行 / title，且**剥完再判空**——一个纯颜色的 status 等于「声明了但为空」，不画）与对话框（`UiDialog.tsx`：notify 文案、标题、confirm 文案、select 选项**显示**值）。工具函数 `stripAnsi` 住 `src/shared/ansi.ts`。两条边界：(a) **只改显示，不改数据**——权威面与镜像里存的是 pi 声明的原文（排查「扩展到底声明了什么」看的是原文），select 选项**回传**给 pi 的也是原值（pi 拿它做等值匹配）；(b) **颜色不复原**：我们的调色板不是 pi 的 TUI 调色板，把 256 色硬译成 CSS 只会猜错，这里只保证没有控制字符漏进 DOM。

6. **`set_editor_text` 与 `restoreInput` 同款守卫**：只在输入框**为空**时填入；非空则保留草稿，在输入栏留一条可点的提示（「扩展提供了输入内容，未覆盖你的草稿」+ 替换/忽略）。一个输入框只有一份契约——`chatStore.restoreInput` 早就拒绝覆盖非空草稿（`ChatPane.tsx:1794`），扩展这条路不能更粗暴。

7. **未知/未来的方法：消化 + 记日志**，不再落到 `return false`。返回 false 会让 `<UiDialog>` 试图把一个不提问的帧画成提问（空对话框）。`handleFireAndForget` 现在只管两件事（`notify` → toast、`set_editor_text` → 受守卫的输入框），对话框四件（select/confirm/input/editor）显式返回 false 交给 UiDialog，其余一律 `window.api.debug.log(..., "warn")` 后消化。

8. **降级要能被看见。** 名单在 `shared/extension-ui.ts` 里（带 `why`，免得下次评审再提「也接上吧」），分发扩展的 pi 表面清单 `src/main/extensions/pi-api-stub.d.ts` 标注降级成员，worker 的降级桩每成员每进程各发一条 `{kind:"log"}` 帧到主进程 debug log（`sdk-host.ts` 转 `debugLog`）。worker 自己够不着 app 的日志文件——以前它的空函数连一行都不留。**降级成员必须真的是 no-op，不能是缺成员**：上游 `ExtensionRunner.setUIContext` 只做 `{...ui, 几个提示词包装}`（`core/extensions/runner.js:270-282`），**不会**用 `noOpUIContext` 补齐缺的键；缺一个键 = 扩展回调在那里抛异常，而 `runner.js` 是按 handler 捕获的，于是同一个 handler 里它后面的 `setStatus` 根本不执行（本地 tab 坏、远程 tab 只是安静）。评审抓到 `setFooter` / `setHeader` 就是这样——`rpc-mode.js:137,140` 里它们存在且是空函数，我们的桩里没有。

## Considered Options

1. **放进 `chatStore` 的一个 slice** —— 拒绝：那个 store 已经 1604 行，且它是「消息」的家，不是「界面声明」的家。
2. **放进 `uiStore`** —— 拒绝：它是全局单例、没有 tabId 维度；`remoteStore.setStatus` 还占着相近的名字。
3. **让渲染层自己持有权威状态（不设 main 侧状态）** —— 拒绝：这就是动机一的 bug 本身。首帧必丢、视图切换丢、快照无处可拉。
4. **把面挂在 ChatView 的 mount 上，切走就退订** —— 拒绝：同上；而且在终端视图里 pi 的扩展仍然在声明（TUI 就在跑），回来以后应当看到当前状态而不是空白。
5. **给 `setWorkingIndicator` 也做一条搬运通道** —— 撤回（理由见决策 1）；这是本 ADR 里唯一被明确驳倒的「顺手一起做」。
6. **（采用）4 个成员 + shared 形状 + main 权威 + tab 寿命 + 观看规则纯函数化**

## 后果

**好的**：
- 扩展在聊天视图里终于有界面出口，且**两台后端形状一致**——`postUi(tabId, spec)` 的 `spec` 类型是 `ExtensionUiFrameSpec`（`Omit` 的手工分配版），把 `widgetLines` 写成 `widgetContent` 现在是**编译错误**，不是运行时静默丢字段。
- 首帧、视图切换、开 tab 竞态这一整类「一次性帧丢失」在结构上消失：状态住在不会被卸载的那一层，晚到的观看者拉快照。
- 会话身份一变就清，切视图就清，退出就清——不会出现「上一个会话的 status 冒充当前会话」。
- 降级从「静默 no-op」变成「名单 + 注释 + debug 日志」三处可查（对齐 ADR 0005 的「诚实降级」）。
- 观看规则是纯函数，10 条测试直接钉住截断/展开/顺序/空值语义，不需要 DOM（本仓库没有 jsdom，渲染测试只能是纯模块的）。

**代价 / 已知限制**（不藏，各自独立可修）：
- **`extension_error` 不清面**：`onError` 只给 `extensionPath`，不告诉我们「哪些 key 是它声明的」，清面会误伤一个没出错的扩展；错误本身已经在 chatStore 的 `extension_error` 分支里可见。所以一个崩掉的扩展留下的 status 会站到下一次会话身份变更。
- **对话框那半边（②b）不在本 ADR 内**：`<UiDialog>` 是 ChatView 里的**单个 `uiReq` 槽位**（`ChatPane.tsx:2642`），后台/隐藏 tab 的对话框渲染在不可见处，而审批门用 `signal` 而不是 `timeout`——那是一个**挂死**而不是错位。已单独记录，独立一轮处理。
- **组件与工厂跨不过 seam**：`setWidget(factory)`、`setFooter`、`setHeader`、`custom` 结构性拿不到（它们是 TUI 组件/函数）。我们的诚实回答是「不假装收到」，不是「假装收到了」。
- **`setToolStatus` / `setToolsExpanded` / `getToolsExpanded` 三个成员上游 `ExtensionUIContext` 上根本没有**（在 worker 的桩里存在）：它们保持 no-op，也**不进降级名单**——名单只列上游真有、而我们不兑现的成员。
- **widget 是纯文本**：不解析 markdown（pi 的 TUI 也只是 `Text` 组件包一层）。一行里塞 `**粗体**` 就是按字面显示。
- **颜色不复原**：扩展文本里的 ANSI 颜色码被剥掉（决策 9），不是渲染成颜色——TUI 主题的 256 色映射到我们的调色板只能猜。同一个原因还留着两个未处理的落点（都是**工具输出**而非扩展声明，与本 ADR 无关，各自独立可修）：对话时间线里的 tool result 文本（`git diff --color` 这类输出会把转义码写在 `<pre>` 里）与 `set_editor_text` 填进 textarea 的文本。

## 实施状态（2026-10-04）

- **shared**：`src/shared/extension-ui.ts`（`ExtensionUiSurface` / `ExtensionUiFrame` / `ExtensionUiFrameSpec` / `HANDLED_UI_METHODS` + `DIALOG_UI_METHODS` / `isDialogUiMethod` / `isSurfaceMethod` / `DEGRADED_UI_MEMBERS` 12 条 / `WIDGET_LINE_CAP = 10` / `SESSION_IDENTITY_COMMANDS` 5 条 / `emptySurface` / `applySurfaceFrame`）+ 18 条测试。
- **main**：`src/main/extension-ui.ts`（按 tab 的权威面 + `seq`）10 条测试（含一条源码级检查：worker 的 UI 上下文必须真的定义了降级名单里的每个成员——缺成员不是 no-op，是抛异常，上游 `runner.js:270-282` 不会给它补默认值）；`index.ts` 的两个 UI handler 合流为 `forwardUiRequest`（面帧被消化、其余照旧转发）、新增 `tab:rpc-ui-snapshot`、`tab:rpc-send` 里按 `startsNewSessionIdentity` 清面、`tab:close` 忘面、两个 switch handler 清面；`rpc-session.ts` / `chat-backend/sdk-host.ts` 的退出点清面；`sdk-host.ts` 新增 `{kind:"log"}` 路由到 debug log。
- **worker**：`sdk-worker.ts` 的 5 个成员经 `postUi` 发出（字段名与上游逐字一致），12 个降级成员各有日志（每成员每进程一次）。
- **renderer**：`stores/extensionUiStore.ts`（镜像 + `attach/detach/syncAttached` + attach epoch）10 条、`stores/extension-ui-view.ts` 19 条、`components/ExtensionUiZone.tsx`（`ExtensionUiZone` 只画 widget；`ExtensionStatusChips` 画输入栏里的 status）、`ChatPane.tsx`（header 左侧 title、用量后面的 status 条、composer 上下的 widget 区域、`set_editor_text` 守卫 + 可点提示）、`UiDialog.tsx`（`handleFireAndForget` 收窄 + 未知方法消化记日志 + 对话框判定读 `isDialogUiMethod` + 剥 ANSI）7 条、`TerminalPane.tsx`（tab 列表驱动 attach）、`preload/index.ts` + `global.d.ts`（两个新桥）、`styles.css`（`.chat-ext-*`）。
- **shared 工具**：`src/shared/ansi.ts`（`stripAnsi`，决策 9）6 条测试——OSC 必须先于 CSI 剥（OSC 内容里可能含 `[`），落单的 ESC/BEL 也要清，否则未终止的序列会漏进 DOM。
- **验证**：本特性 70 条测试（shared 24 / main 10 / 镜像 10 / 观看 19 / UiDialog 7）全绿，`npm run test`（85 文件 / 1278 条）、`npm run typecheck`（node + web）全绿；手测清单（真扩展 × 本地 SDK tab × WSL tab，形状必须一致；降级成员应出现 debug 行）留待发布前跑。
- **独立评审修正（同日）**：`navigate_tree` 从清理名单里删掉（它不重绑扩展 runner，只发 `session_tree`——清了就是永久丢，而远程后端根本不清，见决策 4）；`setFooter` / `setHeader` 补成真 no-op（见决策 8）；widget 展开加 `WIDGET_REST_MAX = 200` 上限并把超出量写在区域里（扩展是我们没写过的代码，一次坏循环不该变成几千个 DOM 节点）。
- **用户反馈修正（同日）**：① 输入框上方的扩展 status 显示出 `[38;5;241m◆ [39m[38;5;244m3 checkpoints[39m`——扩展的文本是按 TUI 写的（带主题色码），DOM 不解释转义。补决策 9（进 DOM 前剥 ANSI）与 `src/shared/ansi.ts`。② 「◆ 3 checkpoints」这类表述单独一行时读起来像没人发过的消息，改到 `chat-input-bar` 里紧跟用量之后（决策 5 的落点）。
