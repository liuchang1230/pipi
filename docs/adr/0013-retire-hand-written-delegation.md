# ADR 0013：退役手写委派扩展，改由官方 `pi-subagents` 包 + app 确保安装

Status: **accepted**（2026-10-07）。部分取代 `docs/adr/0005-capability-layer-ships-with-app.md`（该 ADR 的扩展收编那一半；skills/agents 那两半仍然有效）。

## 动机

ADR 0005 把「能力层」收编进 app：5 个 `.ts`（44,792 B）作为 `extensions/delegation/*.ts` 随 app 分发，3 个 agent 定义进 `agents/`。收编消灭了单点（源码只活在 `~/.pi/agent/`，不在任何版本控制里），但代价是 app 从此维护一个**别人的引擎**：

- pi 生态里已经有一个在维护的包干这件事：`npm:pi-subagents`（MIT，本机 0.76.1，作者 Nico Bailon），功能面更大（workflow 脚本、并行 lane、mission、resume、watchdog）。我们的引擎是它的一个子集。
- 它的失败模式很差。并行两个子任务时若工具调用被中断，`engine.ts` 会 `kill` 子进程并 `throw`，**结果只存在内存里**——用户看到「Parallel: 2/2 done」却拿到「Reviewer was aborted」。本次会话里两次独立复核正是这样丢的（官方包不丢：子进程结果按 run 落盘，可 `status`/`resume`）。
- 名字面还撞过车：2026-10-03 旧手写目录与新 delegation 抢工具名，远程 tab 启动即死。
- 三个 agent 定义（`<agentDir>/agents/*.md`）**官方包也读**，所以换引擎不损失 brief，`agent: "reviewer"` 解析到同一份 prompt。

判断：agent 引擎不是我们的资产（同 `AGENTS.md`：不 fork pi、定制走扩展层），它也不该由我们分发一个自定义副本。

## 决策

