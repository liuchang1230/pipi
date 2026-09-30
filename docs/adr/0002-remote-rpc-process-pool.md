# ADR 0002：远程 RPC 进程复用（预热空进程池）

Status: **rejected**（2026-09-29）— M1 实测证伪了前提（§实测（M1）），随后**真因被找到并修复**（§结案）：那 ~7 秒是 pi 的 rewind 扩展在每次会话启动时对工作区跑 `git add --all`，而项目里刚多了 **196 张无人机航拍图（1.53GB）** 未跟踪文件，**与远程链路无关、与进程池无关**。修复后打开远程标签的可见等待 p50 **10.9s → 3.7s**（回到健康基线 3.5s；其中 pi 自身 7.2–8.2s → 1.7–1.9s），零代码改动。M2/M3 不必再测。

## 动机

远程/WSL 的每个聊天标签都独立 `spawn pi --mode rpc`（`src/main/rpc-session.ts:711` `createRpcTab` → `:747` `new RpcSession`）。看到这点很自然会想到 Codex 的 `app-server`（一个常驻进程托管 N 个 thread），于是想做个进程池。

但本文档写完前提、量完数之后，结论反了过来：**池化不是当前该做的事**（见 §实测（M1））。保留这份文档是因为推理链与量测方法仍然有价值，且上游条件变化后结论可能反转。

对照 Codex：它的 `app-server` 是**一个常驻进程托管 N 个 thread**（`thread/start` / `thread/resume` / `thread/fork` 是同一进程上的方法），VS Code / IDEA / 桌面 App 共用，所以第二个会话是瞬时的。*（外部信息，非本仓库可核实：见 openai/codex 的 `codex-rs/app-server` 及其 README。本文档不拿它当依据，只当作方向参照。）*

而我们**本地路径已经是这个形态**：`src/main/chat-backend/sdk-host.ts:93` 一个 `worker_thread` 托管全部本地会话；`sdk-worker.ts:319` 每个 tab 一份 `session.subscribe` 闭包，因此事件天然带 tabId；`sdk-worker.ts:508` 已经在活进程上做 `switchSession` + `rebindSession`。

**所以远程的落后不是设计选择，是 RPC 线协议的缺口**——这是本文档最重要的**结构性**结论，也决定了哪些方案可行（但**该不该做**由 §实测（M1）决定）。

## 实测（M1：来自用户真实日志，2026-09-29）

方法：解析 app 自己的日志 `%APPDATA%/pipi/pipi-debug.log*` 里的 `[rpc] … SPAWNED` 与 `… FIRST BYTES` 两个打点（现有代码已有，无需新埋点），按 spawn 时间戳去重后统计。两个日志的边界恰好落在 09-24 03:00 前后。

| | 旧日志（08-21 → 09-24 02:47） | 当前日志（09-24 03:29 → 09-29） |
|---|---|---|
| 覆盖 / 体量 | ~34 天 / 142,920 行 | ~5 天 / 5,733 行 |
| **spawn→首字节（= 打开远程标签的可见等待）** | **p50 3.5s**，min 1.2s，max 16.2s（n=204） | **p50 10.9s**，min 2.9s，max 19.7s（n=26） |
| `get_state` 往返 >3s 的次数 | **0 / 204** | **26 / 26**（最大 19.8s） |
| `sftp op timeout after 60000ms` | **0** | **21** |
| 主机 | `crscu@192.168.10.49` | 同一台 |

**四个结论：**

