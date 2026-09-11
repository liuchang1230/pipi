# 远程聊天历史改走会话文件（seam + 对账规则）

状态：Stage 0/1/2 已完成；**Stage 3 的价值经实测后已下调，见 §1.2**
目标：让「历史传输」不再占用 `pi --mode rpc` 的命令循环（agent 因此"像卡住"），并让重复读取的成本从 O(整段) 降到 O(增量)。

## 0. 问题与证据

| 现象 | 实测/代码证据 | 根因 |
|---|---|---|
| 远程 tab 历史加载 17–45s | `pipi-debug.log`：`get_messages` 往返 17.8s / 33s / 44s / 28s / 15.5s | 载荷是整段 transcript JSON |
| 「我的 agent 卡了」 | CONTEXT.md：rpc-mode 每条响应后 `await waitForRawStdoutBackpressure()`，命令循环串行 | 传历史的同时 `prompt`/`get_state`/`get_entries` **物理排队**在它后面 |
| 三个多 MB 请求同时在飞 | 08:32:03.062 / .071 / 08:32:04.923 | 无在飞闸门 + 15s 超时丢响应（Stage 0 已修） |
| 内存尖峰 | `[mem] tick rss=631MB heap=489/555MB` 落在 08:26:08–08:26:53 的 `get_messages` 窗口内 | 主进程缓存整份载荷，渲染层反复重解析 |

**结构性判断**：远程链路里最稀缺的是 RPC 通道（串行 + 背压闸）；会话 JSONL 是 append-only、可按字节寻址、且走另一条通道（SFTP/UNC/本地 FS）的资源，**与 agent 的命令循环不争**。这与本仓库既有分工一致（`tree:from-file`、`hydrateRemoteSessionsRange` 范围读、本地 `session-watcher`）——聊天 transcript 是最后一个还在用昂贵通道搬批量数据的地方。

## 1. 实测结论（先量再定，两处推翻了我最初的假设）

### 1.1 `get_messages` 的语义 = compaction 之后的窗口，不是完整分支

pi 侧（`dist/modes/rpc/rpc-mode.js:536` → `core/agent-session.js:681`）：

```
get_messages → { messages: session.messages }        // = agent.state.messages
compaction 后：agent.state.messages = buildSessionContext().messages   // agent-session.js:1542
```

而 `buildSessionContext` 的权威注释（`session-manager.js:583`）：**"handles compaction summaries and follows the path from root to current leaf"**。算法是 `buildContextEntries`（`:198`）：取 root→leaf 路径，**只有最后一个 compaction 生效**——它自身贡献一条 summary 消息，只保留 `firstKeptEntryId` 起的条目，更早的丢弃。

**量化**（本机 3 个最大真实会话）：

| 文件 | 文件大小 | message 条目 | 完整分支 | **`get_messages` 实际返回** | compaction |
|---|---|---|---|---|---|
| 6.96MB | 7.27MB | 2944 | 2716 | **452** | 8 |
| 5.53MB | 5.76MB | 893 | 893 | **697** | 1 |
| 5.10MB | 5.28MB | 671 | 671 | **671** | 0 |

→ "完整分支"比 pi 实际返回的大 **6 倍**，既不是 pi 的语义、载荷也大得多。**必须镜像 pi 的 compaction 语义，不能简单地把分支所有消息都发出去。**

### 1.2 字节数不是收益——`get_messages` 的载荷 ≈ 文件大小

| 文件 | 文件 | `get_messages` 载荷 | 载荷/文件 |
|---|---|---|---|
| 6.96MB | 7.27MB | 0.82MB | 11.2% |
| 5.53MB | 5.76MB | 4.84MB | 84.1% |
| 5.10MB | 5.28MB | 5.20MB | 98.5% |

**未压缩会话里，`get_messages` 载荷几乎等于整个文件**（它发的就是那些消息）。所以"读文件"在**首次**加载上**不省字节**，甚至可能更贵（压缩会话要读 6.96MB 才能得到 0.82MB 的结果）。

也测过"只读最后一个 compaction 之后那一段"：文件 1 只需 14.7%（1.12MB，优于 0.82MB 载荷的 1.4 倍），但文件 2 需要 **85.5%**（5.17MB）。→ **尾部窗口不可靠，必须带回退**，不能作为唯一读法。

### 1.3 因此真实收益只有三条（都不含"首次更快"）

