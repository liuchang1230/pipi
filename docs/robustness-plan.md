# 稳定性与可诊断性 —— 整体分析与设计规划

状态：规划设计 v2（已过独立评审并修订；v1 的两处根因判断被推翻，见 §7 修订记录）
日期：2026-09-23
触发：用户反馈"软件不稳定、鲁棒性不高、容易卡顿、提示不充分、出问题了用户也不知道咋了"

本文把上述抱怨翻译成代码级根因，并把"逐例修复"改成"机制修复"。诊断基于实机证据
（`%APPDATA%/pipi/pipi-debug.log` 实测 11.4MB / ~130k 行；`src/**` 逐点核对，每条标 `file:line`）。

---

## 0. 症状 → 根因一览

| 用户说的话 | 代码级根因 | 类别 |
|---|---|---|
| "卡顿 / 未响应 / 鼠标转圈" | 主进程事件循环被同步调用阻塞（spawnSync 无超时、同步写日志/读文件） | **A** |
| "一直加载中 / 点了没反应" | **已建立的 SFTP 连接卡死且无超时**（普通 IPC 无 deadline），loading 标志无停滞升级 | **B** |
| "窗口白了 / 界面崩了" | 不受信数据（模型 tool args）渲染期抛错、只有根级边界、渲染进程崩溃无处理 | **C** |
| "我的项目/配置没了" | 配置非原子写 + 读失败静默返回 `[]` + 读-改-写放大 | **D** |
| "出问题了我不知道咋了" | 错误契约分裂（**错误被写成数据**）、无码无建议、toast 一闪而过、日志被噪音淹没且用户拿不到 | **E** |
| （元问题）同类 bug 反复出现 | 修复停在实例层，没有原语与回归网强制 | **F** |

---

## 1. 诊断（带证据）

### A 类：主进程事件循环被阻塞 → "卡顿"

主进程同时服务**全部** UI IPC、终端数据流、SFTP/RPC 调度。它一停，全应用冻结。

| 编号 | 证据 | 问题 |
|---|---|---|
| A1 | `src/main/pty.ts:955-980` `runPiVersion` 三次 `spawnSync` **无 timeout**；`:398`(node)、`:911`(where.exe) 同病。调用链 `tab:create` → `ensurePiReady` → `hasGlobalPiInstalled`(`pty.ts:403`) → `getPiDetectionDiagnostics`(`pty.ts:428`) | pi 卡住 → **永久冻结主进程**。频率需诚实：`warmPiDetection`(`pty.ts:776-796`) 已把探测预热，同步探测只在预热失败或 `cachedPiOk=false` 且超 5s TTL(`pty.ts:759`) 时才落回点击路径——**危害是"无上限"，不是"每次点击 1.1s"** |
| A2 | `src/main/index.ts:619-630` `getWslHome` = `spawnSync("wsl.exe",{timeout:5000})`，挂在 `resolveWslPath`（tab:create / file:list / file:list-dir / session:delete） | 冷缓存时一次点击冻结全进程最多 5s；已有预热缓解（index.ts:2440 注释自认 "BLOCKS the whole main process"），未根治 |
| A3 | `src/main/debug-log.ts:24` `appendFileSync` **每次调用**同步写盘；实测 11.4MB / tag 分布 `[rpc] 53114`、`[renderer] 45723`、`[rpc-send] 28469` | 日志成了热路径同步 IO。且 `[renderer]` 45723 条里 **45662 条是 TreeDialog 3s 轮询**（每次响应 2 行 → IPC + 主进程写盘）。真信号被噪音淹没 |
| A4 | `src/main/diff-session.ts:266` `readFileSync` **整个未跟踪文件**（无大小门），走 `diff:get` | 无上限读 + 无上限 IPC 序列化 |
| A5 | 只有 `[mem]` tick（index.ts:1033），**无事件循环延迟指标** | "卡"不可归因。注意 `monitorEventLoopDelay` 跑在被阻塞的循环上：**同步冻结（A1/A2）只能事后记录**，不能实时预警——它的价值是给异步慢操作（SFTP/大载荷）定位，以及把"卡"变成日志里的数字 |

### B 类：无限等待 → "一直加载中 / 点了没反应"

