# ADR 0004：技能随 app 分发（订阅上游，不造市集）

Status: **accepted**（2026-09-30）

## 动机

两件事凑到一起：

**1. 上游技能是白拿的资产，但复制粘贴会静默腐坏。** 证据就在本机：2026-07 手工复制进 `~/.pi/agent/skills/` 的 6 个技能，到 2026-09-30 已经落后上游三处约定而**没有任何人发现**——上游把 `CONTEXT.md` 改名成了 `GLOSSARY.md`（`domain-modeling` 里 `CONTEXT-FORMAT.md` → `GLOSSARY-FORMAT.md`）、把 Claude Code 的 `Call the Skill tool with "X"` 换成了别的说法、仓库范围内删掉了 em dash。三个月的漂移，零个信号。所以分叉税的大头不是"改动的成本"，是**"没人知道它已经过期"**。

**2. 用户拿不到这些技能。** pipi 用户装完 app，`~/.pi/agent/skills/` 是空的。上游最有价值的几件东西（诊断 bug 先造一条红命令、两轴 code review、retro 改环境不改代码、wizard 把"人类手动步骤"变成幂等脚本）需要用户自己知道 GitHub 上有这个仓库、自己复制、自己维护。这是"整合层"该干的活，而我们没干。

**3. 路已经修好了。** `src/main/extension-sync.ts` 已经有把 app 内置内容送到四个地方的完整机制：启动时本地写入（`ensureShippedExtensions()`，:122）、WSL 经 `\\wsl$` UNC（`src/main/index.ts:691`）、远程密码认证走 SFTP（`syncExtensionsViaSftp()`，:204）、远程密钥认证走一条 `ssh` 命令（`buildSshInstallCommand()`，:167），加上"只删自己发过的东西"的退役机制（`RETIRED_FILES` / `retireShippedFiles()`，:61/:93）。技能是**同一类东西**（app 内置的文本文件，投放到 `~/.pi/agent/`），只是**形状不同**（目录树 vs 单文件）和**所有权语义不同**（用户会改技能，不会改扩展）。

## 决策

技能作为第二类"随 app 分发的内置内容"，复用现有四条通道，但**新增所有权概念**：

1. **仓库根 `skills/` 是单一事实源**，不散落在各处。`skills/manifest.json` 记录上游 pin（repo + commit + 许可）、pipi overlay 的全部改写、以及每个技能 `ship: true|false`（随 app 分发 / 仅本机开发）。`scripts/vendor-skills.mjs` 从上游 clone 重新生成整棵树，`--check` 不写盘只报 drift。
2. **不改上游原文，只登记三类改写**：pi 的调用约定（不是 Claude Code 的 Skill tool）、把 `docs/agents/issue-tracker.md` 这类硬依赖降级为软依赖、不复制 `agents/openai.yaml`。改写在 manifest 里，`skills/NOTICE.md` 自动生成（含 MIT 全文与逐条改动），vendoring 后仍残留 `Skill tool` 字样直接报错——上游又添一处旧约定时，我们需要一个信号，而不是一句模型看不懂的指令。
3. **首批随 app 分发 6 个上游技能**（用户 2026-09-30 拍板）：`wizard`、`retro`、`diagnosing-bugs`、`code-review`、`writing-for-agents`、`handoff`；另 6 个（`grilling`、`grill-me`、`domain-modeling`、`codebase-design`、`grill-with-docs`、`improve-codebase-architecture`）只在本机开发用。**不是 30 个**：默认包越大，用户的面板里越多噪音（见 §后果的实测数据）。
4. **所有权：只读订阅 + 偏离保留**（用户 2026-09-30 拍板）。每个技能目录里放一个 `.pipi.json`：`{ source, skillVersion, appVersion, files: { path: sha256 } }`。
   - 文件 hash 与 manifest 记录一致 → 是我们的 → 直接覆盖升级。
   - 不一致 → 用户改过 → **保留用户的版本**、UI 标"已偏离"、**停止自动升级该文件**。
   - 期望 hash 必须对**落地后的产物**计算：用户把某个技能切成"仅手打"时，我们要写入的 `disable-model-invocation: true` 变了，hash 也随之变；拿上游原文的 hash 去比会永远误判为"用户改过"。
