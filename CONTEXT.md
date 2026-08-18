# 领域模型 / Domain Glossary

本文件记录本项目的领域词汇，供架构评审（improve-codebase-architecture）与设计讨论使用统一语言。

## 术语

- **会话（Session）**：pi 在 `~/.pi/agent/sessions/<encoded-cwd>/` 下以 `.jsonl` 存储的一段对话。侧边栏展示其元数据：首条用户消息（预览）、消息数、显示名、mtime。
- **远端数据目录（AgentDir）**：远程 pi 的数据根目录，默认 `~/.pi/agent`。远程连接可填 `agentDir` 覆盖（经 `PI_CODING_AGENT_DIR` 环境变量生效，`~` 前缀/绝对路径，只允许安全字符）；用于多人共用 SSH 账号时隔离会话/模型/扩展。SFTP 侧 `remoteAgentDir(remote, homeDir)` 与 shell 侧展开保持一致。
- **会话索引（SessionIndex）**：主进程中唯一负责"列出某 cwd 的会话列表"的深模块。接口：`cached(cwd)`（TTL 守卫的同步读取）、`refresh(cwd)`（异步、快照增量、协作式分块解析）、`startPolling/stopPolling`（4s 轮询）、`onChange/onAnyChange`（变更订阅）。本地 / WSL UNC / SFTP 是其同一 seam 下的三份 backend adapter。
- **激活事件（tabs:active）**：主进程 → 渲染层的原子激活载荷，携带 `{id, cwd, isRemote, sessions?}`。渲染层用一次 `applyActive` 应用，不再级联多次 setState。缓存命中的 `sessions` 让点击路径省掉一次 `session:list` 往返。
- **面板状态 store（Pane Store）**：渲染层按面板拆分的 zustand store：`useTabsStore`（标签与激活上下文）、`useSessionsStore`（项目目录 + 会话列表 + 水合 + 批量选择 + 会话生命周期 action）、`useTreeStore`（文件树）、`useViewerStore`（查看器 + 跟随 + `openFile` action）、`useLayoutStore`（跨 pane 几何：左右栏宽度、查看器折叠）、`useUiStore`（全局瞬时 toast）。面板组件用选择器订阅，互不牵连。
- **面板容器（Pane）**：渲染层按面板拆分的容器组件：`SidebarPane` / `TerminalPane` / `ViewerPane`。每个容器只订阅自己 slice 的选择器；跨 pane 动作（开会话、开文件、存文件刷树）走 store action，不经过 App。App 只留组合壳 + 事件编排（激活处理、主题、对话框）。
- **会话生命周期 action**：`sessionsStore` 的 `openSession / openRemoteSession / deleteSession / batchDelete`。删除后刷新本地项目缓存的规则（“已删会话不得残留在侧边栏”）与删除本身同住一个模块。
- **项目浏览 action（Project Explorer Action）**：`sessionsStore` 的 `toggleProject / deleteProject / newProjectSession`。水合阶段编排（本地预览 vs 远程/WSL 展开、缓存快路径、远程会话优先/暂停、treeOrigin 记录）全部收进 store，pane 只调一个 action——不再有 17 个原始 setter 穿过 interface。
- **对话框模块（Dialog）**：`ModelConfigDialog` / `RemoteDialog` / `RemoteDirPicker`。每个对话框自带全部表单状态与处理逻辑（挂载即全新），interface 只有 `onClose`；初始目标（跟随活动页签）在惰性 useState 里同步计算，首帧即正确。
- **PTY 流（TabStream）**：主进程按标签合并 pty 输出的流 adapter（5ms flush / 64KB 上限），避免每条 chunk 一次 IPC 消息。

## 关键架构决策