1. **「远程启动 15–20s」不是基线，是一次刚开始 5 天的劣化。** 基线（34 天、204 次采样）是 **3.5s**。代码里那 4 处 `15-20s` 注释（`src/main/rpc-session.ts` 三处 + `src/renderer/src/dialogs/TreeDialog.tsx` 一处）写于 08-21（`cfe70b0`）——而当时同一台服务器的中位数正是 3.5s，那些话是从当日极值（16.2s）推广出来的，属于**误导性注释**，**本次已全部修正**。
2. ~~**责任在远程侧/链路，不在 app。**~~ **此归因被 §结案 推翻。** 当时观察到的事实是真的（劣化前后 app 下的命令逐字节相同，都是 `cd '…' && bash -ic 'pi --mode rpc'`；app 在 `SPAWNED` 后 2ms 内就发出 `get_state`，随后 15s 一个字节都没收到），但**「时间落在远程」被错误地读成了「原因在远程」**：那 15s 里确实全在 SSH 连接 + `bash -ic` + pi 启动之内，而其中 **~6.5s 是 pi 自己启动时在跑 `git add --all`**（§结案），服务器负载、网络路径均无问题（`nproc` 80、load ~52%、无内存压力、无孤儿进程）。教训：**看到「远程慢」必须先抓远程侧的子进程/syscall，再谈链路。**
3. **池化解决不了这个问题。** 池化省掉的是「冷启」，而当时冷启的大头是 pi 内部的 `git add` —— **预热池里的进程同样要付这笔钱**（它启动时一样跑 rewind 快照），只是把等待从「打开标签时」挪到「池预热时」。即便抛开这一点，健康状态下池化能省的也只是 **3.5s → 交接耗时**，量级不足以支撑本文档列出的那些新增失败面。
4. **旧基线 3.5s 现在完全分解得开**：SSH 握手 1.48s + `bash -ic`（`.bashrc`）1.44s + pi 冷启 ~0.6s ≈ **3.5s** ✓。劣化只是在这三项之上又叠了 ~7s 的 `git add`。这三项都是**与本 ADR 无关的独立小问题**。

**当时的排查手法（保留为方法记录，实测值已回填）：**

```bash
time ssh crscu@192.168.10.49 true      # 1. 纯 SSH 握手 → 实测 1.48s（正常，非元凶）
time bash -ic true                     # 2. 交互式 shell（.bashrc）→ 实测 1.440s（真实，但只有 1.4s）
time bash -lc true                     # 3. 登录非交互对照 → 实测 0.020s
time pi --version                      # 4. pi 自身冷启 → 实测 0.501s（正常）
# 5. 真正的元凶要靠抓 pi 的子进程才看得见（§结案）：
#    pi --mode rpc & 然后循环  ps -eo pid,ppid,etimes,cmd | awk -v p=$PID '$2==p'
```

若将来要省「交互式 shell」那 1.44s，可评估 `bash -ic` → `bash -lc`（登录但非交互，通常不跑 `.bashrc` 里的交互式慢块，仍能拿到用户 PATH）。但 `-ic` 是 08-07（`8db621d`）为拿到用户 PATH 特意引入的，此后未变（09-08 的 `365284c` 只改了一行提到它的注释），换之前必须在目标机验证 `pi` 仍在 PATH 里（该机上 `bash -lc 'command -v pi'` → `/home/crscu/.local/bin/pi`，可行）。

## 结案（2026-09-29）：真因 = pi-rewind 每次会话 `git add` 整个工作区

**症状**：远程标签打开后 p50 10.9s 无响应（`get_state` 26/26 超 3s）。抓 pi 的子进程才看到真相：

```
pi PID=3837235   cmdline=node /home/crscu/.local/bin/pi --mode rpc
  child=3837660  git add --all -- .gitignore AGENTS.md backend/app/...
                 cwd: /data/liuchang/CRSCU Intelligence Algorithm Platform   ← 同一进程活了 3s+
  child=3838068  git add --all -- backend/scripts/DJI_2026.../DJI_20260922165443_0056_V.JPG ...
out=0B   ← 这些 git add 跑完之前，pi 一个字都不吐
```