5. **默认同步到远程/WSL**（用户 2026-09-30 拍板）。用户改过 `remote.agentDir` 的自定义目录不碰（沿用现有约定）。
6. **技能版本只随签名过的 app 版本走，没有云端热更新。** 技能是给模型看的指令文本，等于远程代码执行面；任何"从我们服务器拉一份新技能下来"的设计都把这个面交给了服务器和传输链路。V1 不发这个功能（理由另见 `.out-of-scope/no-cloud-skill-updates.md`）。

## 我们提供的增量（这才是产品，不是复制文件）

上游技能是 TUI 时代的文本。pipi 是桌面 app，能做的三件事上游做不到：

- **技能面板**：列出每个技能的来源（上游 / 本机自制 / 用户装）、版本、常驻上下文成本、开关。用户偏好存 `settings.json`（`pipi` 命名空间，先例 `src/main/extensions/pipi-model-sync.ts`），技能文件是**派生产物**——把"仅手打"落成 `disable-model-invocation: true`。这是"谁拥有这个文件"这个问题的唯一诚实答案：用户拥有偏好，我们拥有文件。
- **常驻上下文成本可视化**：面板要显示"你这 6 个技能 ≈ 每轮 248 token"。**实测（2026-09-30）：进入系统提示的只有 frontmatter 的 `description`，一个技能几十到几百字符；12 个技能全部加起来 1561 字符 ≈ 390 token，当前分发的 6 个 ≈ 248 token，带 `disable-model-invocation: true` 的技能（默认包里 `handoff`、`retro`）为 0。** 所以这条不再能支撑"默认包必须小"：把 6 个扩到 10 个的边际成本只有 `grilling` 的 152 字符 ≈ 38 token（另外 3 个都是 dmi）。默认包大小的真正约束是**选择噪音**（面板里 30 个技能 vs 10 个），不是 token。
- **结构化问答 UI**：上游 `grilling`（结构化追问）是它最受欢迎的技能，形态却是 TUI 里一条条打字。app 可以把它做成真正的问卷界面（分支、推荐答案、逐轮推进），走一个内部 `pipi-wizard.ts` 契约扩展。**这是护城河**：TUI 做不了，别人的终端壳也做不了。

## Considered Options

1. **不做，用户自己复制** —— 拒绝：见动机 1，我们已经亲眼看过它怎么腐坏。
2. **fork 上游技能仓库** —— 拒绝：分叉税。上游 3 个月改了 3 处约定，fork 后每次都要人工三方合并。
3. **当静态资源直接塞进 `resources/`** —— 拒绝：无法回答"这个文件用户改过没"，于是每次启动要么覆盖用户改动、要么永远不敢更新。
4. **云端技能市场 / 热更新** —— 拒绝：RCE 面 + 审核与托管成本 + 与"不当 API 中转商"同一类错误（把不归我们的责任揽到自己身上）。
5. **（采用）仓库内单一事实源 + provenance manifest + 复用四条投放通道 + 偏离保留**

## 后果

**好的**：上游升级变成一条命令（`vendor-skills.mjs --from <clone>`），`--check` 让 CI 能报 drift；pipi 用户开箱就有上游精选技能，包括在远程服务器上——而在远程服务器上装工具链正是用户自己最不愿意做的；用户改过的文件不会被我们吃掉。

