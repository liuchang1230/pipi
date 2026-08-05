# 领域模型 / Domain Glossary

本文件记录本项目的领域词汇，供架构评审（improve-codebase-architecture）与设计讨论使用统一语言。

## 术语

- **会话（Session）**：pi 在 `~/.pi/agent/sessions/<encoded-cwd>/` 下以 `.jsonl` 存储的一段对话。侧边栏展示其元数据：首条用户消息（预览）、消息数、显示名、mtime。
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