**机制**（`pi-rewind` 0.5.0，`~/.pi/agent/npm/node_modules/pi-rewind/src/core.ts:362-399`）：扩展每次会话启动都 `createCheckpoint()` →
`GIT_INDEX_FILE=<tmp>`（临时索引，**不污染用户真实 index**，这点是好的）→ `read-tree HEAD` 播种 →
`getFilesToAdd()` 用 `git status --porcelain=2 -z --untracked-files=all` 枚举 → 按 **100 个一批** 跑 `git add --all -- "<p1>" …`。
因为临时索引只播种了 HEAD 的树，**所有未跟踪文件都要重新读全文算哈希**。

**为什么恰好是 09-24**：项目 `backend/scripts/` 下在 09-22/24 前后被灌入一批无人机航拍图（文件名 `DJI_20260922*`），实测 **196 张 JPG / 1.53GB**（平均 7.97MB，最大 15.31MB）。pi-rewind 本有两道安全阀，**一道半失效**：

| 安全阀 | 阈值 | 实际 | 结果 |
|---|---|---|---|
| `MAX_UNTRACKED_FILE_SIZE` | 10MB / 文件 | 196 张里 **21 张超限被跳过，剩下 175 张仍逐个哈希** | △ 只挡住 11% |
| `MAX_UNTRACKED_DIR_FILES` | 200 文件 / 目录 | **196** | ✗ **差 4 个文件漏过** |

→ 每次启动仍要读约 1.4GB 算哈希。（同一仓库里名字带 `DJI_` 的图其实有 1493 张 / 7.9GB，但绝大多数躺在已被 `.gitignore` 的 `storage/` 下，**不参与**——真正被哈希的只有 `backend/scripts/` 这一处。）实测对照：`git status --porcelain` = **0.016s**（仓库本身健康），`git add -A --dry-run` = **10.064s**。

**修复**（远程 `.git/info/exclude` 追加一行；**本地忽略**：不改 `.gitignore`、不进 `git status`、不动任何被跟踪文件、随时可删）：

```
backend/scripts/DJI_*/
```

| 指标 | 前 | 后 |
|---|---|---|
| `git add -A --dry-run` | 10.064s | **0.024s** |
| 参与哈希的图 | 196 张 / 1.53GB（其中 175 张真被哈希） | **0** |
| `pi --mode rpc` 首字节（**直连，不含 SSH / 登录 shell**，4 连测） | 7.19–8.18s | **1.74 / 1.76 / 1.90 / 1.81s** |
| 复刻 app 真实命令（`ssh` + `bash -ic` + pi）首字节（3 连测） | ~10.9s（日志 p50） | **3.70 / 3.74 / 3.81s**（= 健康基线 3.5s） |

注意上表后两行是**两个不同的量**：直连测的是 pi 自身，复刻测的是用户实际等待。「10.9s → 3.7s」才是与 §实测（M1）同口径的对比。

文件本体未动（那个目录 196 张仍在磁盘上；全仓 `DJI_*.JPG` 仍 1493 张 / 7.9GB）。两个对照实验与「元凶是 pi-rewind」一致：`--no-extensions` = 0.75s、`packages=[]` = 0.69s —— 而 pi-rewind 属于 `packages`（npm 包），不属于 `extensions/`，所以两条命令都整条跳过它；`PI_OFFLINE=1` 无效（它只挡周期更新检查，不挡启动包解析）。

**顺带查清的独立小事**（都不是本次元凶，但都真实）：

- `.bashrc` 值 1.44s（`bash -ic` 每开一个标签付一次）。
- 该服务器**连不上 `registry.npmjs.org`**（`curl` 10s 超时），而 pi 的包更新检查会 `npm view`。已配 `~/.npmrc` → `registry=https://registry.npmmirror.com`（`npm view` 从超时降到 0.5–0.6s）。

**给上游的 issue（`arpagon/pi-rewind`）**：两道阀都是**计数**启发式，对「文件不多但每个都不小」的目录完全无效——196 个 5MB 文件就能把会话启动拖住 10 秒。应加一条**总字节预算**（如累计 >100MB 即停止纳入快照）。

