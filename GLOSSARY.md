# 领域模型 / Domain Glossary

本文件是本项目的**唯一语言**：术语的权威定义。架构评审（`improve-codebase-architecture`）、设计讨论、代码注释都用这里的词，不要另造同义词（每个术语下的 `_Avoid` 就是被驳回的说法）。
格式维护靠 `domain-modeling` 技能（`~/.pi/agent/skills/engineering/domain-modeling/`）。

## 术语

- **会话（Session）**：pi 在 `~/.pi/agent/sessions/<encoded-cwd>/` 下以 `.jsonl` 存储的一段对话。侧边栏展示其元数据：首条用户消息（预览）、消息数、显示名、mtime。
- **远端数据目录（AgentDir）**：远程 pi 的数据根目录，默认 `~/.pi/agent`。远程连接可填 `agentDir` 覆盖（经 `PI_CODING_AGENT_DIR` 环境变量生效，`~` 前缀/绝对路径，只允许安全字符）；用于多人共用 SSH 账号时隔离会话/模型/扩展。SFTP 侧 `remoteAgentDir(remote, homeDir)` 与 shell 侧展开保持一致。
- **会话索引（SessionIndex）**：主进程中唯一负责"列出某 cwd 的会话列表"的深模块。接口：`cached(target, cwd)`（TTL 守卫的同步读取）、`refresh(target, cwd)`（异步、快照增量、协作式分块解析）、`startPolling/stopPolling(target, cwd)`（4s 轮询）、`onChange/onAnyChange`（变更订阅）。target 是判别联合 `{kind:"local"} | {kind:"wsl", distro}`（2026-09-07 深化：WSL 从绕 seam 的旁路收编为 seam 下真正的第二份 backend adapter；SFTP 远程走独立的 remote cache + hydration 管道，不是此 seam）。WSL home 解析经 `setWslHomeResolver` 注入（生产 getWslHomeAsync，异步 spawn，消灭点击路径 spawnSync 阻塞隐患），路径映射经 `setWslPathMapperForTests` 注入（生产 \\wsl$ UNC），测试不依赖 wsl.exe。
- **激活事件（tabs:active）**：主进程 → 渲染层的原子激活载荷，携带 `{id, cwd, isRemote, sessions?}`。渲染层用一次 `applyActive` 应用，不再级联多次 setState。缓存命中的 `sessions` 让点击路径省掉一次 `session:list` 往返。
- **面板状态 store（Pane Store）**：渲染层按面板拆分的 zustand store：`useTabsStore`（标签与激活上下文）、`useSessionsStore`（项目目录 + 会话列表 + 水合 + 批量选择 + 会话生命周期 action）、`useTreeStore`（文件树）、`useViewerStore`（查看器 + 跟随 + `openFile` action）、`useLayoutStore`（跨 pane 几何：左右栏宽度、查看器折叠）、`useUiStore`（全局瞬时 toast）。面板组件用选择器订阅，互不牵连。
- **面板容器（Pane）**：渲染层按面板拆分的容器组件：`SidebarPane` / `TerminalPane` / `ViewerPane`。每个容器只订阅自己 slice 的选择器；跨 pane 动作（开会话、开文件、存文件刷树）走 store action，不经过 App。App 只留组合壳 + 事件编排（激活处理、主题、对话框）。
- **会话生命周期 action**：`sessionsStore` 的 `openSession / openRemoteSession / deleteSession / batchDelete`。删除后刷新本地项目缓存的规则（“已删会话不得残留在侧边栏”）与删除本身同住一个模块。
- **项目浏览 action（Project Explorer Action）**：`sessionsStore` 的 `toggleProject / deleteProject / newProjectSession`。水合阶段编排（本地预览 vs 远程/WSL 展开、缓存快路径、远程会话优先/暂停、treeOrigin 记录）全部收进 store，pane 只调一个 action——不再有 17 个原始 setter 穿过 interface。
- **对话框模块（Dialog）**：`ModelConfigDialog` / `RemoteDialog` / `RemoteDirPicker`。每个对话框自带全部表单状态与处理逻辑（挂载即全新），interface 只有 `onClose`；初始目标（跟随活动页签）在惰性 useState 里同步计算，首帧即正确。
- **PTY 流（TabStream）**：主进程按标签合并 pty 输出的流 adapter（5ms flush / 64KB 上限），避免每条 chunk 一次 IPC 消息。
- **远程服务器节点（RemoteServerGroup）**：侧边栏「远程服务器」分区的连接节点（与 WSL 发行版节点对称）。由 remote-history + 远程项目 + 打开标签三源合并去重（键 `user@host:port[agentDir]`，与主进程 remoteKey 同构）；`connected` 取决于是否存在同键标签，激活目标优先连接 shell 标签（`· 连接`）。分组逻辑是纯函数 `groupRemoteServers`（remote-servers.ts，可单测）。
- **目标（Target）**：主进程中「文件操作作用在哪」的唯一表示——判别联合 `{kind:"local"} | {kind:"wsl", distro} | {kind:"sftp", remote} | {kind:"ssh", remote}`，携带显式 `root`（浏览根）。interface 只认**根相对 posix 路径**。此前的「目标」是 `resolveTarget` 物化出来的伪造 `TabInfo`，调用方靠 `t.wsl` / `t.remote` 哪个字段被填来判别种类；`SessionTarget`（SessionIndex）与 `GitCtx`（diff-session）各自已有一份同类判别联合，`Target` 是这三者合并的方向（2026-09-29，见 `docs/adr/0001-target-fs-seam.md`）。
  _Avoid_: 隐式目标、伪造 TabInfo、靠字段缺席判别种类
- **目标文件系统（TargetFs）**：主进程中唯一负责「按目标读写文件」的深模块。interface 是根相对路径上的 `list / readPreview / write / mkdir / remove / rename / readText`；截断与预览语义（1MB 上限、头尾窗口、二进制判定）属于它，不属于调用方。缓存是它的**内部 seam**（TTL / in-flight / generation / 失效传播，`FileTreeIndex` 泛化为 target-keyed）。通道差异全部在 seam 之下。
- **通道（Channel）**：满足 TargetFs interface 的一条传输路径，即 seam 下的 adapter。三份：`localFs`（真 fs；**WSL 通过注入 path mapper 复用它**，与 SessionIndex 的 `setWslPathMapperForTests` 同一注入点）、`SFTP`（远程浏览/预览/mention 的唯一通道，走 pooled lease；认证材料含密码、agent 与默认密钥，**密码不是通道选择条件**）、`ssh`（只有 `ssh cat`：会话文件快路径，不占 SFTP 租约、远端 pi 死掉时仍可读）。通道选择规则只有一处真值。
  _Avoid_: 后端、传输层