1. **不占 RPC 通道**：agent 的命令循环不再被历史传输挡住 —— 这正是用户报的"卡"。（会占用同一条网络带宽，所以墙上时间**不一定**变短。）
2. **增量**：文件 append-only，二次/后续读取只传 delta；`get_messages` 永远重发全部。**这是唯一能把成本从 O(整段) 降到 O(增量) 的机制。**
3. **pi 已死/卡住时仍可读**（`tree:from-file` 已在利用这一点）。

## 2. 关键发现：硬骨头已经写好

| 能力 | 现状 | 位置 |
|---|---|---|
| 每个 tab 定位会话文件 | `tab.sessionPath`，未链接时 `findRecentSessionFile(tab)` 兜底 | `index.ts:2201` |
| **四条读取通道** | 本地 / WSL UNC / SFTP 密码 / ssh 免密（pi 死也能读） | `session-file-reader.ts`（**Stage 1 已提取**） |
| SFTP 范围读 | `hydrateRemoteSessionsRange`（head/tail）、`remoteReadFile`（定位读） | `index.ts:3196`、`3268` |
| 扁平条目解析 + 叶子语义 | `parseTreeFileAsync`；叶子 = 最后追加的条目，与 pi 的 `buildSessionPath` 一致 | `tree-from-file.ts:63` |
| pi 的分支/DAG 语义 | `buildTreeFromEntries`（已带单测） | `shared/tree-build.ts` |
| **pi 的 context 语义（含 compaction）** | `shared/transcript.ts`（**Stage 2 已实现，镜像 pi**） | 新 |

## 3. Seam 放在哪里（design it twice 对比）

要隐藏的行为：定位文件 → 便宜地读（范围/增量）→ 解析 → 解析当前 context → 归一化 → 决定文件与实时流谁权威 → 无法读时回退。

| | 方案 A：渲染层 `TranscriptSource` | 方案 B（选中）：主进程一个 IPC | 方案 C：通用 `SessionLog` 模块 |
|---|---|---|---|
| 接口 | `sourceFor(tab).load(since?)`，渲染层在两个 IPC 间选 | `session:transcript` 一个方法，主进程内部决定通道 | `open(target,path).readFrom(offset).branch(leaf)` |
| 深度 | 中——只隐藏"哪条通道"，解析/分支/游标仍在外 | **高**——隐藏定位+四通道读+解析+context+回退 | 最高——但为 1 个消费者造通用抽象 |
| 局部性 | 拆分：选择在渲染层、机制在主进程 | **高**——与 `SessionIndex`/`FileTreeIndex` 同款 | 最高 |
| 风险 | 小，但渲染层仍要懂游标与两套错误模式 | 中 | **大**：只有 1 个消费者时提前一般化 |
| 结论 | 只是搬分支，不是搬责任 | **取此** | 暂不取，但取其内核（一个纯函数） |

**采用方案 B + 取 C 的内核。** 渲染层接口因此**变小**（不再知道"历史走哪条通道、该给多少超时"），这是真实深度。纯的 context 解析放 `src/shared/`（`tree-build.ts` 已在那里），拿到复利内核而不提前承诺 C 的接口。

**Stage 1 的额外收益**：`tree:from-file` 里四通道读取原本**内联**在 handler 中；提取后立刻有两个消费者（树对话框 + transcript）→ **真 seam 而非假设 seam**。

## 4. 对账规则（真正的难点）

- **R1 前缀 + 实时，不做内容合并。** 文件提供前缀，实时 RPC 事件提供其后的增量。禁止按内容去重/合并——那是重复与错序的唯一起源。沿用既有代数：`initMessages` 仅在仍是"最新一次请求"时应用（`historyRequestSeq` 守卫）。
- **R2 只读到最后一个 `\n`。** pi 正在写时尾部是半行，一律丢弃。
- **R3 叶子 = 最后一条带 `id` 的条目**，与 pi 的 `buildSessionPath` 一致（未知 id 回退到最后一条条目；`null` = 无叶子）。已知分歧只有一个：内存里已导航分支但未落盘——由 RPC 事件修正，与树对话框沿用同一分歧。
- **R4 回退，绝不硬依赖。** 无 `sessionPath` 且定位失败 / 读失败 / 解析出 0 条消息 / **条目 → context 与 pi 语义不符的极端情况** → 回退现有 RPC 路径（Stage 0 的 120s + 单飞仍在）。这条是能安全上线的关键：文件格式若变，退化结果是"慢但正确"，永不是"空白或错误 transcript"。
- **R5 作用域限定远程/WSL。** 本地与 SDK 继续走 RPC（进程内/本地管道本来便宜），把风险面限定在真正需要它的一侧。
- **R6 并发权威仍是 `history-gate`（ChatPane）。** 文件路径必须挂在同一单飞闸门下，否则轮询与 mount 会双重读取。
- **R7 必须镜像 pi 的 compaction 语义**（§1.1）：不能把分支全部消息发出去。载荷可差 6 倍。
- **R8 首次读取用「候选窗口 + 回退」而不是整份文件。**（**已推迟，原因见下**）因为 §1.2：整份读在首次可能比 `get_messages` 更贵。
  - **推迟理由（重要）**：局部读要能区分「文件里没有 compaction」与「compaction 在窗口之外」，否则会静默产出错误历史。而条目在文件中的**位置顺序 ≠ 路径顺序**（分支导航后可能交错），所以无论窗口多大都无法在不全量扫描的前提下*证明*足够。需要证明就有静默错的余地 → Stage 3 选择**整份读（构造上正确）**，把成本交给 Stage 4 的游标（首次全量之后只读增量）。
