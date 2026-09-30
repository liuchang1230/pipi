# 不变量与硬规则

本文件是**可以被代码注释和评审直接引用**的规则源。引规则时引这里，不要引某次讨论。

- 词汇定义：`GLOSSARY.md`
- 规则的来由（谁在什么时候踩了什么坑）：`docs/diagnosis/`
- 历次架构决策（含理由与契约）：`docs/architecture-decisions.md`
- 少数需要完整「动机 / 决策 / 后果」的主题：`docs/adr/`

## 硬规则（无日期，长期有效）

**新增代码违反下列任一规则，在评审里按 bug 处理。** 每条都对应一次真实故障，证据在 `docs/diagnosis/`。

- 点击会话 → 中间页显示的路径上，主进程不允许出现同步全量 JSONL 解析（会阻塞全部 IPC，包括终端流）。一切会话列表读取必须走 SessionIndex（异步 + 缓存 + 增量）。
- 点击路径上主进程不允许出现同步子进程 spawn（`where.exe` / `node --version` / `pi --version` 各阻塞 0.03-1.2s）：检测结果（pi 路径 / node 是否安装 / pi 是否可用）必须在启动时预热并缓存（`warmPiDetection` / 检测缓存），会话文件标题只做首尾 64KB 范围读取。
- 渲染层任何跨面板数据必须放在 store，不得重新放回 App 的本地 useState；App 保持为组合壳 + 事件编排。
- 终端输出（pty → 渲染层）必须合并写；输入路径（渲染层 → pty）不合并。
- 跨 pane 动作必须收进 store action（`viewerStore.openFile` / `sessionsStore.openSession` 族 / `tabsStore.createTab` 族），容器不许把动作重新放回 App 回调；App 的 selector 订阅只覆盖对话框/编排真正读的 slice。
- 对话框是自含模块：状态不回流到 App，App 只持打开标志；store 的 `set` 一律用函数式更新，循环内禁止用一次性快照（会互相覆盖）。

## 稳定性契约 / Stability Contract（2026-09-24）

一次系统性的稳定性整改（诊断与规划见 `docs/robustness-plan.md`）。上面那些"教训"条目是**逐例**修出来的；
这一节把它们固化成**规则**，并写清每条规则靠什么守住。**新增代码违反规则时，在评审里按 bug 处理。**

| # | 规则 | 为什么（本仓库的复发证据） | 靠什么守住 |
|---|---|---|---|
| 1 | **跨进程/跨网络的调用必须有 deadline**，且 deadline 到期必须在 UI 上可见（停滞 → 终态） | `tree-poll-guard`（get_entries 12949 次）→ `history-gate`（get_messages 多 MB 重下）→ 本轮 `get_messages` 17–45s；同一个教训出现三次 | `src/main/op-guard.ts`（主进程，超时**必须**释放资源）、`src/shared/with-deadline.ts`（两侧共用）、`src/renderer/src/__tests__/no-eternal-spinner.test.ts` |
| 2 | **loading 状态不得手写**：从任务注册表派生（置位必复位由构造保证） | 曾有 7 个手写标志分布在 4 个 store，靠"记得清" | `src/renderer/src/stores/tasksStore.ts`（T1 停滞/T2 终态）；`viewerStore` 已迁移，`treeStore`/`sessionsStore` 用 `withDeadline` 兜住 |
| 3 | **interval / 事件驱动 + 大载荷 + 慢链路** 必须 single-flight + 失败退避 | 同 #1 的三次 | `tree-poll-guard.ts` / `history-gate.ts`（待合并为 shared 原语） |
| 4 | **来自模型/网络/文件的渲染期数据 = 不受信**，在 store/纯函数边界归一化 | 畸形 edit args（`{"edits":[{"newText":…}]}` 缺 `oldText`）在渲染期抛错 → 白屏 | `components/diff-utils.ts` 的 `parseEditArgs`/`normalizeEdits` + 根级 `ErrorBoundary` |
| 5 | **禁止裸 `catch {}`**：要么进 error 态，要么显式 best-effort | 多处 `.catch(() => undefined)` 把失败变成"没有反应" | 评审 + `failureStore`（失败必须留痕） |
| 6 | **错误不得伪装成数据**（不得把失败文案写进 `content` 或返回成占位节点） | 远程浏览失败曾返回一行假"文件"；`file:read` 曾把 `⚠️ 读取失败` 当 `content`（会被保存回磁盘） | `src/shared/outcome.ts`（`Outcome` 互斥）+ `robustness-smoke.mjs` 的断言"失败读 → 有 error 且 content 为空" |
| 7 | **用户数据写入必须原子 + 可恢复**；解析失败不得静默返回空值 | `writeFileSync` 直写 + 读失败 `return []` + `writeProjects` 读-改-写 → 一次损坏读就把全部项目写没 | `src/main/json-store.ts`（tmp→fsync→rename、`.bak`、`.corrupt-*`、**写封锁**）+ `projects-corrupt.test.ts` |
| 8 | **失败必须带 code + 人话标题 + 技术原因 + 可执行建议 + 可复制证据** | 三种错误契约并存；错误是现场拼的字符串，无法聚合也无从下手 | `shared/outcome.ts`（每个 code 一条 hint）、`failureStore` + `FailureCenter`（持久 + 复制全部） |

**诊断层**（"卡"和"没反应"必须能变成数字，而不是感觉）：
- `src/main/perf.ts` + `src/main/in-flight.ts`：事件循环 lag 采样 + **归因**（启动时对 `ipcMain.handle` 打一次补丁，
  覆盖全部 handler，无需逐点记账）→ 渲染层「应用繁忙（延迟 Xms）· 正在：ipc:file:list」。诚实边界：同步冻结只能事后记录。
- 日志：`PIPI_LOG=debug|info|warn|error`（默认 info）。逐帧 RPC、轮询路由、对话框轮询是 **debug**；
  失败一律 warn（立即落盘）。异步批量写 + 8MB×3 轮转。实测 11.4MB/13 万行 → 一次完整运行 ~345 字节。
- 异常必须落盘：主进程 `uncaughtException`/`unhandledRejection`、渲染进程 `render-process-gone`（+ 单次自动 reload）、
  配置损坏（`config:problems` 拉 + `config:corrupt` 推）。
- 真机回归：`npm run smoke:robustness`（CDP 驱动打包版，26 项断言，不依赖模型回复；含"损坏配置必须被用户看见"）。

**尚未覆盖（已知缺口，别当成已修）**：S3 preload 全 channel deadline 表（现由 op-guard 60s + 调用点 `withDeadline` 覆盖）；
`treeStore.fileTreeStatus` / `sessionsStore.projectLoading` / `remoteHydration` 未迁到任务层（缺"10s 停滞"那一级，
但已有 30s/60s 终态）；失败面只有少数调用点 opt-in；**远端/WSL 路径只能靠真机使用验证**（smoke 覆盖不到）。