1. **退役 `extensions/delegation/*.ts`**：仓库源码删除（`src/main/extensions/delegation/`）、从 `SHIPPED_EXTENSION_FILES` 移除，并把 5 个文件写进 `RETIRED_FILES`（逐文件 `sha256` + 无空格 markers）。**停止分发不等于停止运行**：pi 会自动加载 `extensions/` 下每个 `.ts`，老装机里的旧引擎必须被**删掉**，否则它会继续注册同名工具并与新包抢。三处退役走同一张表：本机 `retireShippedFiles`、key-auth/WSL 的 install trailer（`buildSshRetireTrailer`，markers 经 base64 过 shell，`|| true` 保证失败不拖垮安装）、SFTP 退役循环。删空的目录也一并 `rmdir`（**仅当为空**——用户自己的文件能让目录留下），因为空的 `extensions/<name>/` 是 pi 发现遍历的一处陷阱。
2. **只继续分发 `analyst` 简报**：`SHIPPED_AGENT_FILES` 从三个减到 `analyst.md` 一个（仍 `preserve`）；`reviewer.md` / `scout.md` 进 `RETIRED_FILES`。理由是一次同名字发现：官方包**自带** `agents/reviewer.md`、`agents/scout.md`，而 user 作用域同名 agent 会**静默覆盖** builtin（`subagent action:list` 里只有 user 版，包 13 个内置 agent 里恰好少了这两个）——等于每次安装都在跑一份上游维护中的 prompt 的旧副本。而且我们那份更差：三个简报都给只读审查者发了 `bash`（`tools: read, grep, find, ls, bash`）、`thinking: minimal`、没有 `output` / `contact_supervisor`；官方 reviewer 是 `tools: read, grep, find, ls, watchdog_diff, contact_supervisor`（**不给 bash**，结构上就跑不死）。`analyst` 包没有对应物，继续归我们。
3. **「子代理模型」从 env 改到 pi 自己的 settings**：官方包解析子代模型链为 per-run override → `subagents.agentOverrides.<name>.model` → 简报 frontmatter → `subagents.defaultModel` → 父会话模型；**从不读** `PI_MODEL`/`PI_PROVIDER`（那两个变量只喂过已退役的手写引擎）。于是：删掉 app 一侧的 env 注入（`subagentEnv`/`subagentShellPrefix`、SDK worker 的传递）、退役为它服务的 `pipi-subagent-model.ts`，pin 改为 `ensureSubagentModel()` 幂等写 `subagents.agentOverrides.{analyst,reviewer,scout}.model`（有 provider 就写全限定 `provider/model`，否则写裸 id；清掉 pin 时只删这三个 `model` 字段并剪掉空容器，用户在 `subagents` 下的其他键——`defaultModel`、别的 role 的 override、我们这三个 role 的 `thinking`——一律保留）。
4. **app 确保官方包在场**（用户 2026-10-07 明确选择「app 确保安装官方包」，越过 ADR 0009「用户扩展包归用户管」的线，但**只针对 app 自己要用的这一个**）：
   - **本机**：`ensureOfficialPackages()`（`src/main/pi-settings.ts`）往 pi 自己的 `<agentDir>/settings.json` 幂等写一条 `npm:pi-subagents`（清单住在 `OFFICIAL_AGENT_PACKAGES`）。**不 spawn 安装器**：pi 的包管理器在解析 settings 时就会装「配了但没装」的包（`dist/core/package-manager.js` 的 `resolvePackageSources` → npm 分支 `installMissing()`），所以 app 的活只是写一条记录，且必须发生在**任何 pi 进程启动之前**（`index.ts` 启动序列，紧挨 `ensureShippedAgentHome()`）。读不懂的 settings.json 一律不动（json-store 的 `.corrupt-*` + 写封锁）。
   - **远程 / WSL**：`buildOfficialPackagesClause()` 生成 `test -d <agentHome>/npm/node_modules/pi-subagents || ( command -v pi && PI_CODING_AGENT_DIR=… pi install npm:pi-subagents ) || true`，挂在既有 install trailer 上——同一趟、零额外往返、静默、永不失败、已装则不联网。远程的 `settings.json` 是 app 唯一不搬运的文件（ADR 0009），所以那边只能由**那台机器上的 pi 自己**写。
   - **已知缺口**：SFTP 通道只有文件 IO、没有 exec，装不了包。走 SFTP 的远程会话需要用户自己 `pi install npm:pi-subagents`；shipped skills 已有降级措辞（「没有子代理工具时在本上下文里依次跑两轴，并在报告里交代」）。

## 后果