- **R9 文件推导必须用 pi 自己的数字校验。** `get_state` 返回 `messageCount = session.messages.length`（= `get_messages` 的长度），于是「文件推导长度 == 该值」可作为一致性证明：不相等 = 文件落后于 pi 内存态（未落盘的导航、刚切换会话、刚压缩）→ 回退 RPC。代价是一次**小响应**往返，而不是多 MB。
- **R10 主进程内部探针的响应 id 必须带前缀，渲染层丢弃之。** 否则内部 `get_state` 响应会进入渲染层的 `state_ready` 分支 → 再入 `requestHistory` → 再发探针，形成**自激回路**。
- **R11 紧跟状态变更的显式刷新路径用 RPC（`preferRpc`）**：fork / 分支导航 / `/new` / `/clone`。它们之后 pi 的内存态才是权威，而文件可能落后；这类路径罕见且由用户触发，付 RPC 传输是正确取舍。**已知残留**：同长度兄弟分支间的导航（长度相等 → 计数校验过不了）靠 `preferRpc` 覆盖，而不是靠计数；若将来出现新的叶子变更路径，必须同样标 `preferRpc`。

## 5. 分期

| 期 | 内容 | 验证 | 交付价值 |
|---|---|---|---|
| **Stage 0** | `get_messages` 超时 120s + `history-gate` 单飞（**已完成**） | 505 测试 | 消除重下风暴 |
| **Stage 1** | 四通道读提取为 `session-file-reader.ts`（端口注入）（**已完成**） | 8 例端口测试 | 真 seam 成立；并修正旧版手写 lease 缺失的 refCount / 出错销毁 |
| **Stage 2** | `shared/transcript.ts` 镜像 pi 的 `buildSessionContext`（**已完成**） | 10 例行为测试 + **永不漂移的差分测试**：用 pi 真实 `buildSessionContext` 当预言机，合成 fixture 覆盖 header/model_change/message/compaction/custom_message/branch_summary/null-content | context 语义与 pi **逐条相等**；量化出"完整分支"大 6 倍 |
| **Stage 3** | 主进程 provider + `session:transcript-from-file` IPC（含 R9 校验、R10 内部 id、R5 作用域）；渲染层 file-first + RPC 回退 + `preferRpc`（**已完成**） | 4 例生产路径测试 + pi 差分；自检 wedge/回路/类型 | **历史不再占 RPC 命令循环**（agent 不再被挤住）；并顺带删掉 4 处无闸门且响应被丢弃的裸 `get_messages` |
| **Stage 4** | 字节游标 + 增量尾读；尾读期间暂停 6s 树轮询 | 二次打开只传 delta | O(整段) → O(增量) 落地 |

## 6. 反方意见（必须正视）

- **首次加载不会更快。** §1.2 已证：载荷 ≈ 文件大小。若用户期待"打开变快"，会失望。真正的改善是 **agent 不再被历史传输挡住** + **重复读取变便宜**。若只想要"打开更快"，唯一途径是**分页/懒加载**（只取最后 N 条、滚动再取）——那是另一个决策，不在本期。
- **镜像 pi 会漂移。** 若 pi 升级改了 compaction 语义，我们可能静默显示错误历史。缓解：`transcript-pi-parity.test.ts` 用 pi 本身当预言机（合成 fixture，确定性），一升级就红；加上 R4 使退化是"慢但正确"。
- **不能 import pi 来实现**（否则保真免费）：pi 的 exports map 不暴露内部路径，而根入口会把整个 SDK 图（100MB+）载入主进程——正是本次要避开的内存开销，且违背 `session-list.ts` 已确立的"自己解析 JSONL，不依赖 SDK"原则。故：镜像 + 测试期预言机。
