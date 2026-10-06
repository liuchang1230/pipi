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
- **命令运行器（CommandRunner）**：表示「在某台机器上跑一条 posix 命令」的唯一类型——`(options: {command, stdin?, timeoutMs?}) => Promise<RunResult>`。命令文本由调用方给（POSIX 文本，由目标 shell 展开），凭据、二进制与 shell 方言由绑定方给：免密 ssh → `src/main/ssh-exec.ts`、WSL → `src/main/wsl-exec.ts`、密码 ssh2 → `src/main/ssh2-exec.ts`（走 `ssh2` 库的 channel，不走 `spawn`）。spawn、超时、输出截断与「永不抛、失败以 `ok:false + error` 回来」的契约只有一份实现——`runner.ts` 的 `runCommand()`（ssh2 绑定不走 spawn，但复用同一条契约里的有界输出累加器 `createOutputCollector`）；绑定方只贡献连接参数、argv 形状与默认值。它是 content-sync 里 `SshScriptRunner` 的通用形态（2026-10-05，`docs/adr/0007-pi-runtime-seam.md`）。
  _Avoid_: PiRun、执行器、传输层、ssh 执行器
- **pi 端点（PiPort）**：一次「对某个目标上的 pi 做版本探测/对齐」的完整输入——`{ run: CommandRunner, key, target?: { cwd?, agentDir? } }`。`key` 是缓存身份（`"local"` / `wsl:<distro>` / `buildRemoteKey(remote)`），版本缓存挂在它上面；`target` 只回答「在哪个目录、要不要注入 `PI_CODING_AGENT_DIR`」，不是目标词汇。注入 PiPort 意味着 pi 版本模块**不认识** `Target`，也就不会长出第七份「目标」。
  _Avoid_: target、目标描述、远端连接对象
- **pi 在场状态（PiPresence）**：本机 pi 的四态——`present | unverified | absent | unrunnable`，由 `src/main/local-pi.ts` 的 `present()` 从 `probeOutcome()` 投影出来（同步、有界、带缓存）。`absent` 只给「可执行文件根本不在」（spawn 的 `ENOENT`），`unrunnable` 是「装了但跑不起来」（跑完非零退出）：两者在 `ensurePiReady` 走同一条修复路（都用捆绑副本重装），但提示要说清是哪一种。**探测超时 ≠ 缺失**是历史结论（超时若被当成缺失，会把用户用 `pi update` 保持最新的全局 pi 悄悄降级）：超时报 `unverified`，`present() !== "absent"` 这种折叠由调用方负责，不再藏在探测里面。
  _Avoid_: 有没有装 pi、pi OK、boolean present
- **本机 pi 事实（Local Pi Facts）**：本机到底跑哪一个 pi —— `{ piBin, source, nodeBin, cliJs }`，由 `src/main/local-pi.ts` 的 `resolveLocal()` 一次解析（纯解析：不探测、不带版本号，因为 `createTab` 是同步的、点击路径不许有副作用）。`source` 记的是哪条候选赢了（`npm-global` / `where` / `fallback` / `unresolved`）。**只有一处**：标签页的 pty spawn、本地聊天（`pi --mode rpc`）、模型验证（`pi --list-models`）全部问它，不再各自扫 PATH。与 Windows 可执行文件查找（`find-exe.ts`）分开，因为后者的消费者还有 ssh/wsl/npm，且不认识 pi。
  _Avoid_: 找 pi、pi 路径、本地 pi 检测
- **捆绑 pi 版本（Bundled Pi Version）**：app 自带 pi 包的版本号，也是唯一的 pin——远程/WSL 对齐到它，SDK 模式的本地聊天在同进程 `import` 它的代码，漂移判断以它为基准。取值只读 app 自带的 `node_modules`（打包后透读 asar），兜底读 app `package.json` 的精确依赖 pin；**用户的全局 pi 永不参与**（它被允许追 npm latest，一旦参与就会出现「捆绑版本被影子化」的 ETARGET 事故）。它必须满足 app 自带 Electron 的 Node 版本（今天 0.85.1 的 `engines` 下限 `>=22.19.0` 正好等于 Electron 36.9.5 的 Node）。
  _Avoid_: 最新版 pi、全局 pi 版本、latest
- **pi 漂移（Pi Drift）**：契约版本（捆绑 pi pin）与**目标机上那个 pi** 之间的关系（只对 SSH / WSL 目标机分类：`src/main/update-check.ts` 的 `buildRemoteInfo`），具名六态：`pinned | drifted-newer | drifted-older | absent | unrunnable | unknown`，由 `src/shared/pi-drift.ts` 的纯分类器 `classifyPiDrift({ bundled, probe })` 从「已探到的事实」算出（不自己探测、不缓存——缓存了就有两份真相）。`unknown` **不是**「一致」，是没探明（传输层失败 / 超时 / 输出里没有 semver），不许猜。漂移**不是失败**（服务器自己升过是允许的）；这里也不负责留痕——目标机真的探测失败由调用方按 `info.error` 进故障中心（硬规则 8）。**本机不是漂移**：本机那个 pi 在不在、好不好，由 `PiPresence` 四态回答（那是安装/修复的判据，也是故障中心那条提示的来源）。见 `docs/adr/0008-pi-drift-as-state.md`、`docs/adr/0009-no-chase-latest.md`。
  _Avoid_: 版本不一致、版本落后、hasUpdate、版本不对、本机漂移

