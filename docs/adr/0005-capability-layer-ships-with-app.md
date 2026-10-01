# ADR 0005：能力层随 app 分发（技能依赖的机制必须在软件里）

Status: **accepted**（2026-09-30）

## 动机

用户 2026-09-30 点名"用得最多"的三个技能是 `diagnosing-bugs`、`grilling`、`code-review`。逐个查它们**实际依赖什么**，得到一张很不舒服的表：

| 技能 | 它的核心动作依赖 | 本机有 | stock pipi 有 | app 是否已半集成 |
|---|---|---|---|---|
| `diagnosing-bugs` | 真终端 + 远程执行 + 命令闸 | ✓ | ✓（`pty.ts`、`TerminalPane.tsx`、`ssh-exec.ts`、审批门都是我们自己的） | 是（全部自有） |
| `code-review` | **并行子代理** | ✓ 用户自装的 `~/.pi/agent/extensions/delegation/` | **✗ 没有** | **是，但没有交付本体** |
| `grilling` | **结构化问答** `ask_user_question` | ✓ 第三方 npm 包 | **✗ 没有** | **是，但没有交付本体** |

三条证据：

1. **pi core 故意不带子代理**。上游自己的文档写明「It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash」（`@earendil-works/pi-coding-agent` `docs/usage.md:309`）。而 app 只内置 5 个扩展（`src/main/extension-sync.ts:40-46`），没有一个是委派。
2. **我们已经在为一件没有交付的装置写适配器**。`src/main/extensions/pipi-subagent-model.ts` 的头注释直接点名「pi 的委派代理扩展（analyst/index.ts）」，它的存在意义是让子代理跟随当前会话模型；渲染层还有"子代理模型"设置项（`ModelConfigDialog.tsx:447-450`，提示语直接点名 analyst / reviewer / scout）。**适配器随 app 发，本体没有。**
3. **`ask_user_question` 是第三方 npm 包**（`@juicesharp/rpiv-ask-user-question`，装在用户的 `~/.pi/agent/settings.json:7-11`），而 `src/renderer/src/dialogs/QuestionnaireDialog.tsx`（608 行：标签页、回退、并排预览、多选、提交前总审）**是为它写的渲染器** —— 对没装这个包的用户，这 608 行是死代码。

**危害不是"少了点功能"，是我们在分发会制造错误确定性的文本。** `code-review` 的正文写着「Both axes run as **parallel sub-agents** so they don't pollute each other's context」，第 4 步是「Spawn both sub-agents in parallel」（`skills/engineering/code-review/SKILL.md`）。在没有委派能力层的机器上，这一步不会报错——模型会**在同一次上下文里顺序做完两轴**，而这正是技能自己说更差的那种做法。用户拿到的是"审过了"，而不是"审的时候其实退化了"。

**另外，这些能力层的源码是单点。** 委派层 5 个 `.ts`（44,792 B）+ 3 个 agent 定义（5,557 B）只存在于 `~/.pi/agent/`（`extensions/delegation/`、`agents/{analyst,reviewer,scout}.md`），**不在任何版本控制里**；`~/.pi/agent/git/github.com/earendil-works` 是空的，说明它不是从某个仓库装来的（是自己写的，2026-09-30 09:22-09:25）。丢一次就没了。

## 决策

**技能是"文本"，能力层是"机制"；文本随 app 分发之后，机制也必须随 app 分发。** 否则文本承诺的东西用户执行不了。