**代价**：
- 技能版本绑 app 版本，用户不能单独升级技能。这是 6 号决策的直接代价，接受它。
- 常驻上下文成本：**实测只有 frontmatter 的 `description` 进入系统提示**，当前 6 个 ≈ 248 token/轮，`disable-model-invocation: true` 为 0（见上面那条的实测数据）。要可视化，但它是"看得见的小钱"，不是限制默认包大小的理由。
- `--check` 需要一份上游 clone（CI 里多一步 `git clone`）；离线环境只能跑 `--check` 之外的部分。
- 我们成了上游的**分发者**，因此要承担归属与许可：`skills/NOTICE.md` + `skills/LICENSE-mattpocock-skills.txt` 必须随 app 一起分发，不能只躺在仓库里。

## 实施状态（2026-09-30）

**已落地**：

- `skills/`（12 个技能，20 个文件，上游 pin `d81f3a1`）+ `skills/manifest.json` + 生成的 `skills/NOTICE.md` / `LICENSE-mattpocock-skills.txt`
- `scripts/vendor-skills.mjs`（`--check` 已验证幂等；改写失配、残留 `Skill tool`、无人认领的陈旧文件都会报错）
- `scripts/install-skills.mjs`（本机 `~/.pi/agent/skills/` 同步；改过的目录先备份再覆盖）
- 文档结构整改：`CONTEXT.md` 拆成 `GLOSSARY.md` + `docs/invariants.md` + `docs/architecture-decisions.md` + `docs/diagnosis/`（见文末补记）

**未落地（下一批）**：

- 技能面板、常驻上下文成本可视化、`grilling` 结构化问答 UI（属 P2，见补记二）。

## 实施状态补记（2026-09-30，拆 `CONTEXT.md`）

原 `CONTEXT.md`（1075 行 / 163KB）里只有前 125 行是结构性的（术语 / 决策 / 契约），其余 950 行是按日期的历史记录，却被当成一个文件整读。已拆成：

- `GLOSSARY.md` —— 术语（`domain-modeling` 唯一认的文件）
- `docs/invariants.md` —— 6 条无日期硬规则 + 稳定性契约（引用规则时引这里）
- `docs/architecture-decisions.md` —— 52 条带日期的架构决策（按日期，逐字）
- `docs/diagnosis/<date>.md` —— 34 段诊断记录，按 6 个日期归并（逐字，历史只读）

起因是这次上游同步：`domain-modeling` 只认 `GLOSSARY.md`，本仓库成了自己分发的那套约定的反例。
拆分只做搬运，不改写历史；规则型内容抽进 `docs/invariants.md` 后才是可被代码注释直接引用的目标。

## 实施状态补记二（2026-09-30，投递落地 + 三处实测修正）

**落地：投递通道（P1 切片 1）**

- `src/main/skill-sync.ts`：技能目录树随 app 分发。规则（只读订阅 + 偏离保留）是**纯函数** `planSkillSync` / `nextJournal`，三条件通道只是执行计划：本机 `ensureShippedSkills`（同步，启动时先于任何 tab）、WSL 与 SFTP（同一个 `SkillIo` 适配器）、key-auth ssh（stdin 脚本）。`skills/manifest.json` 的 `ship: true` 决定打包内容，bundler 用 `import.meta.glob` 内联，**不需要改 `electron-builder.yml`**（实测 `out/main/index.js` 1 文件内联，无额外资源；6 个技能 9 文件 48,594 B）。

