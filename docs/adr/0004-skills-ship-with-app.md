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