- 点击会话 → 中间页显示的路径上，主进程不允许出现同步全量 JSONL 解析（会阻塞全部 IPC，包括终端流）。一切会话列表读取必须走 SessionIndex（异步 + 缓存 + 增量）。
- 点击路径上主进程不允许出现同步子进程 spawn（`where.exe` / `node --version` / `pi --version` 各阻塞 0.03-1.2s）：检测结果（pi 路径 / node 是否安装 / pi 是否可用）必须在启动时预热并缓存（`warmPiDetection` / 检测缓存），会话文件标题只做首尾 64KB 范围读取。
- 渲染层任何跨面板数据必须放在 store，不得重新放回 App 的本地 useState；App 保持为组合壳 + 事件编排。
- 终端输出（pty → 渲染层）必须合并写；输入路径（渲染层 → pty）不合并。
- 跨 pane 动作必须收进 store action（`viewerStore.openFile` / `sessionsStore.openSession` 族 / `tabsStore.createTab` 族），容器不许把动作重新放回 App 回调；App 的 selector 订阅只覆盖对话框/编排真正读的 slice。
- 对话框是自含模块：状态不回流到 App，App 只持打开标志；store 的 `set` 一律用函数式更新，循环内禁止用一次性快照（会互相覆盖）。
- **默认视图 = 终端（pty TUI）**（2026-08-11）：新 tab（本地/WSL/远程）一律 `createTab` 跑 pi TUI；聊天视图是可选功能（TabBar「聊天视图」），本地切 SDK 进程内后端、远程/WSL 切 `pi --mode rpc`，同 tab id 双向切换（`switchTerminalToSdk`/`switchSdkToTerminal`/`switchTerminalToRpc`/`switchRpcToTerminal`）。本地 pty tab 需要系统 pi 二进制（`ensurePiReady`）；SDK worker 启动时后台预热，切聊天零等待。
- **ConPTY 冻结自愈（stall watchdog + 电源重建）**（2026-08-14）：Windows 锁屏/休眠后 conhost 管道可能停摆（输出冻结、输入被吞，OS 级已知 bug，VS Code/Windows Terminal 同款，均靠重建终端恢复）。两层机制：① `writeTab` 对 pi tab 在 ≥3min 零输出后的首次输入布设 8s 回显探针，无回显 → `restartTab`（同 id 原位重建 pty，保留 tab id/标题/会话，pi 从 JSONL 续接；shell tab 豁免，防止误杀静默长命令；系统 CSI 写入豁免）；② `powerMonitor` 锁屏/休眠 ≥10min 后 unlock/resume 时主动重建所有 pty tab。`onExit` 一律带 `tabs.get(id).pty !== term` 陈旧守卫，防旧 pty 退出事件破坏替换后的新记录。（阈值从 20min 降到 3min：探针自取消——健康 pty 输入即回显，降阈值零误杀成本；用户实测“闲置久后输入无反应”多为 5–15min 场景，20min 触发不了。）
- **自动跟随增量读（session-watcher，2026-08-14）**：watcher 负责从会话 JSONL 里提取 read/write/edit 工具事件驱动右侧文件跟随。读取路径改为**真增量 + 永不阻塞事件循环**：`readAppended` 异步定位读（fs.promises open + handle.read 带 position），单趟封顶 1MB；跨趟未完成的行由 `state.partial` 缓冲（`splitDelta` 纯函数），超 cap 单行不丢不重；`StringDecoder` 防 UTF-8 字符跨趟截断；drain 单飞（`draining` + `debouncedPending`，防并发读同一 delta 双发）；每趟快照 `st` 并在每个 await 后校验 `state === st`，切 tab 时在途 pass 安全中止不重放；活动文件选择 `pickActiveJsonl` 走缓存 stat + 2s TTL 全扫描；resume 种子由 `seeding` 标志保护，watch 事件不会把种子变成全量重放。事件契约 `{path, kind}` 不变。
- **懒加载文件树（lazy tree，2026-08-14）**：本地树从“深度 12 急切全递归 + 整树 IPC”改为**浅层懒加载**——`file:list`/`file:list-dir` 每次最多一次浅 readdir（目录 `children: undefined` 表示未加载、`[]` 表示真空，展开才取并不可变注入）；缓存按目录浅列（**root 感知键** `${root}\u0000${relDir}` 防双根碰撞，TTL 5s + generation + 共享 in-flight），mutation 失效父目录链；auto-follow 刷新 = 重列根 + 已展开目录（浅列）+ 1s 冷却钳高频写；`expandDir` 用 **per-dir 序号**（不共享 loadTree 的 treeReqSeq，独立目录互不取消，同目录后到者生效），origin/折叠/节点消失守卫防陈旧注入，失败折叠目录待重试；`injectChildren`/`findNode` 按全路径前缀匹配（节点路径各级均为根相对）。远程/WSL 惰性实现（浅列 + 导航）保持不变。
- **文件预览读闸（read gate，2026-08-14）**：文本预览上限 1MB（`TEXT_PREVIEW_MAX_BYTES`），超限**从不整读**——`readPreviewFromAbs`（本地/WSL 共用）先 stat 预检，超限走定位读（open + handle.read）取头尾各 512KB（`TEXT_PREVIEW_HALF_BYTES`），标记 `truncated: true`；SFTP 用 `client.get` 的 `readStreamOptions {start,end}` 只拉两段（v12 直通 ssh2 createReadStream）。超限二进制走 binary 分支；位图 1–10MB 仍整读换取完整 base64 载荷、>10MB 无载荷（与既有图片上限一致）。三路径共用 `isBinaryBuffer`（8KB 采样，NUL/非文本占比）判定。渲染层：截断文件**锁定只读**（保存会覆盖截断内容），显示“已截断”提示条 + 头尾内容；截断 SVG 回退文本分支。边界保真：`bytes` 始终为真实大小，头尾窗口在 size > cap 时数学上不重叠。
- **tab:create 先出终端（连接体感，2026-08-14）**：① 远端主题同步**后置为后台**（createTab 先出，getSftpLease + syncThemesViaSftp fire-and-forget，best-effort，TTL 门控不变）——死服务器不再让终端晚出现 ≤15s；② `tab:alive` 语义从“已注册”改为“**注册 + pty 进程存活**”（`isPtyTabAlive`：node-pty `exitCode === undefined`，windowsPtyAgent 运行时暴露）——ssh.exe 连接被拒/主机不可达会快速退出 → 对话框正确报失败，不再假“已连接”；RPC/SDK 外部 tab 无 pty → 保持注册语义；`waitUntilAlive` 首轮轮询前加 300ms settle（失败进程的退出事件 50–500ms 才派发，立即轮询会漏判）；③ 本地首次 pi 自动安装复用 `runLocalPiInstall`（in-flight 守卫 + begin/result 事件）→ PiInstallDialog 显示进度，不再 19s 无反馈。
- **体感打磨轮（2026-08-14）**：① 单实例锁（`requestSingleInstanceLock`，二次启动聚焦现有窗口；`whenReady` 移入锁的 else 分支）+ `uncaughtException` 兜底（setInterval/watch 回调同步 throw 不再炸主进程）+ `show:false`/`ready-to-show` 消除启动白闪（`did-fail-load` 兜底显示）；② alert→toast 统一（重命名失败、远程项目引导）；③ WSL 连接 in-flight 守卫（双击不再双开 tab，失败有 toast）；④ 聊天发送 300ms 双发守卫 + 聊天/终端视图切换 try/catch/finally（失败不再永久禁用按钮）；⑤ 模型配置对话框 4 个异步按钮（验证/删除/移植/保存）统一 busy 守卫（**校验在 guard 之前**——reviewer 抓到首点路径的 busyAction 卡死 bug）；store 层 3 处原生 confirm（会话/批量/项目删除）保持现状（样式化需要把确认逻辑从 store 提组件层，成本高收益低）。
- **终端激活聚焦（2026-08-15）**：TerminalView 挂载和 tab 激活时**从不调用 `term.focus()`**——xterm 的输入依赖辅助 textarea 聚焦，打开会话后未聚焦则打字完全无效（用户症状：“打开软件、打开会话输入没反应，必须多次切换会话”——切换时误触终端点击才恢复）。修复：TerminalHost 给 TerminalView 传 `active`，挂载时若激活立即 focus；`[active]` effect 在 tab 激活时 refocus + 绑定 window focus 监听（窗口回归时还给终端；监听放此 effect 内避免闭包捕获首次渲染的 active 值）。