**补记（glob 收窄）**：`import.meta.glob` 的模式是 **字面量**（Vite 构建期解析），最初的 `../../skills/**/*` 会把 6 个 `ship: false` 的开发用技能**正文也内联进安装包**（35,627 B，占技能总字节 42%，永远不会写到磁盘）。已改为逐 bucket 列已发布目录的模式：`out/main/index.js` 458,158 → **415,298 B（−42.9 KB）**，已发布 9 个文件的正文逐字仍在包里、开发用技能正文一字不在（`skill-sync.test.ts` 用「从源码文本里读回 glob 字面量」的方式把这份第二份 ship 清单与 manifest 钉在一起 —— 两边任何一个改了、另一个没改就报错）。
- `.pipi.json`（账本，写在已安装技能的旁边）：记我们写下的哈希 + "我们想写但用户改了"的哈希。没有它，"我们自己的旧版本"和"用户的手改"无法区分——这是偏离保留能成立的全部前提。
- 退役：只删"字节仍是我们写的"文件，并清理空目录；用户改过的技能即使我们不再分发也留着。
- **发现并修了一个真实 bug**：`buildSshInstallCommand()` 把 base64 正文拼进 argv，加进 `pipi-approval-gate.ts` 后命令行长 35,367 字符 > Windows 32,767 上限，`spawn` 会**同步抛 ENAMETOOLONG** —— 而这个调用点就在 `tab:create` 里，抛出即中断建 tab。现在 argv 固定为 `sh -s`，正文走 stdin（`src/main/ssh-exec.ts`）。这个 bug 在 git 里看不见（它只在用户未提交的那个扩展文件存在时发着）。

**实测修正（本文档之前写的三处说法是错的）**

1. **常驻上下文**：只有 frontmatter 的 `description` 进入系统提示；全 12 个技能 1561 字符 ≈ 390 token，分发的 6 个 ≈ 248 token，dmi 的技能为 0。之前"每轮多烧 token 的惊喜"夸大了约 10 倍。
2. **不需要 `chmod +x`**：这个平台**根本没有**执行位（Windows 上 node 对这三个 `.sh` 都报 `0o666`），而两个模板也从不被直接执行 —— `wizard` 明写用 `bash -n <script>` 检查、并让 agent 自己对**生成**的脚本 `chmod +x`（`skills/engineering/wizard/SKILL.md:41-42`）；`diagnosing-bugs` 把 `hitl-loop.template.sh` 交给人类跑。投递去伪造一个远程执行位只会多一排会错的代码。
    （前一条这里是错的，而且错得很有教育意义：当时的"实测"是 `git ls-files -s skills | grep 100644`，而 `skills/` 还没 `git add`，管道是空的 —— **空集上的断言看起来跟真的一样**。现在这版是逐文件 `statSync` 实测的。）
3. **不需要 base64 tar**：SFTP 通道沿用 `extension-sync.ts` 已有的逐文件 `put`（本来就要逐文件比对才知要不要传）；ssh 通道用一个 base64 脚本一次传完（不分包，因为 `sh -s` 可以吃任意长的 stdin）。

**已知缺口（已闭）**：key-auth ssh 通道最初**无法**判定偏离 —— 读回远端文件要按文件一次往返，所以它按旧行为直接覆盖，而本机/WSL/SFTP 通道保留用户改动。**已改为"探测 + 应用"两阶段**（`buildSshProbeScript` / `parseSshProbe` / `buildSshApplyScript` / `syncSkillsViaSsh`）：

1. 探测往返（一个 `sh -s` 脚本）把远端 journal + **每个我们关心的文件的当前字节**（base64，带 `@@f` / `@@x` / `@@j` 标记行）一次性吐回来；
2. **在本机用同一套纯规则** `planSkillSync` 分类 —— 不存在第二份用 shell 重写的所有权逻辑；
3. 应用往返只写变了的东西，并**把 journal 写回远端**（账本不上远端的话，下一次仍然分不清"我们写的"和"用户改的"）。

代价：改过 digest 的那一次连接从 1 个往返变成 2 个（退役时 3 个），常态 0 个写入时只读不写。换来的是无密码服务器上同样的"你改的我不动"。

两个刻意的保守选择：

- `@@x`（文件在那但读不出来，比如远端没 `base64`）映射为一个哨兵值而不是 `null` —— `null` 意思是"不存在"，而"不存在"是要被写入的，那就会覆盖一个我们根本没能读到的文件。
- 远端 journal 被删/损坏后，我们自己写的旧版本与用户手改无法区分 → 一律**保留**并报 diverged，不自动升级。

