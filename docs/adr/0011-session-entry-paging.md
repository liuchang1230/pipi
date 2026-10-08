# ADR 0011：会话树只读「最近一页」，更早的按需加载

Status: **accepted**（2026-10-07）

## 动机

用户报的原始症状是「分支窗口老是弹『界面渲染出错 / RangeError: Maximum call stack size exceeded』，整个软件都会卡死」（崩溃本身：`docs/diagnosis/2026-10-07.md` —— 递归遍历 + 无上界父链，已修）。修完崩溃之后，同一个会话仍然**打开一次要 50-100s、主进程堆 1.3GB**，因为那条路从头到尾没有变过：

1. `tree:from-file` → `TargetFs.readText` → `channel.readAll`：**把整份会话文件读进内存**（远程走 SFTP / 免密 ssh cat）。
2. `parseTreeFileAsync` 把**整行原始 JSON**（含完整 message content）交给渲染层 —— 8 MB 会话 = 8 MB structured clone。
3. 渲染层从全量 entries 建树，行是窗口化渲染的，但这之前 `flattenTree` / 可见性 / 折叠 / 选中回退都跑在全量行上。

实测（本机 `~/.pi/agent/sessions`，见 `docs/diagnosis/2026-10-07.md`）：8.07 MB / 2763 条的会话，行渲染真正需要的字段只有 **0.97 MB（12%）**；其中 **工具结果占 65-73% 的字节、工具调用参数 19-24%、助手正文 2-5%、用户提示词 0.0-0.2%**。而 pi 的协议**只能向前翻**（`get_entries` 的参数只有 `since`，没有 `limit`/`before`），所以「往回读」唯一的路是会话文件；会话文件又是 append-only 的，**最近的对话就是文件尾巴**，一次 ranged read 就能拿到。

同一个判断在本仓库已经落地过两次，只是没落到会话树上：远程侧边栏水合用 range 读头 128KB + 尾 64KB（决策 42），聊天转录 `tail: 120`（`ChatPane.tsx`），以及 `transcript.ts` 那句「history belongs there（会话文件）」。会话树是唯一还在整份读的大载荷路径。

## 决策

1. **树的数据源 = 会话文件的「会话页」（Session Page）**：`tail`（打开时的最新一页）+ `before(cursor)`（更早的页），每页 ≤ `maxEntries`(400) 条、单次读 ≤ `maxBytes`(1.5MB)、整页累计读 ≤ `maxPageBytes`(6MB)；页**按行边界切**，所以页与页首尾相接、可拼接，绝不在条目中间断开。
2. **投影（Projection）是这条路的契约**：`shared/session-page.ts` 的 `projectEntry` 把一条会话条目缩成行渲染真正读的字段 —— `id/parentId/type/timestamp/targetId/label`、`message.role/stopReason/errorMessage/toolCallId/toolName`、正文 ≤200 字预览（**用户提示词整段保留**）、toolCall 的 `id/name/arguments`（其中 `path`/`filePath` 整段保留，其余 ≤200 字）、`compaction.tokensBefore`、`summary` ≤2000 字、`modelId/thinkingLevel/name/customType/command`。投影结果**形状上仍是一条 entry**（`message.content` 还是 `text`/`toolCall` 块数组），所以 `flattenTree`、`applyVisibility`、`searchableText`、行渲染器一行都不用改。
3. **打开 = 最新一页，RPC 只吃增量**：文件页落地后，把 `since` 游标设成这一页最新的 id，之后的 3s 轮询只拿 pi 追加的条目。pi 只在文件页拿不到时才被当作「全量来源」（那是兜底，不是默认）。轮询在文件页落地前不发（`baseSettled` 门），否则第一个 tick 就会去找 pi 要整份会话。
4. **更早的页按需加载**：对话框顶部一个「↑ 加载更早的对话（已有 N 条）」按钮，滚到最顶也触发同一个动作；前插之后按**视口锚点**还原 `scrollTop`（见下第 7 条），所以加载历史不会把视图顶走。一页里没有任何新 id（文件被重写过）就停手并收起按钮，不会循环。
5. **通道能力差异在 seam 之下**：`TargetFs` 公开 `size` + `readBytes`（range 读本来就有：local / WSL-UNC / SFTP 三个通道都实现），免密 ssh 通道回 `transport` 错 → 页读取器降级成**整份读一次**并标 `degraded: "whole-file-read"`（= 旧行为），UI 上说明「该连接不支持分段读取」。单条超大行（实测最长 1.6 MB）：窗口按 ×4 增长直到找到行边界，硬上限 16MB 之外返回 `degraded: "window-too-large"`（无 cursor，页面停在这一页），**绝不循环**。
6. **边界情形的处置（都要求「有界 + 不静默跳过」）**：
   - **一条旧行超出硬上限**：把**已经切好的条目照样返回**（`degraded: "window-too-large"`、`cursor: null`、`eof: false`）——一条巨大的*旧*工具结果不该让最近的对话变成空树；同时不给 cursor，UI 不会点出循环。
   - **读回来的字节少于请求**（文件在读取期间被改写/截断）：窗口的最新边缘落在行中间，接受它就会静默跳过从该边缘到上一页 cursor 之间的所有条目。所以先对短读做有限重试（拼接），仍然短就**停在这一页**（同一个 degraded 标记），不拼出一段有洞的历史。
   - **预算参数不是有限数**（`NaN`/`undefined`）：回退到 `PAGE_BUDGET` 默认值——`Math.floor(undefined)` 是 NaN，一个 NaN 维度会让填充循环变成空转并让 `newestFirst[-1]` 抛异常。
   - **文件读取永久不返回**：两处调用都加 20s 死线（首屏超时 → 落回 RPC 整份读；翻页超时 → 按钮重新可点）。不变量 #1 要的是停滞有界且可见，不是无限转圈。