**给本项目的后续（可选）**：目前 `rpc-slow` 只是 `debugLog` 标签（`rpc-session.ts:646`），没有面向用户的提示；`rpc_no_output` 的文案（`ChatPane.tsx:990` / `TreeDialog.tsx:541`）只提了认证失败 / `.bashrc` / pi 未安装，没提「pi 启动了、但卡在扩展的启动期重活」这一档。可补：连续 `rpc-slow` 时提示「远程项目工作区若有大量未跟踪大文件，pi 的快照扩展会拖慢启动（用 `.gitignore` / `.git/info/exclude` 排除）」——让用户第一次遇到就能自查，符合 `docs/invariants.md` 稳定性契约 #8（每个 error code 一条 hint）。

## 约束（已核实，不可绕过）

| # | 事实 | 证据 |
|---|---|---|
| C1 | **事件帧不带 session 标识。** `session.subscribe((event) => output(toJsonEvent(event)))`，`AgentSessionEvent` 无 `sessionId`；帧上只有**请求关联用的 id**（命令 `response` 的 id 与 `extension_ui_request` 的 id 是两套独立空间），没有任何会话标识 | `dist/modes/rpc/rpc-mode.js:263-270`、`dist/modes/json-event.js:16-24` |
| C2 | **一个进程同一时刻只有一个会话。** `new_session` / `switch_session` 是「换掉当前 session 指针」：`rebindSession()` 解绑旧订阅、绑定新订阅 | `rpc-mode.js:228-272`（rebind；订阅切换本体在 `:263-270`）、`:336-343`（new）、`:476-482`（switch） |
| C3 | **切换会拆掉在途回合。** `teardownCurrent` 先 `await session.abort()` 再把旧回合落盘、`dispose()`；`steer`/`follow_up` 队列随对象销毁，不迁移 | `dist/core/agent-session-runtime.js:102-113` |
| C4 | **严格单飞。** `isStreaming` 时 `prompt` 抛「Agent is already processing」，只能 `steer`/`followUp` 入队 | `dist/core/agent-session.js:860-871`、`pi-agent-core/dist/agent.js:227-231` |
| C5 | **cwd 在进程启动时固定，且没有 `--cwd`。** `new_session` 沿用当前 cwd + 当前 sessionDir；**`switch_session` 采用目标文件 header 里的 cwd**、且 sessionDir 变成该文件的父目录；目标 cwd 不存在则 `MissingSessionCwdError` 抛错 | `dist/main.js:452`、`agent-session-runtime.js:147-166`、`:128-145`、`session-manager.js:242-246`、`:1216-1238` |
| C6 | `switch_session` / `new_session` 都不返回新身份，必须随后 `get_state` 读 `sessionId` / `sessionFile`；扩展能通过 `session_before_switch` 取消——扩展侧返回的是 `{cancel:true}`，运行时把它映射成响应里的 `{cancelled:true}` | `rpc-types.d.ts:37-39,103-105,192-199,307-313`、`agent-session-runtime.js:78-88` |

C1+C2+C3 合起来否掉了最直觉的做法（见下节）。C4 决定了并发模型。C5 决定了池的键。

## 被否掉的方案

**把 N 个 tag 复用到一个进程、各自跑回合。** Codex 能这么做是因为 app-server 从一开始就有 thread/turn/item 模型和带标识的通知。pi 的 RPC 是一个单会话 actor，事件无标识 → 客户端无法把一帧归属到某个 tab。硬做只能靠「同一时刻只 attach 一个 tab」的自律，那已经不是复用而是串行；再叠上 C4，两个 tag 同时跑回合根本不可能。

**改协议让我们自己做多会话（在 app 内）。** 那等于把 pi 的 session runtime 抄一份进 main 进程——分叉 pi 的运行时语义，违反 AGENTS.md「不 fork」。正确形态是**提上游**（见 §上游诉求）。