验证：单元测试用假远端（`fakeRemote`：内存盘 + 讲协议的 `run`）跑完整循环，真实 Linux 端到端跑在 WSL 里（`wsl.exe env HOME=<tmp> bash -s` 扮 `ssh host sh -s`）：空服务器全量落地逐字节一致 → 第二次零写入 → 在 distro 里改一个技能后**该文件原样保留且第三次仍然保留** → 其佉文件仍能正常升级。`npm run smoke:skills-wsl`。

**补记三（2026-09-30）：接口已并入通用引擎。** 本文写作时引用的 `buildSshInstallCommand()` / `buildSshInstallScript()` 已不存在 —— 它们被提升为与技能共用的通用内容投递引擎（`src/main/content-sync.ts`），扩展/agents 走 `syncAgentHomeViaSsh()`（每根一次 probe→apply，旧版退役作为 trailer 搭在 extensions 那一趟上），技能走 `syncSkillsViaSsh()`（同一个引擎的薄包装）。本文其余结论（argv 固定 `sh -s`、正文走 stdin、账本不上远端就不算数、`@@x` 哨兵、失败时中止整次同步）在改名后逐条保持；见 ADR 0005 与提交 `12320b4`。

## 实施状态补记四（2026-09-30，能力断言必须带降级）

这是 overlay 的第四条规则，治的是**文本制造的假确定性**：`code-review` 原文（以及我们发出去的 description）断言两轴**在并行子代理里**跑，而 pi 核心不带子代理 —— 这句在两种情况下都是假的：能力层所在的那台机器还没同步（新指的远程服务器、同步失败、用户自己装的 pi），或者 diff 小到不值得起一个子代理。模型拿到一个跑不了的步骤时不会报错，它会**静默地在一个上下文里做完两轴，然后在报告里写成两条独立轴**。

看似自然的做法是把它改成“如果有子代理就用”，但那样仍然把“怎么调”留给模型猜 —— 而猜错的代价就是上面那句假报告。所以三条一起改：

1. **常驻的那行不做无条件承诺**。frontmatter 的 `description` 是每轮都在系统提示里的唯一部分（实测 6 个技能 ≈ 248 token/轮），所以它只说保证成立的那半：“Reports the two reviews side by side, without merging them.”；机制与降级下沉到正文。（顺带一处口径不符：上面那个“248 token/轮”按逐文件 `description` 行复量不出来 —— `078522f` 的 6 个发布技能是 1125 字符 ≈ 281 token，本提交后是 1113 字符 ≈ 278 token。差 134 字符的旧口径没留下算法，先记在这里，别拿 248 当基准。）
2. **正文写出真实调用形态**：pi 里那不是一个叫“子代理”的原语，而是我们自己发的 `reviewer` 工具，一次调用带两条 `tasks`（`MAX_PARALLEL_TASKS = 8`，真并行）。并且写出拿不到它时怎么办：在本上下文里依次跑两轴，**并且要在报告里交代是哪一种**——因为两轴分开的全部价值就在于第二条轴看不到第一条，读者必须知道它到底是分着的还是没分开。
3. **可执行的束缚**：`manifest.overlay.rules` 新增这条规则（渲染进 `skills/NOTICE.md`），新增 `src/main/__tests__/shipped-text-capabilities.test.ts`（4 条）把“文本与机制一致”钉住：任何已发布技能里出现 `reviewer` / `scout` / `analyst`，就必须同时发出对应的 `agents/<name>.md`；`code-review` 命名 `reviewer` 就必须真的发出一个能跑 `tasks` 的 `reviewer`（从**打包字节**里解析 `MAX_PARALLEL_TASKS ≥ 2`）；降级句与“报告里交代模式”必须在文本里；description 里不得再出现无条件的能力承诺。测试断的是 `SHIPPED_*`（即将写到用户磁盘上的那串字节），不是源模块。