7. **视口锚定是一个纯函数**：`shared/scroll-anchor.ts` 的 `restoreScrollTop(anchor, newIndex, rowHeight)`，anchor = `{id, index, scrollTop}`（视口顶行 + 当时的行号 + 当时的滚位）。不用「行数 × 行高」是因为前插的行在星形树里落在根行**下面**（实测 `--shape=bush`），而且搜索过滤会把它们整段藏起来；锚点**只在一帧内有效**（`prependSeq` 触发一次布局 effect，无条件清除），否则「前插的行全被过滤掉」时行数不变、锚点留到下一次无关的列表变化，就会把读者拽回几秒前的位置。会话被替换（pi 拒绝 cursor）时另有一个 generation 戳：在飞的翻页结果到达即丢弃，不和新区间的条目拼在一起。
8. **诚实代价（写进 UI 与测试）**：
   - 搜索只搜**已加载页**（行预览文本），"搜索全部"属于后续（主进程扫描/旁车索引）。
   - 边界之上的分支标记/兄弟数只有已加载部分的信息（标记本来就是装饰性契约）。
   - 回滚不受影响：`rollbackToNode` 的时间线来自聊天转录的工具参数，从来不是树条目（只有 `args.path` 从这里读，已整段保留）。
   - 免密远程每次翻页要重读整份文件（通道限制），有 UI 提示。

## Considered Options

- **只加超时/转圈** —— 拒绝。不变量 #1 要的是「有界 + 可见停滞」，不是把 200MB 读得更久；整份读仍然会顶爆主进程堆。
- **等 pi 上游加 `get_entries {limit, before}`** —— 值得提 issue，但不能作为方案：远程 pi 是用户机器上任意版本，我们不能要求它先升级（ADR 0009 就是「不催升级」）。
- **旁车索引 `SessionTreeIndex`（像 `SessionIndex` 那样增量维护 `{id,parentId,type,role,preview}`）** —— 更彻底（打开是读几百 KB 索引，搜索全部也只是切片），但要新增一份缓存与失效规则（不变量 #7 的原子写/版本号），留作后续；本次的 `session-pages` 已经是它需要的那个字节层。
- **一次读全但只传投影** —— 拿不到「远程 60s 读取」这一块的收益（那正是卡死的直接原因），只省了 IPC。

## 后果

- **打开开销与会话长度解耦**：20000 条的实测 —— `from-file tail entries=400 eof=false 20-40ms`，首屏 399 行落在最新一条（`链 19999`），点一次按钮 799 行，滚到顶 1199 行，视口锚定不动。
- **测试**：`shared/__tests__/session-page.test.ts`（投影字段契约、幂等、窗口切分/半行/环）、`main/__tests__/session-pages.test.ts`（页不重叠不缺口、读量有界、超大行、降级、不循环、超大旧行仍返回已切页、短读即停、部分读重试、NaN 预算）、`shared/__tests__/scroll-anchor.test.ts`（锚定几何：行号变化后视口偏移不变、根行场景不动、边框/内边距抵消）、真机 loop `scripts/diagnose-tree-crash.mjs`（tail-first + 按钮 + 滚动 + 锚定 + 载荷有界）。
- **已知未覆盖**：锚点的**生命周期**（`prependSeq` 一帧内有效）只有几何部分进了单测——渲染层没有 DOM 测试设施（不变量：纯展示/数据辅助函数进 `shared/`，其余靠真机 loop）；loop 的锚定断言是在「新开、无过滤」下按行 id 比对的，因此过滤态下的前插只能靠代码注释与这次 review 的结论保证。
- **回归面**：小会话（≤400 条）行为与旧版一致（一页就是全部，`eof=true`，按钮不出现）；`scripts/diagnose-tree-rows.mjs` 增加了「先把更早的页加载完」这一步，因为它的断言打在前面的 fork 上。