## 决定

> **本决定未被采纳**（2026-09-29，见 Status）。以下保留为设计记录：它记录了 `RpcSession.id === tabId` 这个真实耦合、以及「池键 = `(target, cwd, agentDir)`」这类若将来真要做的结论。**不要照此实施。**

当时决定实施**预热空进程池 + 单 owner 交接（owner handoff）**，而不是多会话复用：

- 进程仍然**同一时刻只服务一个 tab**（`owner`），C1 从威胁变成不变量。
- 池子里养的是**无主的预热进程**：pi 已启动、runtime-services 已加载、可立刻 `new_session` 或 `switch_session`。开新标签 = 从池里取一个 + 交接，而不是冷启。
- 标签变为闲置时**归还**进程（回到池），超过容量上限则杀掉。于是服务端常驻进程数 ≈ 在途回合数 + 池容量，而不是「开过的标签数」。
- **池化只在同一 `(target, cwd, agentDir)` 内进行**（C5）：`switch_session` 的目标 header cwd 必须等于进程当前 cwd，否则拒绝复用、回落到冷启。`agentDir` 进键是因为它决定扩展集与模型配置（同一个 `pi --mode rpc` 进程的扩展在交接后仍然存活）。
- 这一层是**纯客户端**改动，不碰 pi 协议，可 flag 回滚。

一句话：**我们不追求「一个进程多个活跃标签」，我们追求「同项目多次打开不再付冷启」。**（原稿写的是「不再付 15–20s」——那个 15–20s 已被 §实测（M1）证伪，健康冷启是 3.5s。）

## 设计

### 不变量

| # | 不变量 | 违反时的表现（写下来是为了可测） |
|---|---|---|
| I1 | 一个 `PiRpcProcess` 同一时刻至多一个 owner tab | 事件流窜到别的标签 = 最严重的回归，必须有断言 |
| I2 | 只有 owner 能发命令；非 owner 的 `rpc-send` 要么先夺取、要么排队（不得直接写 stdin） | 静默发到别人的会话里 = 数据错乱 |
| I3 | 只用同 `(targetKey, cwd, agentDir)` 的进程做交接，且目标 session 的 header cwd 必须匹配 | cwd 漂移会让后续 `new_session` 写进别的项目目录（C5） |
| I4 | 有在途回合（`streaming` / queued / pending UI request）的 tab 不得归还进程 | 归还即 abort，用户会看到「回合莫名中断」（C3） |
| I5 | 每一步交接都有 deadline，失败的唯一终态是「回落冷启后 tab 可用」 | 与稳定性契约 #1 一致；不允许出现「交接失败 ⇒ 标签打不开」 |

### 组件（= 把 `RpcSession` 拆成「进程」与「标签」两个概念）

现状：`RpcSession.id` **就是** tabId —— `:365-366` 只是声明，真正的绑定是构造器 `:399` 加上调用点 `:711`/`:747`（`createRpcTab` 把同一个字符串同时当 tab id 和 session id 用）；`forwardEvent(this.id, …)`（`:649`、`:656`）与 `tab:rpc-exit:${this.id}`（`:664`）都在构造期绑死了 tab。这是池化的**唯一结构性障碍**。

```
PiRpcProcess        传输 + JSONL + 协议 + per-process 看门狗 + currentOwnerId
                    key = (targetKey, cwd, agentDir)   ← 不再是 tabId
                    acquireByTab / release / switchToSession / newSession / kill
RpcTabHandle        tabId → { process: PiRpcProcess | null, binding: "cold" | "handoff" }
                    事件路由 = 发往 handle.tabId（不再由进程构造期决定）
RpcPool             key → { owned: Set<process>, idle: process[] }   idle 受容量 + TTL 约束
```

