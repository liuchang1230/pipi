# ADR 0012：聊天历史也只读「最近一段」，不再整份读会话文件

Status: **accepted**（2026-10-07）

## 动机

用户报「打开一个长会话，会话历史加载很慢，有时要一分钟」。日志把它钉死在一个数字上（`pipi-debug.log`，同一台远程机器、同一个 tab）：

```
12:55:22.992  SPAWNED  pi --session <62MB 的会话文件>
12:55:26.988  FIRST BYTES                                    ← 4.0s，远端 pi 自己装载会话
12:55:27.018  [rpc-slow] get_state 3979ms                    ← 又 4.0s（含 pi 启动等待）
12:56:17.824  [transcript] from-file OK messages=900 tail=120 ← 又 50.8s
```

`tail=120` 是**最后**才切的：`session:transcript-from-file` → `readSessionFileText`（整份 62MB，SFTP）→ `parseTreeFileAsync`（逐行 `JSON.parse`）→ `sessionContextMessages`（回走整条父链）→ `slice(-120)`。而渲染层只显示尾部（`ChatPane` 的 `TRANSCRIPT_TAIL_MESSAGES = 120`，首屏 `INITIAL_VISIBLE = 60`，更早的从**已加载数组**里翻）。同一个 tab、同一条链路，会话树在 ADR 0011 之后只要 **1453ms** —— 聊天历史是唯一还在整份读的大载荷路径。

本机实测（真实会话文件，`src/main/__tests__/transcript-tail-real-sessions.test.ts` 会跑同样三条）：

| 会话 | 大小 | 消息数 | 尾部窗口读了多少 | 结果 |
|---|---|---|---|---|
| A | 8.07MB | 281 | **1.43MB（18%）** | 281/281 条，complete |
| B | 7.30MB | 452 | **1.43MB（20%）** | 最后 399 条（后缀），非 complete |
| C | 10.49MB | 99 | 5.72MB（55%，含一次完整的兜底读） | 99/99 条，complete |

会话 C 是「一条 9MB 的单行」那种病态文件：窗口切不出完整条目 → 触发一次**完整读**兜底（见下）。

## 决策

1. **复用 ADR 0011 的字节窗口引擎**：`createSessionPages(source, { codec })` 现在按「一行变成什么」参数化——会话树用**投影**条目（`projectedCodec`），聊天历史用**原始**条目（`rawCodec`：`parseRawEntry` 保留 message 正文与 compaction 指针，因为 `sessionContextMessages` 要读它们）。窗口切分、边界对齐、有界读、自适应增长、诚实降级全部共用一份实现。
2. **读最新一段就够**：`transcriptTailFromSource` 从 EOF 往前翻页，直到**解析出 ≥120 条消息**（`TRANSCRIPT_TAIL_MIN_MESSAGES`，与渲染层显示的上限一致）、或到达文件头、或命中 `maxPages`(6) 上限。可行性在于 `sessionContextMessages` 从叶子沿 `parentId` 回走、**父节点不在窗口里就停**：喂一个窗口，它返回的就是真上下文的最新一段——正是聊天要显示的那部分。
   **这段话的精确版本**（复核时被指出，此处写死）：窗口里的解析结果等于「整个上下文，去掉开头、保留末尾」——**例外是窗口里有一次 compaction、而它 keep 的 `firstKeptEntryId` 落在窗口之外**：这时 `contextEntries` 会（照 pi 的语义）把摘要提到最前面、并丢掉所有压缩前的条目，于是结果是 `[摘要, 压缩后的消息…]`——压缩后那一段的尾部，而不是整条上下文的裸后缀。最新消息仍然最新，摘要正是聊天渲染的「上下文摘要」行。真实会话测试按这个精确说法断言（两边都去掉开头的摘要再比）。
3. **一致性证明换了做法**（关键）：原来的校验是 `messages.length === get_state.messageCount`，而那个数**是整个上下文的长度**——窗口读没法算，这正是一直读整份的原因。现在：
   - 窗口**覆盖了整个上下文**（到文件头，或窗口内的最后一次 compaction 的 keep 条目**在叶子的路径上**且在它之前——判定用 `shared/transcript.ts` 的 `compactionClosesContext`，与 resolver 自己的问题一致，**不是**「窗口里有个 compaction 且那个 id 出现在条目集合里」，后者会被旁支 compaction 骗到）时，**照旧**跑严格计数校验；不一致仍然 `ok:false`——但**不再重读整份文件**（窗口已完整，整份读只会再花几十秒得出同一个结论），直接交给渲染层的 RPC 兜底。
   - 否则用**一次** `get_entries {since: <窗口里最新一条 id>}` 探针：它既检验「文件没有落后 pi」（落后就把缺的条目补上），又带回 pi 的权威 `leafId`。
   - **探针的权威性是有条件的**：
     - 探针给的 `leafId` **不在我们手上的条目里**（分支导航的深度超过窗口）→ 直接 `ok:false`。因为 `sessionContextMessages` 对未知叶子会**按位置退回最后一条**——那是用户刚离开的分支——旧代码的长度校验能挡住这种错，窗口读挡不住，所以这里显式挡。
     - 探针**没答**（`get_entries` 报错/超时）但窗口不完整 → **仍然返回磁盘上的尾部**（`ok:true`）。这是刻意的取舍：RPC 兜底（`get_messages`）用的是**同一条 RPC 会话**，探针刚在它上面失败，拒绝就等于让聊天空着；而会话文件是 append-only 且逐条落盘的，最坏情况只是「比 pi 内存少最后几条」，渲染层的实时流会在 pi 回来后补齐。日志里可观测（`tip=-`）。
   - 响应 id 带 `INTERNAL_RPC_ID_PREFIX`；渲染层两处事件消费者（`TreeDialog`、`ChatPane`）都走同一个 `isInternalProbeId()` 判断并丢弃。**这是必须的**：`TreeDialog` 对未知 id 的 `get_entries` 响应会走 `mode="replace"`，把会话树换成那几个条目。