| 编号 | 证据 | 问题 |
|---|---|---|
| B1 | 只有 `rpcRequest`（`preload/index.ts:135-160`）有内建超时；全仓库唯一另一处 deadline 是 `ChatPane.tsx:52/793` 的临时 `withTimeout`（只包了 `transcriptFromFile`）。`file.list`/`file.listDirChildren`/`file.read`/`file.searchMentions`/`session.list`/`session.listRemote`/`diff.*`/`model.listRemote*` **全无 deadline** | 一个卡死的操作 = 永恒 spinner（`SidebarPane.tsx:982-994`、`FileViewer.tsx:249-251`、mention 搜索）。`withTimeout` 的存在恰好证明：**原语存在，只是没被共享** |
| B2 | **根因修正**：`file:list` 在远程/WSL 分支几乎不会 reject——`remoteListFiles`(`index.ts:3085-3105`) 与 `wslListFiles`(`index.ts:3076-3083`) **catch 住所有错误并返回一行占位"文件"**。真正的永恒等待是**已建立连接上的挂起**：`getSftpLease` 只对**连接**限时（`readyTimeout:15000`，`index.ts:578`），已建连接上的 `client.list` 无超时；NAT/漫游/静默丢包时它永不 settle。`sessionsStore.ts:529-566` 先置 `projectLoading=true`/`remoteHydration=hydrating` 再裸 await `:550`/`:559` | 挂起时：row 永久"远程会话加载中…" + toast"正在补全远程会话信息…"永不消失。**`try/finally` 对挂起无效**（只有 settle 才执行 finally）——修法必须是 deadline，不是 try/finally |
| B3 | 7 个手写载入标志（`projectLoading`/`remoteHydration`/`fileTreeStatus`/`fileLoading`/`booted`/`historyLoaded`/`mentionsLoading`）分布在 4 个 store | "置位必复位"靠人记；停滞无升级：45s 后仍显示"加载中…"，不会变成"已等 45s：远程目录列举无响应 [重试]" |
| B4 | `treeStore.ts:326`、`treeStore.ts:187`、`chatStore.ts:964`（abort 失败被吞）、`ViewerPane.tsx:89`、`App.tsx:181/211/222/234/266/273` | 静默降级：用户看到"旧数据 / 空列表 / 无反应"，无任何提示。（`sessionsStore.ts:518` 的 `.catch` 属可接受——那是已缓存数据的后台刷新，错误仍经 `listResult.error` → `projectErrors` 上行） |
| B5 | **错误被写成数据**（与 B2 同源、独立成条）：`index.ts:3100` 返回 `{name:"（远程浏览失败: …）", type:"file"}` 当作树节点；`file:read` 把 `⚠️ 读取失败` 当 `content` 返回 | 失败变成"内容形状的垃圾"：用户看到一行莫名其妙的文件，或把错误文案当文件内容保存回磁盘。这是 E 类最恶劣的形态——**错误伪装成成功** |

### C 类：崩溃与白屏 → "界面崩了"

| 编号 | 证据 | 问题 |
|---|---|---|
| C1 | 日志 6 次 `Cannot read properties of undefined (reading 'split') at editsToDiff ← summarizeTool`（**dev 构建栈**，localhost:5173）。漏洞由代码审查确认真实：pi 校验失败的 edit 调用仍被持久化（如 `{"edits":[{"newText":"…"}]}`），回放时渲染期抛错 | 不受信数据（模型输出）直达 render。React 无边界时卸载整棵树 = 白屏。**已在修但未提交**：`components/diff-utils.ts`(+81)、`tool-summary.ts`、`ChangesView.tsx`、`styles.css`、新增 `ErrorBoundary.tsx` |
| C2 | 只有根级一个 `ErrorBoundary`（`main.tsx:27`） | 任一 pane 崩溃 = 全窗口崩溃（会话内容、未保存编辑一起丢），无分级恢复 |
| C3 | `index.ts:3604-3612`：`unhandledRejection`/`uncaughtException` **只有 `console.error`** | 打包版无窗口 = 完全不可见、**不落日志** |
| C4 | **`render-process-gone` 全仓库 0 命中** | 渲染进程 OOM/崩溃 = 白窗口，无提示、无自动恢复。最便宜也最直接的"窗口白了"治理点 |