关键点：**事件路由发生在 emit 时**——`process.emitToOwner(msg)` 查 `currentOwnerId` 再决定 `forwardEvent` 的 channel。`extension_ui_request`（`:653` `onUiRequest?.(this.id, …)`）同理，且交接时必须清空/拒绝迟到的 UI 请求，否则会出现「对话框弹给了已经不是 owner 的标签」。

### 交接流程（夺取）

```
tab 需要进程
  ├─ 池中同 (target,cwd) 有空闲进程？
  │    ├─ 否 → 冷启（今天的行为，SEND_SILENCE_MS / 40s no-output / 60s stall 看门狗照旧）
  │    └─ 是 → 标记 owned，发 switch_session(sessionPath)   [deadline，建议 15s]
  │             ├─ success:false / cancelled / MissingSessionCwd → 退回池（或杀掉）+ 冷启
  │             ├─ 超时 → 该进程视为污染，kill，冷启   ← 不允许复用「状态未知」的进程
  │             └─ success → get_state 校验 sessionId/sessionFile 与期望一致
  │                          → 绑定 owner，安装事件路由，重置 SilenceWatchdog
  └─ 就绪，发 state_ready
```

交接期间 `app_phase` 增一个新值（现有 `connecting` / `ready` 不够诚实）：`handoff`。渲染层只需要多认一个 phase，**不存在协议改动**——事件 channel 仍是 `tab:rpc-event:{tabId}`，SDK/RPC 双后端「渲染层无感」的既有性质（`docs/chat-backend-plan.md`）必须保持。

参照实现已经在本仓库里：`sdk-worker.ts:599-712` 的 `openTab` 就是「先装订阅再 bind、把 opening 期间到达的命令重放」，`sdk-worker.ts:508` 的 `switch_session` 就是「成功后 `rebindSession`」。RPC 侧的交接要复刻同样的顺序纪律（**先装路由再切会话**），否则会丢掉切换瞬间的事件。

### 改动点

| 文件 | 改动 |
|---|---|
| `src/main/rpc-session.ts:365-670` | `RpcSession` 拆为 `PiRpcProcess`（进程语义）+ `RpcTabHandle`（标签语义）；`forwardEvent` 调用点（`:649`/`:656`）与 `tab:rpc-exit`（`:664`）改为按 owner 路由；`onUiRequest`（`:653`）加 owner + 迟到拒绝 |
| `:566` `armSilenceWatchdog` | 交接时 `noteBytes()` 重置，避免上一任的静默窗口算到新任头上 |
| `:506` / `:518` 启动期看门狗 | 保留为**进程级**（对池中进程只跑一次）；`rpc_no_output` / `rpc_stalled` 的载荷需要带 tabId 才不误导 |
| `:671` `sessions` 注册表 | 改为 `Map<tabId, RpcTabHandle>` + 独立 `RpcPool` |
| `:711` `createRpcTab` | 先尝试 `pool.acquire`，失败/无空闲才冷启 |
| `:812-860` `switchRpcToTerminal` / `switchTerminalToRpc` | 关闭的 tab 必须先 `release` 再 `closeTab`，否则进程泄漏 |
| `src/main/index.ts:2074-2085` `tab:rpc-send` | 改为经 handle 转发；非 owner 时走 I2 的夺取/排队 |
| `src/main/index.ts:2291-2318` switch-terminal/chat | 同上，走 handle |
| 渲染层 | 只加 `app_phase: "handoff"` 的文案；其余零改动 |

### 与稳定性契约的对应（`docs/invariants.md` §稳定性契约）