**顺带定了一条 overlay 约定**：patch 的 `find` / `replace` 不得跨行。vendored 文件是 CRLF，多行改写就得赌一种换行并把赌注写进我们分发的字节（还会把生成的 NOTICE 列表打断）；`scripts/vendor-skills.mjs` 现在对跨行 patch 直接报错（实测触发过）。这条不是风格洁癖：它让“改写不碰换行”成为一个机器能检查的事实，而不是一句口头约定。

**顺带修了漂移检查的换行口径**：上游 blob 是 LF，而本机 `core.autocrlf=true` 把检出变成 CRLF，`--check` 原来逐字节比较 —— 在一台 LF 检出的机器（任何 Linux CI）上会把 21 个文件全部报成 drift，而一个常年误报的检查会训练人忽略它（与“空转的断言”同一种病）。现在比较按 LF 归一化（`sameContent()`），**写出去的东西一字不改**（理由见 ADR 0005：改变已分发字节会让账本把每份都当成用户手改）；内容 digest 也同样归一化，于是同一个修订在 Windows 与 Linux 上是同一个值。A/B 实测：把一份 LF 检出的副本喂给旧脚本 → `DRIFT 21 file(s)`，喂给新脚本 → `no drift`，且两边 digest 都是 `ffa4bbe5…`，与 CRLF 检出上算出的完全相同。**代价是口径变了**：本文与前文引用的 `af8620b5…` / `91e3ab38…` 是旧口径（按检出字节算，只在 Windows 检出上可复现），不要拿旧值跟现在的 `--check` 输出比对。

**验证**：`node scripts/vendor-skills.mjs --from .upstream-skills` 一次重算 → `--check` no drift，digest `ffa4bbe5…`，改完的文件仍是全 CRLF（87/87，无裸 LF）；全量 1137 passed | 2 skipped（1139），`npm run smoke:skills-wsl`（真 Linux）2 passed。诚实测试是否空转已反向验证：手动删掉降级句 → 对应的那条测试变红 → 重跑 vendoring 恢复。

**同类项、还没做的**：`grilling`（`ship: false`，所以不发出去）依赖一个同样不在 stock pi 里的能力（`ask_user_question`，用户本机那一份来自第三方包）。它的文本要在 P2 把自有问答能力层做出来之前先说完降级，否则一旦提为 `ship: true` 就是同一个缺陷的第二次发行。

## 实施状态补记五（2026-10-01，应用脚本必须自己说"失败"）

补记二的 key-auth 通道建立在两类脚本上（探测、应用），而它们的**真值来源是 shell 的退出码**。这一批在退出码上找到并修了两个缺陷——都属于"app 说同步成功，其实没有"，也就是最坏的一类：它把假话写进账本，而账本是"保留用户改动"能成立的全部前提。

**缺陷一：中间某次写入失败被账本写入掩盖。** 应用脚本原来没有 `set -e`，且每次写入写成一行 `echo <b64> | base64 -d > <目标>.pipi-tmp && mv -f <目标>.pipi-tmp <目标>`。脚本的退出码 = **最后一条命令**的退出码，而最后一条是写账本——它几乎总是成功。于是中间任一次写入失败（磁盘满、权限、`.pipi-tmp` 位置上已经有个目录）→ 退出 0 → `apply.ok` 为真 → app 报"已同步"；更糟的是账本把**没有落地**的文件记成我们的，下次连接读到哈希不符，只能判成"用户手改"→ **永久冻结**。

修法是两处一起改，缺一不可：

1. `set -e` 作脚本第一行；
2. 写入拆成**两条语句**（`… > <目标>.pipi-tmp` 一行，`mv -f …` 一行）。

第 2 点不是风格问题：**`set -e` 在 `A && B` 的左侧不生效**（状态正在被测试的命令被豁免），所以那个"一行式 + `&&`"恰好是最需要它时不生效的写法。真 Linux（WSL）实测：同一段脚本，左侧失败时退出 0（一行式），拆成两条语句后退出 1。账本写在最后，于是任何一处失败都保留远端**上一份账本**——什么都没忘，下次连接重试。