1. **收编为一等内置内容**：委派层源码进 `src/main/extensions/delegation/`（目录形状扩展，pi 支持 `extensions/*/index.ts`，`docs/extensions.md:118`），agent 定义进 `src/main/agents/`。**收编是逐字节拷贝，不改一个字**（`sha256` 已逐文件对齐）——改行为是后面的事，先消灭单点。
2. **复用现有四条投递通道**（本机写入、WSL 经 `\\wsl$`、远程 SFTP、远程 key-auth 的 `sh -s`），不新增通道。目录形状与 agents 目录是**新的内容形状**，不是新的传输方式。
3. **所有权必须与技能一致**：技能投递有 `.pipi.json` 账本（用户改过的文件不覆盖，`src/main/skill-sync.ts`），而现有扩展投递是「内容不同就覆盖」（`extension-sync.ts:130-137`）。**接线时必须先解决这个不对称**，否则我们会开始吃掉用户对自己那份委派扩展的修改——而用户正是这份代码的作者。倾向方案：把账本从"技能专用"提升为"app 内置内容通用"。
4. **结构化问答自己提供，不 vendor 第三方包**。app 内置扩展注册与 `ask_user_question` 同形的工具，让已存在的 608 行问卷 UI 对每个用户都活着。理由同 `.out-of-scope/no-cloud-skill-updates.md`：技能/工具是给模型看的指令，等于远程执行面；把第三方代码放进签名包要单独论证供应链与升级责任，而自己实现一个"提问工具 + 回填答案"成本可控。
5. **顺序**（按"解阻塞价值 ÷ 成本"）：
   - **P0 委派能力层投递** —— 解 `code-review` 的阻塞，且 app 的半集成代码立刻从"惰性"变成"生效"。
   - **P1 让分发的技能对能力缺失诚实** —— 缺能力时要有降级说明，不能让文本静默退化（小、独立、现在就是缺陷）。
   - **P2 问答能力层** —— 解 `grilling` 的阻塞，顺带把死代码变活。
   - **P3 证据循环**（判据 / 取证据 / 不放行），第一个实例是"红命令账本"（`diagnosing-bugs`）——纯自有机制，不依赖任何能力层。

## Considered Options

1. **让用户自己装**（`pi install`、手写扩展）—— 拒绝：这就是"用户拿不到"，与 ADR 0004 动机 2 是同一个错误，只是把仓库换成扩展。
2. **把 sub-agent 补进 pi 本体** —— 拒绝：不 fork（`.out-of-scope/no-pi-fork.md`）。pi 明确把它留给扩展，我们就在扩展层做。
3. **vendor 第三方问答包** —— 暂缓。第三方代码进签名包 = 供应链 + 升级责任 + RCE 面，需要单独论证；自己实现同名工具更便宜也更可控。
4. **（采用）收编 + 角色定义 + 复用既有通道 + 账本统一 + 顺序 P0→P3**

## 后果

**好的**：`code-review` 在 stock 安装里真的能跑两轴；app 为子代理写的模型适配与设置项不再指向空气；委派层的单点消失并进入版本控制与测试；`grilling` 的问卷 UI 从死代码变成活的；能力层与技能共享同一套所有权语义。

**代价**：
- 我们开始**维护别人的代码**（这份委派扩展的作者就是用户自己），升级路径与 `.pipi.json` 账本必须一起设计，否则"我们发的"和"用户改的"分不清。
- 目录形状扩展 + agents 目录让投递面变大（更多文件、更多往返），key-auth 通道的探测脚本要覆盖两种新形状。
- **CRLF：实测无害，且因此不能“顺手修”。** 原文担心的「CRLF 污染 agent `.md` 的 frontmatter，`name:` 带上 `\r`」已经实测否定：`skills/engineering/code-review/SKILL.md`（CR=87）、本机已安装的同一份、`~/.pi/agent/extensions/pipi-tree-nav.ts`（CR=65）、`src/main/agents/reviewer.md`（CR=46）**全是 CRLF**，而用户正在跑的那份 pi 正常加载它们（常驻 token 也正常）。pi 的 frontmatter 解析器（与 `delegation/engine.ts:390` 复用的是同一个 `parseFrontmatter`）容得下 CRLF。**所以刻意不做 LF 归一化**：归一化会改变「已经发出去过的字节」，让每台机器上已安装的文件与账本哈希失配，于是被一律归为「用户改过」而**永远不再升级**。代价：本机 `core.autocrlf=true` 且仓库无 `.gitattributes`，新检出得到 CRLF —— 两种换行都得能跑，测试因此断言「逐字节等于打进包里的那份」，不断言某种换行。
- **我们自己的 typecheck 覆盖不到这次收编的 5 个文件**：它们 import pi 内部（`@earendil-works/pi-agent-core` 等）、用 `.ts` 后缀说明符与扩展运行时 API（`pi.registerTool` / `getAgentDir` / `parseFrontmatter`），放进 `tsconfig.node.json` 会让 `typecheck:node` 变红（真的变红过，见 `7f9bed1`），所以那个 config 里 `exclude` 了 `src/main/extensions/delegation`。**它们的第一个失败信号是 pi 加载失败，不是类型检查。** 补偿：端到端测试直接在真 Linux 上装、再读回校验；但提交一个手改的 `engine.ts` 不会被任何本仓检查拦住。