- #1 deadline：交接（`switch_session` + `get_state`）必须进 `op-guard.ts` / `with-deadline.ts`，且超时在 UI 上可见（`handoff` → 终态「已回落冷启」）。
- #2 loading 派生自注册表：`handoff` 阶段必须进 `tasksStore`（T1 10s 停滞档），不得新写一个手写 flag。
- #3 single-flight：交接天然要 single-flight（同一 tab 不允许并发两次 acquire）。
- #6/#8：交接失败必须是 `Outcome` + code + 人话标题 + 可执行建议（#6 禁止把失败伪装成数据，#8 每个 code 一条 hint），**不得**退化成「静默冷启」——用户会以为是卡顿。
- #7：池状态是内存态，不落盘，无新增持久化风险。

## 权衡（必须摆在明面上）

| | 得到 | 付出 |
|---|---|---|
| 同项目新开会话 / 重开会话 | 健康基线 3.5s → 目标 ~1s 或更低（= `switch_session` + runtime 重建；待量测 M3） | 需要池里真有预热进程，否则无收益；且**冷池首次打开仍要付全额冷启** |
| 服务端常驻进程数 | 从「开过的标签数」降到「在途回合数 + 池容量」 | 池容量本身占服务端内存（待量测 M2） |
| 超出池容量的标签间切换 | — | **从『瞬时』变成『一次交接』**：今天每 tab 自带进程，切换零成本；池化后切到不在热集的标签要付 M3 |
| 命令串行化 | 保持 per-tab（同一时刻只有一个 owner，天然不跨 tab 排队） | 代价是 C4 的单飞在池内被放大：池容量必须 ≥ 真实并发回合数，否则用户会感到「排队」 |
| 故障面 | — | 新增失败模式：交接超时、`session_before_switch` 被扩展取消、cwd 不匹配、迟到 UI 请求、归还即 abort |

**第三行是本文档最重要的取舍。** 池化不是纯赚：它把「标签切换的瞬时性」换成「服务端进程数与冷启延迟」。因此**池容量 0 必须等价于今天的行为**，且默认值应当保守（建议：每 `(target,cwd)` 1 个预热 + 在途进程不池化）。

## 门槛（实施前必须量出的数字）— **已随 §结案 作废**

不量测就实施等于用复杂度换一个想象出来的收益。四个测量，用现有诊断层即可拿到大部分（`perf.ts` / `in-flight.ts` / `debugLog` 已有 SEND/RESP 与毫秒级时间戳）：

| # | 测什么 | 怎么测 | 决策作用 |
|---|---|---|---|
| M1 | 冷启耗时分解：SSH 握手 / node / pi 启动 / 首个 `get_state` | 现有 `debugLog` 的 `SPAWNED` / `FIRST BYTES` / `RESP get_state …ms`；remote vs wsl vs local 分开 | **已测并结案（2026-09-29）**：基线 p50 3.5s，劣化期 p50 10.9s。分解 = SSH 1.48s + `.bashrc` 1.44s + pi 冷启 ~0.6s，**另有 ~7s 来自 pi 内部 rewind 快照的 `git add`**（§结案），已修 |
| M2 | 一个空闲 `pi --mode rpc` 的常驻 RSS（服务端） | 远端 `ps -o rss` 采样，开 1 / 3 / 8 个标签 | ≤ 阈值（如 50MB）则池化收益有限，只是省冷启（未测，已作废） |
| M3 | `switch_session` + `get_state` 交接耗时 p50/p95 | 原型探针：临时扩展或直接脚本，对一个已 boot 的进程反复 switch 两个 session | **否决门槛**：若 M3 与 M1 同量级，本方案不成立，直接砍掉（未测；本 ADR 已因 M1 结案而 rejected） |
| M4 | 真实使用分布：同时打开的远程标签数 / 其中在途回合数 | 本地遥测或人工记录一周 | 定池容量默认值（未测，已作废） |

**决策规则（按 M1 实测修正后；本 ADR 已于 2026-09-29 因 M1 结案而 rejected，以下仅存档）**：M1 已表明健康基线是 **3.5s**，不是 15–20s。于是：

