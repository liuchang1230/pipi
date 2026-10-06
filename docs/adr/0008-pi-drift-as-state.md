# ADR 0008：版本漂移是具名状态（三个运行时各自一份）

Status: **accepted**（2026-10-05）

## 动机

「版本对不对」这件事今天**没有名字**，于是每个消费者各自拼一个判定：

- **文案两份逐字重复**：`App.tsx:177-183`（HEAD）与 `ChatPane.tsx:441-447`（HEAD）是同一段三目表达式（远程说「不一致」、本机说「有新版本」），复制粘贴到今天。两个面板各有一份 `piUpdating ? "正在更新…"` 前缀，连省略号都一样。
- **判定两处布尔**：`update-check.ts:295`（本机 `hasUpdate`）与 `:394`（远程 `hasUpdate: current !== bundled`）。
- **版本探到就扔**：`local-pi.ts` 的 `present()` 每天 spawn 一次 `pi --version`，只留 `ok` / `timedOut` 两个布尔，stdout 里的版本号**直接丢弃**（`console.log` 之外没有任何人看见）。

问题是这三处的「版本不同」含义**根本不同**：决策 36 给了三份自由 —— 本机终端跑用户的全局 `pi`（允许用户 `pi update` 追 npm latest）、本机聊天 / `pi update` / `--list-models` 走捆绑 pi、远程由我们对齐到捆绑版本。「比契约新」是特性，「比契约旧」是不对齐，「没装」是故障，「没探明」是不知道。四种折叠成一个 `boolean` 之后，文案只能靠 `current !== bundled` 反推，而远程那句「版本不一致」对用户几乎零信息量。

真实后果（本机 2026-10-05 的现场）：全局 `pi.cmd` 装着但坏了（缺 `@earendil-works/pi-server`，`pi --version` 退出 1），`present()` 把它读成 `absent`，界面于是说**「未检测到全局 pi agent」** —— 一句假话；用户看到的下一步（重装）碰巧是对的，但原因说错了，而原因正是他唯一能用来排查的东西。

还有两个缺口同源：

- **硬规则 8 的漏点**：远程探测失败今天只弹一条 3 秒 toast（`App.tsx` 的 `showToast(..., "err")`，**没有** `{ failure: true }`），因此不进 `FailureCenter`。
- **词汇缺口**：`GLOSSARY.md` 里没有「漂移」这个词，所以三个消费者只能各拼一次判定 —— 与 ADR 0001 / 0007 治的「第七份目标词汇」是同一个病。

## 决策

1. **状态住在 `src/shared/pi-drift.ts`**，是一个纯分类器：`classifyPiDrift({ bundled, runtime, probe })`。它不探测、不缓存、不碰 Electron；输入是**已经探到的事实**（`PiProbeOutcome` 判别联合），输出是 `PiDrift`。放 `shared` 而不是 `main` 的唯一硬理由：`tsconfig.web.json` 含 `src/shared/**/*`、**不含** main，而横幅要在渲染层读这些字段（今天渲染层没有一条 import 来自 `src/main`，不开这个口子）。
2. **六态 `PiDriftState = pinned | drifted-newer | drifted-older | absent | unrunnable | unknown`**，外加 `runtime: "bundled" | "global" | "remote"` 作为**元数据**（不参与分类，只回答「说的是哪一个 pi」）。三个运行时各有一份漂移，因为决策 36 的三份自由各属一个。
3. **`unknown` 不是 `pinned`**：拿不到事实一律 `unknown` —— 契约版本读不到、探测超时、传输层根本没连上、`pi --version` 的输出里没有 semver。**不许猜**（把 `hello` 当 `0.0.0` 会得出「比契约旧」这种假话，并诱导一次降级）。
4. **`absent` 与 `unrunnable` 分家**：只有「可执行文件根本不在」（spawn 的 `ENOENT`）算 `absent`；跑起来了但非零退出算 `unrunnable`（带一行 `detail`：首选 stderr 里第一行像原因的话）。这是本机现场那个假话的解药。
5. **`PiPresence` 由三态变四态**（`present | unverified | absent | unrunnable`）：`present()` 从新的 `probeOutcome()` 投影而来，答案的**唯一**入口是 `probeOutcome()`（带缓存与节流，行为不变）。`ensurePiReady` 里三处 `present() !== "absent"` 折叠成一个具名 `unusable()`（`absent || unrunnable`）—— **修复动作不变**：两种不可用都仍然自动用捆绑副本重装（决策 4 的取舍见 Considered Options），但 `pi-install:notice` 多带 `presence` 与 `detail`，提示从「未检测到全局 pi agent」变成说清是哪一种。
6. **全局 pi 不额外探测**：`terminalDrift` 的版本**顺手**取自已有的 warm 探测（那次 spawn 本来就付过钱，stdout 里就是版本号），零新增进程；拿不到就是 `unknown`。
7. **不缓存漂移状态，不开新 IPC**：它是探测缓存的纯函数，缓存它就有两份真相；字段挂在既有的 `update:check` / `update:check-target` 返回上（`drift`、`terminalDrift`），**`hasUpdate` 的语义一个字不动**（它说的是「npm 上有没有新版」）。
8. **文案只有一个出口**：`src/renderer/src/pi-drift-text.ts` 的 `updateBannerText(info)`（纯函数），`App.tsx` 与 `ChatPane.tsx` 那两份逐字重复的三目表达式**删掉**。本机横幅「先状态、再原建议」（状态句在前，原来那句追最新的建议**逐字保留**）；远程横幅「状态即文案」（状态说不出话时才退回原句）。`absent` / `unrunnable` 另经既有的 `showToast(..., { failure: true })` 进 `FailureCenter`（硬规则 8）—— 顺带补上远程探测失败那个漏点，**不新增主进程 → 渲染层的通道**。
9. **漂移不是失败**：`drifted-newer` / `drifted-older` 不进故障中心（追新是决策 36 允许的自由，把它报成 bug 就是把特性说成缺陷），只有 `absent` / `unrunnable` 进。