4. **`total` 语义不变**：`complete` 时就是解析出的长度；否则 `max(已解析, pi 的 messageCount)`——`chatStore.initMessages` 用 `total - messages.length` 保留已渲染的旧历史，语义与旧路径一致。
5. **不追 `firstKeptEntryId`**：窗口里那次 compaction 的 keep 条目在窗口之外时，**不**为了它继续往前翻页（默认预算下可能要再翻 2400+ 条目、几 MB，攻掉这条改动的意义）；也不为了让结果变「干净」而丢掉摘要——摘要正是用户需要知道的「这里压缩过」。代价是这种情况下的尾部可能少于 120 条（压缩后的消息不足时），已在上面第 2 条写清；真到这一步说明该会话的尾部很稀疏，16MB 以内会走第 5 条的完整读兜底。
6. **病态文件的一次完整读兜底**：窗口切不出条目（尾部区间落在一条超大行里）或消息极其稀疏时，若会话**不超过 16MB**（`TRANSCRIPT_WINDOW_ESCALATE_MAX_BYTES`），就整份读一次——那正是改动前每次打开都在付的代价，结果是完整上下文（计数校验又生效）。**超过 16MB 不兜底**：60MB 的会话不能因为一条别扭的行就退回整份读，此时诚实地返回已切出的后缀（`complete=false`）。
7. **引擎的两处实测修复**（都是真实会话量出来的，不是推理出来的）：
   - **增长改为增量**：窗口 ×4 增长时只读**新需要的那段前缀**并前插，而不是把整个窗口重读一遍。病态文件上实测差距是「16.5MB 重读」vs「文件本身 10.5MB」——在 SFTP 上就是几秒。
   - **`maxPageBytes` 真正是上限**：增长步也要计入页预算，一页的传输量不再等于 `maxPageBytes + 一个 hardMaxBytes 窗口`。
   - 页面返回 `bytesRead`（本次传输量），让「有界」这句话在日志与测试里可测。
   - 顺带一个真 bug：**降级的页 `cursor` 为 `null`**（设计如此，UI 不能据此翻页循环），而 `complete` 原本只看 `cursor === null` → 会**把截断的窗口当成完整上下文**，随后计数校验必然失败、快路径永远失效（真实数据测试抓到的）。
8. **复核（两个只读 reviewer）之后又修了三处**：`compactionClosesContext` 用**叶路径**而不是「id 在不在条目集合里」（旁支 compaction 会骗过后者，白丢快路径）；探针 `leafId` 不在手上就拒绝（否则会把用户刚离开的分支当答案——这是对旧长度校验的真实回退）；`tip.leafId` 为 `null` 时按**合并后的最新条目**解析（原写法退回 `win.lastId`，会把探针刚取回的新条目丢掉）。另外 `bytesRead` 在「通道不支持分段读」的兜底路径上原本算成 0（其实整份都传了），短读的字节数也没计。

## Considered Options

- **只读窗口但不要一致性证明** —— 拒绝。文件落后 pi（未落盘的导航、刚切换会话）时会显示过期历史，这正是 2026-09-11 那条决策要防的；`get_entries {since}` 探针是一次小往返（同一条 RPC 通道上会话树每 3s 都在用），代价可忽略。
- **让 pi 支持 `get_messages {tail}`** —— 值得提上游，但远程 pi 是用户机器上的任意版本，我们不能要求它先升级（ADR 0009）。
- **把 `total` 报成已加载条数** —— 拒绝。`initMessages` 用 `total - messages.length` 保留旧历史；报小会让「切回来」丢掉滚动历史。
- **不做 16MB 兜底，一律只给后缀** —— 拒绝（对病态小会话是可见回退：本来能看到 99 条，只给 23 条）。
- **兜底不限大小** —— 拒绝（60MB 会话会因为一条别扭的行退回 50s）。

## 后果

- **打开耗时与会话长度解耦到「窗口大小」**：远程 62MB/900 条的消息历史从「整份 50.8s」变成「按需几 MB」，pi 自己的 4s 启动省不掉。
- **测试**：`src/main/__tests__/transcript-tail.test.ts`（尾部等价（含「压缩 keep 在窗口外」的精确形状、旁支 compaction 不得称完整）、停止条件、complete 的来源、降级不得称完整、兜底 vs 不兜底、tip 合并、attempt 契约含「叶子在窗口外必须拒绝」）、`transcript-tail-real-sessions.test.ts`（真实会话上：尾部等价、complete 蕴含全等、读量 ≤ `maxPages × (maxPageBytes + maxBytes)` + 一次完整读）、`session-pages.test.ts`（增量增长不重读、页预算上限、`all()` 一次读完、`size()` 不可知、`bytesRead` 在两条降级路径上都要准）、`shared/__tests__/transcript.test.ts`（`compactionClosesContext` 的叶路径语义、`isInternalProbeId`）。
- **已知未覆盖**：此路径只服务 remote/WSL，而本机 WSL 里没有 node/pi（跑不起来 RPC），所以**没有端到端 IPC 验证**；覆盖来自引擎/读取器/判定的单测 + 真实数据测试 + `tsc`。渲染层（ChatPane）在这条路上没有改动：`session.transcriptFromFile(tabId, {tail})` 的 `{ok, messages, total}` 形状不变。
- **残余代价**：窗口是「按字节有界」，不是「按需最小」——工具结果占字节大头，所以一条 120 条消息尾部仍可能有几 MB（要再小就得做载荷投影：预览 + 展开时再取，本次没做）。