- 若 M3 落在 **数百毫秒**量级 → 收益 ≈ 3s/次开标签，**但不再足以支撑本文档的全部失败面**；只在「开标签极频繁 + 池键命中率高」的前提下才值得做，且应先把池容量默认值定为最小。
- 若 M3 与 3.5s 同量级 → 直接关闭本 ADR（原定的否决门槛已足以毙掉它）。
- ~~无论 M3 结果如何，先修远程劣化~~ → **已完成**（§结案）：p50 **10.9s → ~1.8s**，零代码改动（远程 `.git/info/exclude` 一行）。这笔收益**与本 ADR 完全无关**，不构成做池的理由。

M1–M3 之外，动手前还应用一次性探针把三条载荷行为钉死（否则上面的推理只是「读代码读出来的」）：

1. 起一个 `pi --mode rpc`，跑两个回合，断言**没有任何事件帧带会话标识**（C1）。
2. 在活进程上调 `switch_session`，断言在途回合被 abort、`steer` 队列被丢弃（C3/C4）。
3. 并发调两次 `new_session`/`switch_session`＋`prompt`，断言第二次抛「Agent is already processing」（C4/I4）。

另外：本 ADR 对 `dist/**` 的行号引用会随 pi 升级腐烂。建议加一条**引用自检**（一次性脚本即可：断言行号处确实含被引用的字符串），让上游改动把文档打红，而不是让它悄悄过期。写成这条 ADR 时已有十余处行号错位；**更糟的是本仓库 `src/main/rpc-session.ts` 的引用在写完当天就烂了**（同一次改动在该文件里修正了注释行数，把下方所有引用整体推移了 6 行）——所以自检脚本应当把本仓库的引用也覆盖进去。

## 上游诉求（与本方案独立，可并行）

真正的 Codex 式复用需要 pi 侧两件事：

1. **事件帧带 `sessionId`**（`json-event.js` 的 `toJsonEvent` 输出加一个字段即可）。
2. **一个进程允许并存 N 个 session**（runtime 从「单 session 指针」变成注册表），`prompt` 按 sessionId 路由。

这两条一旦具备，远程路径就能与本地 SDK 路径同构（`sdk-host` 已经证明运行时本身支持多会话）。建议按 `docs/upstream-navigate-tree.md` 的既有模式提上游 PR；我们本轮的池化是**不依赖上游**的过渡方案，且上游落地后池化仍有用（预热进程仍然省掉冷启）。

## Consequences

- 渲染层与线协议**零改动**，`tab:rpc-event:{tabId}` 契约保持。**但影响范围比「只动远程」更大**：本地路径只在 SDK 后端开启时才是池化的；`PIPI_SDK_BACKEND=0`（或 `pipi.backend:"rpc"`）时本地标签同样走 `createRpcTab`（`src/main/index.ts:1282-1288`），也会经过这次拆分的代码路径。回归必须覆盖「本地 RPC 后端」这一档，不能只测远程。
- `RpcSession.id === tabId` 这个隐含耦合被显式拆开，是本次真正的地基工程；即便池化被 M3 否决，「进程身份 ≠ 标签身份」的重构仍然值得（它让 `closeRpcTab` / `switchRpcToTerminal` 的语义不再依赖巧合）。
- `rpc_no_output` / `rpc_stalled` / `rpc_unresponsive` 三个诊断事件的归属需要跟着改，否则池化后诊断会指向错误的标签——**诊断失真比性能不涨更糟**（`docs/robustness-plan.md` 的前提是诊断可信）。
- 池状态是纯内存态：应用重启即空，池永远是「冷的开始」。预热需要预测（最近项目），不要做成「启动时预连一堆服务器」——那会变成慢启动。
- 未做（明确记录）：`bash` 通道（`pi` 自身 shell）、`export_html` 等低频命令的交接期竞态未逐一审计；远端多显示器/多窗口下 owner 路由的 `BrowserWindow.getAllWindows()` 广播（`rpc-session.ts:663`）语义未变但需回归确认。