- **shipped 文本不再有 app 侧的机制保证**。`code-review` / `grilling` 点名的 `reviewer`/`scout` 现在由第三方包提供。`shipped-text-capabilities.test.ts` 的契约随之改写：不再钉「我们 ship 的 declarations 真的支持 `tasks` 数组」（那是别人的 schema，从我们包里钉不了，假装能钉正是那份测试要防的失败），改钉四件我们仍然拥有的事——文本点名的子代理要么是我们 ship 的简报、要么是官方包提供的 role、官方包在确保清单里、以及既有的降级措辞。
- **ADR 0005 那个缺陷以弱形式回归，需要单独一拍（本次未做）**：官方包只注册**一个**工具 `subagent`（`src/extension/index.js:667`），而 shipped `code-review` 正文写的是「one `reviewer` call carrying both briefs as `tasks`」。于是在装了官方包的机器上，模型会按文本的降级路（在本上下文里依次跑两轴并交代），而不是并行——能力在，名字不在。这正是 ADR 0005 要消的那个失败（“给出一个跑不起来的步骤”），只是那次的假版本是「能力缺失」，这次是「能力换名」。修法很小但**要动上游内容**：改 `skills/engineering/code-review/SKILL.md` 的两句 + 同步 `skills/manifest.json` 的 overlay patch，以及 `shipped-text-capabilities.test.ts` 里钉这两个词的断言——用户 2026-10-07 明确选择本次不动（选项 C 被否），所以这里记录而不做。
- **用户已有的改动不会被静默丢弃**：退役只在能认出「这是我们的字节」（sha 或**全部** markers）时删除；用户在 `extensions/delegation/` 里自己写的文件保留，目录也保留。
- **少一个自维护组件、多一个外部依赖**：官方包不在我们版本控制里、不受本仓测试约束（它的失败信号是 pi 启动时加载失败，不是我们的 typecheck）。换来的是「结果不丢」与「不追上游」。
- **`pipi-subagent-model.ts` 已退役，而不是保留**：它存在的唯一理由是「让读 `PI_MODEL`/`PI_PROVIDER` 的引擎跟随会话模型」，而那两个变量现在没有任何消费者（官方包原生继承会话模型 + 从 settings 解析 pin）。代价：如果用户装了某个**自己读 env** 的第三方子代理扩展，它不再自动跟随会话模型——需要时把那个键写回配置，而不是恢复这个扩展。
- **「子代理模型」在远程/WSL 上没有通路（未实现）**。pin 现在写在**本机** pi 的 settings.json 里，而官方包只读**那台机器自己的** settings.json；app 不搬运 settings.json（ADR 0009）。以前 env 注入能跨过去，但那是因为只有手写引擎读 env。可选后续：像 `theme-sync` 那样，在 SFTP/ssh 连接时 merge 一个键（同一套 read → merge → atomic write）；不做的理由：那是一条新传输路径，且需要真实远程才能验证。
- **顺带发现，未改**：`extension-sync.ts` 的 `AGENT_HOME` 只认 `homedir()/.pi/agent`，**不认** `PI_CODING_AGENT_DIR`，而 `pi-settings.ts` / `theme-sync.ts` 认。也就是说 app 的扩展/agents 投递永远写用户真实的 `~/.pi/agent`（本次真机验证正是这样暴露出来的：临时 home 里只出现了 settings.json）。这是既有行为，不是本次引入，值得单独一次决策。
- **验证**：全量 1478 passed | 4 skipped；`typecheck`（node + web）与 `build` 干净；key-auth/WSL 真 Linux e2e（`PIPI_WSL_E2E=1`）4 passed——包含退役（本次新增的两个简报与那个扩展也在真盘上被删）、空目录清理、以及 trailer 子句在真 shell 上执行；空 agent home 真机启动一次（`PI_CODING_AGENT_DIR` 指向空目录）：启动日志 `[packages] ensured: npm:pi-subagents`，该目录出现 `{"packages":["npm:pi-subagents"],"theme":"pipi-light/pipi-dark"}`（两个 app 维护键共处一个文件、互不覆盖），无崩溃；用户的真实 agent home 被正在跑的 dev 实例同步成新状态（`agents/` 只剩 `analyst.md`，`extensions/` 不再有 `pipi-subagent-model.ts`）。
- **测试改动**：`extension-sync.test.ts`（shipped 清单、退役整棵树 + 空目录、ssh/sftp 断言；顺带修掉两处位置耦合——两段分别按 `RETIRED_FILES[1]` / `RETIRED_FILES[0]` 取条目，清单一长就默默测到另一个文件，现均改为按名字查，其中一处是 WSL 真机 e2e 抓出来的）、`approval-gate.test.ts`（注入完整性：`subagentEnv`/`subagentShellPrefix` 零调用、无任何 `PI_MODEL:` 赋值或 `export PI_MODEL`、`ensureSubagentModel` 只从 index.ts / pi-settings.ts 调）、`ssh-install-script-wsl.test.ts`（tuned 对象改成 `analyst.md`）、`shipped-text-capabilities.test.ts`（契约改写）、`subagent-model.test.ts`（只留设置本身的存取/归一化；env 那组测试随机制一起删）、新增 `pi-settings.test.ts`（18 条：合并语义、幂等、损坏文件不覆盖、非列表值不动、pin 的写/清/剪容器/保留他人键、远程子句形状）。