**缺陷二：读不出来的账本被当成"没有账本"。** 探测脚本原来是 `[ -f <账本> ]` + `base64 <账本> 2>/dev/null || true`：账本存在但读不出来（权限、EISDIR、根本不是普通文件）时静默变成空账本 → 我们发出去的每个文件都被判成"用户的" → 不但再也不会升级，还会**把这条假结论写回远端当新账本**，销毁唯一能分辨归属的证据。

修法：探测改 `[ -e ]`，读失败打 `@@ju` 标记（与 `@@x` 同一种思路：`null`/`空` 是"不存在"，而"不存在"是要被写入的；补记二那句「两个刻意的保守选择」因此成为三条）；`parseProbe` 多返回 `journalUnreadable`；`syncContentViaSsh` 看到即**拒绝同步**（一个应用往返都不发），错误里点名 `.pipi.json` 与本机路径上的同一决定。本机路径（`ensureContent`）本来就是这么做的——读账本抛错会被外层 catch 吞成"整次什么都不写"——这次是让 ssh 通道与本地通道**语义一致**，而不是各有一套哲学。

**退役刻意不受 `|| true` 保护。** `rm -f` 失败（root 拥有的文件、路径上是个非空目录）要中止脚本：中止保住账本里的条目，下次重试；吞掉错误则是"条目被丢弃但文件还在"——那是我们不再分发的扩展还留在 pi 里继续被加载，而且从此不可见。真 Linux 实测：`rm -f` 一个非空目录 → 退出 1、**账本未被写入**、之前写好的文件仍在磁盘上（下次连接因为字节等于目标而自愈，不影响正确性）。

**验证**：新增单测 3 条（脚本形状：`set -e` 在最前、账本在最后、写入是两条相邻语句、解码行内不得出现 `&&`；probe 用 `-e` 并在读失败时打 `@@ju`；`syncContentViaSsh` 遇 `@@ju` 拒绝且只发一个往返）+ 退役行不带 `|| true` 的断言；`skill-sync.test.ts` 的假远端跟着改成按两条语句复演，并新增一条"账本读不出来就拒绝"。**顺带修了一个测试假件**：它原来对不认识的写入行**静默忽略**——脚本一改，覆盖就断了而断言全绿；现在遇到不认识的行直接报错（这正是这次改动一上来就有 10 个测试变红的原因，是设计好的信号，不是回归）。真 Linux：`npm run smoke:skills-wsl` 4 passed，其中两条是这次新写的红灯循环（把 `.pipi-tmp` 位置伪造成目录 → 期望 `ok:false`、无账本、目标不存在；把账本伪造成目录 → 期望 `ok:false`、用户改动原样、账本仍是目录）。

**仍然是诚实的缺口**：免密 ssh 这条通道上的失败只到 `console.error`（`src/main/index.ts` 的 `syncKeyAuthExtensions`），渲染层不显示；而 tab 上那句提示文案属于当时别人未提交的工作流，没碰。

**同一批的同类项（2026-10-01）**：`ContentIo` 的两家 io 实现（本机 fs / `\\wsl$` UNC、SFTP）也把「读不出来」当成「不存在」（`catch { return null }`），于是在 WSL 与 SFTP 两条通路上同样会发生「把读不出来的文件当缺席写掉」「把读不出来的账本当空账本，再把这条假结论写回去」。同一批修掉：`read` 的契约改为 `null` = 不在、文本 = 内容、`UNREADABLE` = 在但读不出来（传输坏了照旧 throw），`ensureContent` 对单个文件保留并上报、对读不出的账本整次拒绝。四条通路现在是一个语义，见 ADR 0005 的「读不到不等于不存在」条与 `docs/diagnosis/2026-10-01.md`。