### D 类：静默数据损失 → "我的东西没了"

| 编号 | 证据 | 问题 |
|---|---|---|
| D1 | `projects.ts:79/96/115/136`、`settings.ts:96`、`remote-history.ts:34`、`theme-sync.ts:66/121`、`specs-lookup.ts:60` 全是 `writeFileSync(path, JSON.stringify(...))`；`grep renameSync/.bak/atomic` = **0 命中** | 非原子写：断电/崩溃/杀软介入 → 半截 JSON |
| D2 | `projects.ts:63-70` 及各 `readXxx` 读失败一律 `return []`/`{}` | 损坏 = **静默清空**，无备份、无告警、无隔离、无恢复入口 |
| D3 | **放大器**：`writeProjects` 是读-改-写（`projects.ts:70-79`） | 一次损坏读 → `[]` → 用户下一次"添加项目"就把**全部项目**写没了。低频高损，必须做（§S7 的头号验收用例） |

### E 类：出问题用户不知道（本诉求核心）

| 编号 | 证据 | 问题 |
|---|---|---|
| E1 | 三种错误契约并存：`{ok,error}` / `throw`（`model:list-remote`）/ **错误塞进内容**（B5）。未捕获的 invoke rejection 只进调试日志 | 同一个失败，用户有时看到 toast、有时看到 placeholder、有时看到垃圾数据、有时什么都看不到 |
| E2 | 文案现场拼接，中英混杂（`list: No such file`、`Inappropriate ioctl`） | 无错误码 → 无法聚合、无法给针对性建议、无法在日志检索 |
| E3 | 分级倒挂：3s 消失的单槽 toast（`uiStore.ts`）承载了 ~100 处最需要停住看的失败；持久位置反而是低对比度 placeholder（`SidebarPane.tsx:983/1089`） | 用户还没读完就没了 |
| E4 | ~20 处 `rpcSend` 的 boolean 返回值被忽略，**包括 `abort`（`chatStore.ts:964`）与 `/compact`（`ChatPane.tsx:1415`）** | 传输层已给出证据，UI 不呈现：点了"停止"可能什么都没发生。（`rpc_stalled` 本身冗余——只在整个会话前 60s 零 JSONL 响应时触发一次，已被 30s boot 定时器 + 40s `rpc_no_output` 覆盖） |
| E5 | 日志 11.4MB 无轮转、无级别、45k 行轮询噪音；用户在 `%APPDATA%\pipi\` 手动找；无查看器、无导出 | 用户无法自助排查，支持链路只能靠口述 |
| E6 | 没有"现在在等什么"的清单 | 用户与支持者都无法回答最基本的诊断问题 |

### F 类：机制性复发（元问题）

CONTEXT.md 里**同一教训已出现三次**（"事件触发 + 大载荷 + 慢链路"必须有在飞闸门）：
`tree-poll-guard`（get_entries 12949 次）→ `history-gate`（get_messages 多 MB 重下风暴）→ 本轮 B1/B2。
每次都"修一个对话框/一个 store"。**实例修复不产生免疫力。**

---

## 2. 设计：8 个 seam（改机制，不改 UI 版式）

原则：**让错误类在结构上不可能发生**，而不是让每个调用点记得处理。

### S1 统一结果与错误分类 —— `src/shared/outcome.ts`

```ts
export type ErrCode =
  | "timeout" | "offline" | "auth" | "notfound" | "permission"
  | "conflict" | "protocol" | "crashed" | "busy" | "cancelled" | "internal";