**未落地（下一批）**：P0 投递接线、P1 诚实降级文本、P2 问答能力层、P3 红命令账本。

## 实施状态（2026-09-30）

**已落地一：源码收编** —— `src/main/extensions/delegation/{index,agents,declarations,engine,render}.ts`（44,792 B）+ `src/main/agents/{analyst,reviewer,scout}.md`（5,557 B），逐文件 `sha256` 与 `~/.pi/agent/` 源一致性核对通过（提交 `ac0a5bb`）。5 个扩展源本不能在 `tsconfig.node.json` 下编译，同批修掉（`7f9bed1`）。

**已落地二：账本提升为通用 + P0 投递**（提交 `ff396e5` 抽引擎 + `12320b4` 接线）—— 决策 3 的「所有权不对称」以**把账本从技能专用提升为内置内容通用**解决：

- `src/main/content-sync.ts`：一套所有权规则（只读订阅 + 偏离保留）、一个 `.pipi.json` 账本、四种传输（本机、WSL、SFTP、key-auth ssh）。内容的种类退化为「一个根 + 一个标签」（`SshContentTarget`），不再是引擎里的特例。
- 扩展根住两类所有权：5 个自有扩展 `policy: "overwrite"`（app 维护的源码，旧副本就是 bug），`delegation/**` 5 个文件默认 `preserve`（用户会改）。同目录、同账本，互不干扰。`agents/` 3 个定义同理 preserve。
- 免密 ssh：每根一次 probe→apply，旧版退役作为 trailer 搭在 extensions 那一趟上。往返 1 → 4（加技能那 2-3 次），门控仍是内存里的内容摘要，重连不重传。
- **验证**：全量 1122 passed | 2 skipped（1124）；`npm run smoke:skills-wsl`（真 Linux）2 passed —— 在一个真 shell 上装完两个根、逐字节一致、第二次空跑、**用户改过的 `delegation/declarations.ts` 与 `agents/reviewer.md` 原样保留**、我们自己被篡改的 `pipi-tree-nav.ts` 被恢复。这条正是决策 3 要的那个保证。

**未落地**：P2 问答能力层、P3 红命令账本；以及下面三项已知限制。

**已修（补记四，同日；补记五，2026-10-01）**：

- **P1 诚实降级文本**：`code-review` 的正文与常驻 `description` 不再断言两轴“在并行子代理里”跑（那在我们那台还没同步的机器上是假的），而是写出真实调用形态（一次 `reviewer` 调用带两条 `tasks`）与拿不到时的降级，并要求**报告交代两轴到底是分着跑的还是一个上下文里跑完**；overlay 因此多了一条规则（`manifest.overlay.rules`），`src/main/__tests__/shipped-text-capabilities.test.ts`（4 条）把“文本命名的能力必须真的发出去”钉在打包字节上。细节与反向验证见 ADR 0004 补记四。