## Considered Options

- **在 `update-check.ts` 里就地算，不建模块** —— 拒绝。三个消费者（本机横幅、聊天通知条、远程横幅）分布在渲染层，而事实在两条不同后端（本机 spawn 探测 / 远程 runner 探测）。就地算等于让渲染层再抄一遍判定，就是今天两份重复三目的成因。
- **放在 `src/main/`** —— 拒绝。渲染层 import main 会开一个仓库至今没有的口子（`tsconfig.web.json` 也不允许）。
- **缓存漂移状态** —— 拒绝。探测缓存是事实，漂移是事实的函数；两个缓存必然在某个窗口里互相矛盾（用户会在横幅上看到刚修好的状态）。
- **把漂移编进 `hasUpdate`**（如 `hasUpdate = state !== "pinned"`）—— 拒绝。「npm 有新版本」与「跟契约不对齐」是两件事，混起来会让**比契约新**的机器永远显示更新横幅，且点下去是把它的 pi **降级**。
- **两种不可用走不同修复**（`absent` 才装，`unrunnable` 只提示）—— 拒绝（本次只命名，不动行为）。这是用户可见的取舍（「自动修复」vs「别动我的环境」），该由一次单独的决策定；本切片已经把它从「看不见的布尔」变成「看得见的状态」，直接改行为会把两件事混在一个 diff 里。
- **传输层失败算 `absent`** —— 拒绝。连都没连上时我们对目标机一无所知；报 `absent` 会让人去重装一个本来装着的 pi（同 3）。
- **把 `probeOutcome()` 改成异步** —— 拒绝。点击路径不许同步 spawn 是 ADR 0007 决策 4 的既有契约，改它需要单独论证（本机探测今天有一次同步 spawn + 一个 5s TTL 冻结，`pi-detection-timeout.test.ts` 守着）。
- **给 `global` 运行时做一次独立探测** —— 拒绝。已有 warm 探测的 stdout 就是版本号，再探一次是白花的 200ms 与一个新增失败模式。

## Consequences

- **契约变更（三处手写 wire 类型要同步改）**：`update:check` / `update:check-target` 返回多 `drift` / `terminalDrift`；`pi-install:notice` 多 `presence` / `detail`。`src/preload/index.ts`、`src/renderer/src/global.d.ts`、`renderer/stores/uiStore.ts` 三处都是手写的，没有生成器 —— 加一个字段要改三处，这是现状的税（已记在这里，不是本次要交的）。
- **`present()` 的返回值多一态**：这是对 ADR 0007 决策 6 的修订（那份 ADR 写的是三态）。调用方行为不变（`unrunnable` 今天走的就是「重装」），但类型变了，`pi-detection-timeout.test.ts` 补了断言。
- **本机横幅文案变了**：新增状态前缀。原来的本机句与远程句**逐字保留**在 `pi-drift-text.ts` 里（建议句 / 退路句），并有测试钉住「契约一致时逐字等于旧文案」。
- **`compareVersions` 从 `update-check.ts` 搬到 `src/shared/version-compare.ts`**：漂移分类（渲染层要读的共享模块）也要比较版本，而它原来只有一份、住在主进程 —— 不搬就得抄第二份。
- **诚实缺口 1**：本机 bundled 那条链（`checkPiUpdate` 真正填 `drift` / `terminalDrift` 的那几行）只有类型检查与纯分类器测试覆盖，**没有端到端测试** —— `checkPiUpdate` 一直没有测试（它要 mock 网络 + spawn + 扩展解析），本次没有为了测试去造一个只为测试而存在的 seam。远程侧的探测失败分类有测试（`remoteProbeOutcome` 导出，同 `remoteProbeFailureText` 的先例）。
- **诚实缺口 2**：WSL 的 PATH 泄漏（`bash -ic` 里 `/mnt/c/...npm/pi` 可能先于 distro 自己的 pi 被找到）**不在本切片**，它同时影响探测与执行，得在 exec/run 那一层一次性解决（已在 `docs/diagnosis/2026-10-05.md` 记录）。
- **与决策 36 的关系**：本切片**一个字都没改**「追最新」的行为 —— 本机仍建议升级到 npm latest，远程仍然只在对齐时换成契约版本。漂移状态是后续那两个改动（D：删掉三条追最新的路径；C：本机也跑捆绑 pi）**能够被讨论**的前提。