export interface AppError {
  code: ErrCode;
  title: string;   // 人话标题（给用户的第一行）
  cause: string;   // 技术原因（可搜索、可复制）
  hint?: string;   // 可执行建议（下一步做什么）
  target?: { host?: string; path?: string; tabId?: string };
  retryable: boolean;
  actionId?: string;  // 见 S6 面包屑
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };
```

消除 E1（单一契约）、E2（有码可聚合）、E3（UI 有统一渲染输入）。

### S2 主进程侧限时与归属 —— `src/main/op-guard.ts`

```ts
guard<T>(name: string, opts: {
  deadlineMs: number;                    // 表驱动：实测最坏往返 × 安全系数
  target?: OpTarget;                     // host/path/tab → 失败归属与熔断
  onTimeout: (info: TimeoutInfo) => void; // SFTP 类操作**必填**，见下
}): Promise<Outcome<T>>
```

**关键约束（评审抓到的设计缺陷）**：`ssh2-sftp-client` 没有单操作取消。只做 `Promise.race` 会让用户侧有界、
但**资源无界**：`withSftp`（`index.ts:2987-3001`）只在 `fn` settle 时才在 `finally` 里 `refCount--`，
而 `scheduleSftpLeaseCleanup` 在 `refCount > 0` 时拒绝销毁（`index.ts:466-472`）→ 卡死的 lease 永久留在池里，
后续每个操作都要烧完整个 deadline，熔断器也学不到东西。

因此：**SFTP 类操作的 `onTimeout` 必填**，语义 = 中毒标记 + `destroySftpLease`（`client.end()` 是唯一真实取消，
它会 reject 在飞 promise 并回收 socket）+ 计入既有熔断 `sftpFailures`(`index.ts:481-600`)。
这样"用户侧有界"和"资源侧有界"同时成立。

- 统一收编：`withSftp` / `sshExec` / WSL 读写 / 本地 fs IPC 处理器。
- single-flight：同 key 并发读合并；**与既有 `fileTreeIndex` 的 5s TTL 缓存与远程缓存协调键**（避免双层缓存打架），
  不与 `tree-poll-guard`/`history-gate` 重复。
- 直接消灭 B5：错误不再被写成数据，占位行/`⚠️` 内容契约删除。

### S3 渲染侧边界 —— `preload` 的 `call()`（范围收敛）

```ts
call<T>(channel: string, args: unknown[], opts?: { deadlineMs?: number }): Promise<Outcome<T>>
```

- **保证 promise 一定 settle**，失败一定是 `AppError`，永不 reject。
- **deadline 表驱动**：每 channel 显式声明；长任务（`pi-install:run`、`update:run-target` 实测 600s、`model:discover`）
  显式"无 deadline + 走进度事件"。
- **必须原样豁免**（否则一定弄坏）：`rpcRequest`（自带 id 匹配 + 超时，`preload/index.ts:146-179`）、
  `waitUntilAlive`/`waitConnState`（轮询循环，`:180-210`）、`writeInput`（故意的单向 `send`，`:113`）。
- **范围界定（重要）**：Phase 2 内 `window.api` 对外的 reject/返回契约**保持不变**，S3 是"内部 settle 保证 +
  deadline 表"；让渲染层全面改用 `Outcome` 是**后续可选项**，不混进本阶段（否则就是全仓库迁移，
  与"~1 处 seam"矛盾，且 E1 也没真解决）。Phase 2 解决 E1 的方式是 S5 的 `<LoadState>` + 失败面统一收口。

### S4 渲染侧任务中心 —— `src/renderer/src/stores/tasksStore.ts`

```ts
task(key): {
  phase: "idle" | "running" | "stalled" | "error" | "done";
  scope: "visible" | "background";   // 后台轮询不进全局计数、不弹停滞横幅
  label: string;
  waitedMs: number;
  consequence?: string;              // "远程 /data/x 列举无响应（sftp 15s 超时）"
  retry?: () => void;
}
start(key, {label, scope, deadlineMs}) → 同 key 单飞
settle(key, Outcome)                   → 唯一出口
```

**deadline 两段式，定义只有一处**（消除 S3/S4 语义冲突）：

| 阈值 | 状态 | UI |
|---|---|---|
| T1（如 10s） | `stalled` | 仍显示加载中，但带"已等待 Ns · 在等 <consequence> · [取消] [重试]" |
| T2（如 30s） | `error`（终态） | `<LoadState>` 错误态：标题 + 原因 + 建议 + [重试] + [详情] |

- **后台轮询豁免**：6s 树轮询/4s 标题轮询/水合调度注册为 `background`，不进全局计数、不弹停滞——否则
  "N 个任务进行中"永远亮着 → 警报疲劳 → 调用点重新绕开注册表 → B3 换个层级复发。
- **迁移纪律（防双源真相）**：每迁移一个域，**同一步删除**旧的 per-domain 字段
  （`sessionsStore.projectLoading/remoteHydration`、`treeStore.fileTreeStatus`、`viewerStore.fileLoading`），
  不允许"新旧并存"跨阶段。
- 顺序（先真实卡死点）：`toggleProject`(B2) → `treeStore`(B1) → `viewerStore`(B1) → hydration(B1)。

### S5 失败面 —— `failureStore` + `FailureCenter` + `<LoadState>`

- `failureStore`：每条失败生成**持久**记录（code/时间/目标/建议/面包屑/重试）。toast 只留"成功/瞬时"（E3 反转）。
- `FailureCenter`（右下持久条 + 详情抽屉）：人话标题 + 技术原因 + 建议 + `[重试] [复制诊断] [诊断面板]`。
- `<LoadState>` 统一四态（加载中 / 停滞 / 错误 / 空），**错误态永远带"重试 + 详情"**，替换 placeholder 与手写分支。
- 文案规范写进 CONTEXT.md：`标题（人话）+ 原因（技术）+ 建议（可执行）`，必带 code。

### S6 可观测 —— `perf.ts` + 面包屑 + 日志纪律 + 诊断面板

| 件 | 内容 | 消除 |
|---|---|---|
| `src/main/perf.ts` | `monitorEventLoopDelay`：每 10s `[perf] lag p50/p95/max`；连续 p95>200ms → `app:busy` | A5 |
| 归因 | `app:busy` 带 op-guard 在飞操作名 → 横幅"应用繁忙：正在列举远程目录"（对异步慢操作有效；同步冻结只能事后记录） | A5 |
| `src/shared/trace.ts` | 动作面包屑环形缓冲 100 条（点击 → task start → channel → 主进程 op），失败自动附最近 20 条，tag `[act]` | E5、E6 |
| 日志纪律 | 级别 + tag 过滤 + **异步批量写**（200ms flush）+ 8MB×3 轮转；TreeDialog 轮询**降级为采样**（info 每 N 次记 1 条）而非全关——日志目前是唯一诊断手段，不能关死；`uncaughtException`/`unhandledRejection` 落盘 | A3、C3、E5 |
| 诊断面板（Ctrl+Shift+D） | 版本/运行时长/内存/lag/任务清单/连接状态/最近失败/日志尾 + **[导出诊断包]**（脱敏 password/apiKey） | E5、E6 |

### S7 数据安全 —— 原子写 + 损坏隔离

```ts
writeJsonAtomic(file, data)   // tmp → fsync → rename（Windows 上 rename 覆盖需 EPERM 重试：杀软/索引器）
readJsonRecoverable(file)     // 解析失败 → 备份 .corrupt-<ts> → 返回 Outcome 错误（不是 []）
```

Windows 细节：① `.bak`/`.corrupt-*` **不得复制明文密码**（凭据先拆到独立文件，或备份时剔除）；
② 原子写必须重新施加 `chmod 0o600`（`projects.ts:137-141` 现有行为）；
③ 建议顺便把凭据从 `projects.json` 拆出（D3 的破坏面收敛）。

**头号验收用例**：截断 `projects.json` → 启动明确提示 + 生成 `.corrupt-*` + 一键从 `.bak` 恢复；
且"损坏读之后的 `addRemoteProject` **不得**清空既有条目"（读-改-写放大器）。

### S8 原语与纪律 —— 收编所有轮询/重试

`createSingleFlight({stallMs})` + `createBackoff({base,max})`（`tree-poll-guard.ts` 与 `history-gate.ts` 已是雏形，合并一份）。
规则：**所有 interval / 事件驱动的大载荷调用必须经它**，用规则测试守住。消除 F。

---

## 3. 计划

每阶段独立可发版、可验收。**顺序理由**：A/B/E 直接冲突产品卖点（"在远程服务器上跑 AI 编程"，
远程链路一卡就是卖点本身）；D 低频高损，必须做但可排后。

### Phase 0 — 止血（1 天，最小改动）

| # | 改动 | 对应 |
|---|---|---|
| 0.1 | 提交在飞工作：`ErrorBoundary.tsx` + 不受信解析（`diff-utils.ts`/`tool-summary.ts`/`ChangesView.tsx`/`TreeDialog.tsx`/`styles.css`） | C1 |
| 0.2 | `toggleProject` 的两个 `file.list` await **加 renderer 侧 deadline**（`Promise.race` → error 态 + 清 `remoteHydration`）。注：`try/finally` **不够**（挂起不 settle），必须带超时 | B2 |
| 0.3 | `runPiVersion`/`hasNodeInstalled`/`findViaWhere` 的 `spawnSync` 加 timeout（≥8-10s，避免杀软冷扫描误判 → `cachedPiOk=false`；5s TTL 自愈）。保留"优先 node+cli.js"路径（超时只杀直接子进程，不留 cmd.exe 孙进程） | A1 |
| 0.4 | `render-process-gone` 处理（主进程：落盘 + 提示 + 自动 reload） | C4 |
| 0.5 | 主进程 `uncaughtException`/`unhandledRejection` 落 `pipi-debug.log` | C3 |
| 0.6 | `abort`/`/compact` 的 `rpcSend` 失败要可见（不是 `rpc_stalled`——那条已被 30s/40s 覆盖） | E4 |

**验收（诚实版）**：① 服务器 normal shutdown（发 RST）→ 每个入口 ≤ 该操作 deadline + 2s 出错误态；
② 杀软/断网造成的**挂起**路径在 Phase 0 只覆盖 0.2 的两个 await，其余入口的"≤45s 出错误态"归到 Phase 2 验收。

### Phase 1 — 不卡（1–2 天）

1. `perf.ts` lag 指标 + `app:busy` 归因（**先有数字再优化**）。
2. 日志：异步批量写 + 分级 + 轮转 + TreeDialog 采样。
3. `diff-session.ts:266` 加大小门。
4. 点击路径 sync 调用审计清零（`spawnSync/readFileSync/statSync` 全部带 timeout 或移出点击路径）。

**验收**：多 MB 远程会话 + 树对话框 + 轮询 60s，`[perf]` p95 < 100ms；日志 ≤ 1MB/天（对比峰值 16876 行/天）。

### Phase 2 — 卡不住 + 看得到（2–3 天）

1. S1 `Outcome` + S2 `op-guard`（含 SFTP 中毒/销毁）+ S3 `call()` + 全 channel deadline 表。
2. S4 `tasksStore` + `<LoadState>` + 两段式 deadline（含 4 处真实卡死点迁移 + 旧字段同步删除）。
3. S5 `failureStore` + `FailureCenter` + 重试；B5 的"错误数据契约"删除。

**验收（自动化，"鲁棒性"的定义本身）**：注入"永不 resolve / 立即 reject"的假 api，
**每个面板在 deadline + 5s 内进入终态**（无 loading 残留）；SFTP 超时后 lease 被销毁、下一次调用经熔断快速失败（无 refCount 泄漏）。

### Phase 3 — 查得到 + 数据不丢（1–2 天）

1. 面包屑 `[act]` + 诊断面板 + 导出诊断包（脱敏）。
2. `writeJsonAtomic`/`readJsonRecoverable` 全量替换 + `.corrupt-*` 隔离 + `.bak` 恢复 + 启动自检上报。

**验收**：§S7 头号用例；凭一次失败的 `actionId` 可在日志还原完整链路。

### Phase 4 — 纪律与回归网（1–2 天，可与 2/3 并行）

1. 三张网：**no-eternal-spinner**（假 api hang/reject/慢 驱动全部 pane+store，断言终态）；
   **不受信数据**（畸形 fixture：`{"edits":[{"newText":…}]}` 缺 `oldText`、args 为字符串/null、超深嵌套）；
   **契约表**（每 channel 有 deadline 声明；每轮询经 single-flight）。
2. 所有轮询/重试收编到 S8 原语。
3. CONTEXT.md 追加「稳定性契约」章节（§4 规则 + 违反检测方式）。

---

## 4. 稳定性契约（可检查的规则）

1. **跨进程调用必有 deadline**；deadline 两段式（停滞可见 → 终态错误），不许静默等待。
2. **loading 状态不得手写**：一律来自 `tasksStore`；迁移时同步删除旧字段（禁止双源）。
3. **interval / 事件驱动 + 大载荷 + 慢链路** 必须 single-flight + 失败退避（本项目已复发三次）。
4. **来自模型/网络/文件的渲染期数据 = 不受信**：在 store 边界归一化，禁止解析错误到达 render。
5. **禁止裸 `catch {}`**：要么进 error 态，要么显式 best-effort 并计数上报。
6. **错误不得伪装成数据**（不得把失败文案塞进 `content` 或返回成占位节点）。
7. **用户数据写入必须原子 + 可恢复**；解析失败不得静默返回空值。
8. **失败必须带 code + 原因 + 建议 + 可复制证据**。

## 5. 度量

| 指标 | 现状 | 目标 |
|---|---|---|
| 事件循环 lag p95 | 未知（无指标） | Phase 1 后 < 100ms |
| 日日志量 | 峰值 16876 行/天，累计 11.4MB | ≤ 1MB/天，可轮转 |
| 无终态等待（永恒 spinner） | ≥1 条确定路径 + 多处无 deadline 调用 | Phase 2 后 = 0（测试守护） |
| "从操作到错误可见"时长 | 无上限（常常永不） | ≤ deadline + 2s |
| 未捕获错误 | 只落 console（打包版不可见） | 100% 落盘 + 按 code 聚合 |
| 用户可自助取证的失败 | 0% | Phase 3 后 100% |

## 6. 非目标

- 不引入遥测上传（诊断包默认本地、手动导出）。
- 不改 pi、不 fork（延续 AGENTS.md）。
- 不重写 IPC 为通用 RPC 框架；deadline 表 + Outcome 足够。
- 不做 UI 版式改版：只在"失败 / 停滞 / 任务"三处新增面。
- 不把 `window.api` 全面切换为 `Outcome` 类型（Phase 2 只做内部保证，见 S3 范围界定）。

## 7. 修订记录（v1 → v2，独立评审后）

| 修订 | 内容 |
|---|---|
| 推翻根因 1 | v1 称 `toggleProject` 因 `file.list` **reject** 而永久卡死。实为 `remoteListFiles`/`wslListFiles` catch 全部错误返回占位节点（`index.ts:3076-3105`），reject 几乎不可达；真凶是**已建连接上的挂起**。故 0.2 从"try/finally"改为"必须带 deadline"，Phase 0 验收标准随之诚实化 |
| 推翻根因 2 | v1 把"错误塞进 content"当成孤立小问题；评审后升格为独立根因 **B5"错误伪装成数据"**（占位树节点 + `⚠️` 内容），因为它同时制造"看不到错误"和"垃圾数据被写回" |
| 新增 C4 | `render-process-gone` 0 命中——渲染进程崩溃无处理，"窗口白了"的最直接治理点 |
| 补 A1/A5 | A1 频率需诚实（预热已生效）；A5 承认 lag 指标对**同步冻结**只能事后记录 |
| 补 D3 | 读-改-写放大器：损坏读 + 下一次添加 = 清空全部项目 → 设为头号验收用例 |
| 修 S2 | op-guard 必须强制 SFTP `onTimeout`（中毒 + `destroySftpLease`），否则 refCount 泄漏、lease 永久驻留 |
| 修 S3 | 明示豁免 `rpcRequest`/`waitUntilAlive`/`waitConnState`/`writeInput`；Phase 2 **不**做渲染层全量 `Outcome` 迁移 |
| 修 S4 | deadline 两段式定义收敛到一处；新增 `background` 豁免（防警报疲劳 + 防调用点绕开注册表）；迁移必须同步删旧字段（防双源真相） |
| 修 E4 | `rpc_stalled` 冗余（已被 30s boot + 40s no-output 覆盖）；真正有价值的是 `abort`/`/compact` 的 `rpcSend` 失败可见 |
| 修 S7 | Windows EPERM rename 重试、备份不含明文密码、`chmod 0600` 重施 |
| 修 E5 | 日志轮询"降为采样"而非"全关"（日志是唯一诊断手段） |