- **写入原子化**（原为已知限制，见下）：四条通路（启动同步 / WSL 异步 io / SFTP / 免密 ssh 脚本）全部改成「写 `<目标>.pipi-tmp`，再 rename 覆盖目标」。半截文件因此永远不会出现在目标位置，也就永远不会被账本记成「我们的」而在下一次被误判为用户修改。细节与实测见 `TMP_SUFFIX`、`replaceViaRename()` 与提交说明；验证：全量 1133 passed | 2 skipped（1135），`npm run smoke:skills-wsl`（真 Linux）2 passed，含新增的「整根目录下无 `.pipi-tmp` 残留」断言。

- **失败变成可上报的信号**（原为已知限制，见下）：ssh 应用脚本现在以 `set -e` 开头，写入拆成两条语句，账本写在最后 —— 任何一次写入失败都让脚本以非 0 退出，`apply.ok` 为假，调用方不标记「已同步」、下次连接重试；账本也因此只在全部写入成功后才更新。同一批还修了「账本存在但读不出来被当成空账本」（会在远端写下一条假结论）。

- **补记五见 ADR 0004**（2026-10-01）：`set -e` 在 `A && B` 左侧不生效的实测、`@@ju` 标记与 `journalUnreadable` 拒绝同步、退役不接 `|| true` 的理由。验证：全量 1141 passed | 4 skipped（1145），`npm run smoke:skills-wsl`（真 Linux）4 passed。

- **「读不到」不等于「不存在」，四条通路一个语义**（2026-10-01，同一批里 io 缝的那一半）：`ContentIo.read` 的契约写死为 `null` = 不在、文本 = 内容、`UNREADABLE` = 在但读不出来（`ContentIo` 的注释就是契约）；`nodeContentIo` 只把 `ENOENT`/`ENOTDIR` 当缺席，`EISDIR`/`EACCES`/`EPERM`/`ELOOP` 一律 `UNREADABLE`；`sftpContentIo` 在 `get` 失败后再问一次 `exists`（真库是 `lstat`）来区分「没有这个文件」和「不让我读」——`get` 本身把两者都 reject。本机启动路径（`ensureContent`）同步跟上：单个文件读不出来就保留并上报（不再让一个读不出文件阻断整次升级），账本读不出来则整次拒绝。`logDivergences` 拿到 `current` 后说「could not be read」，不再对没看见过的文件猜「edited by the user」。验证：全量 1148 passed | 4 skipped（1152），`npm run smoke:skills-wsl`（真 Linux）4 passed，另加一次实跑——真机 `~/.pi/agent/skills` 的副本上 `ensureContent` 仍是 `{"written":[],"diverged":[],"retired":[]}`，真机 `~/.pi/agent/{extensions,agents}` 的副本上 `ensureShippedAgentHome` 仍是 `{"extensions":[],"agents":[],"diverged":[],"retired":[]}`。

**已知限制**（不藏，各自独立可修）：

- ~~**写入不是原子的**~~ → **已修，见上**。原表述：`base64 -d > 目标文件`，中途失败会留下半个文件，而账本已经把它记成我们的 —— 下次同步会因哈希不符而当成「用户改的」保留，也就是永久坏在服务器上。
- ~~**写入失败本身仍不算失败**~~ → **已修，见上（`set -e` + 两条语句）**。原表述：免密 ssh 那条是一串 shell，退出码取最后一条命令（账本那一行），所以某个文件写失败不会被判为 `ok: false`；下一次连接因为账本没变而重试。
- **失败仍然只到日志**：`syncKeyAuthExtensions` 把失败写成 `console.error` 并跳过「已同步」标记（于是会重试），渲染层不显示。与下面那条「渲染层措辞不准」同源，都是提示文案的事。
- **渲染层措辞不准**：扩展投递后弹出的提醒仍写「内置扩展已更新」，而现在列里会出现 `reviewer.md`、`delegation/index.ts`。改一行字的事，但 `App.tsx` 当时在别人未提交的改动里，没碰。
- 上文「typecheck 覆盖不到收编的 5 个文件」仍然成立。
