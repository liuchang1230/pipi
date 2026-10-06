# ADR 0009：拆掉「追最新」的通路（app 只对齐目标机，不催用户升级）

Status: **accepted**（2026-10-05）

## 动机

用户对这个 app 的一句话评价是「它老是催我升级 pi 和插件」。这条抱怨指向的不是某句文案，而是四条**通路**——它们各自都有一份自己的判定，并且都能真的改动用户机器上的东西：

1. `checkPiUpdate` → `getLatestVersion()`：本机 pi 的版本跟 **npm registry** 比（`https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest`），有新版就在横幅上写「pi agent 有新版本：X → Y」。
2. `getExtensionUpdates()`：在**独立 node 子进程**里 import pi 的包管理器、问一句 `checkForAvailableUpdates()`，把用户自己配的扩展包也写进同一行横幅（「扩展包也有更新：…」）。
3. `runPiUpdate()`：横幅上那个「立即更新」＝ spawn `pi update --all`（300s 超时）。它**同时动全局 pi 和用户自己配的扩展包**。
4. `buildRemoteAlignCommand` 的尾巴：`… && (pi update --extensions 2>/dev/null || true)`——远程对齐装完我们钉住的版本之后，**顺手把用户的扩展包也升了**。

这四条都不服务这个 app 的卖点。捆绑 pi 只随 app 发版到手（决策 36）、远程只需要跟我们钉住的协议版本对齐、扩展包从来就是用户自己的（`.out-of-scope/no-cloud-skill-updates.md` 早就写过「不更新用户的 skill / 扩展」）。它们服务的是「别让你的 pi 落后」，而那不是我们的事。

还有一件在动手前查出来的事实，让第 1 条更站不住：**它探错了对象**。`probeLocalBundled()` 经 `localPiSpawnPlan()` 跑的是**全局 pi**（npm-global shim → node + 它的 `cli.js`），注释却写「本机**契约运行时**（捆绑 pi）」。捆绑 pi 真正被执行只有一条路——SDK 模式的聊天在同进程 `import` 它；「把捆绑 pi 装下去」是 `pty.ts` 的 `installGlobalPiFromBundled()`（拷进全局位置 + 写 shim，**从不就地跑**）。于是 `update-check.ts` 里相邻两行的 `classifyPiDrift({ runtime: "bundled" })` 与 `{ runtime: "global" }` 探的是**同一个东西**，同一台机器上可以互相矛盾，而名字还让人以为「app 自带那份在跑」。

## 决策

1. **本机不再有 pi 升级这条路**：删 `checkPiUpdate` / `getLatestVersion` / `REGISTRY_URL` / `probeLocalBundled` / `runPi` / `runPiUpdate` / `updateInFlight` / `UpdateInfo`，以及 IPC `update:check`、`update:run`（连带 preload 与类型桥的 `update.check` / `update.run`）。本机那个 pi 由 app **安装与修复**（决策 4 的 `ensurePiReady`），坏掉时由 `PiPresence` 说清是「没装」还是「装了跑不起来」并进故障中心（ADR 0008）——**真故障的可见性一点没减**，减掉的只是「有新版本」这种催。
2. **扩展包通路全删**：`getExtensionUpdates` / `resolvePiPackageEntry` / `RemoteUpdateInfo.extensions` / 横幅里那句「扩展包也有更新」/ 远程对齐的 `pi update --extensions` 尾巴。用户的扩展包永远由用户自己管，我们只保证目标机跑的是钉住的那个 pi。（`extension-sync` 的 `extNotice` **不在**这一刀里——那不是「追最新」，是「我们发的东西变了」，用户必须知道。）
3. **app 自己的更新提示保留**（`app-update:check` → GitHub Releases）：它是捆绑 pi 唯一的到手路径，而且它说的是「有一个新 pipi」，不是「你的 pi 过期了」。
4. **命名一并收敛**（事实 1 的处置）：删 `PiRuntime` 与 `PiDrift.runtime`，`classifyPiDrift({ bundled, probe })` 只服务目标机；`pi-drift-text.ts` 只剩目标机文案（`updateBannerText` = 状态即文案），`driftRecordText` / `piDriftNeedsRecord` 删掉——本机留痕由 `PiPresence` 那条路负责，远程探测失败由 `info.error` 那条路负责，同一件事不留两条痕。
5. **动作改名**：`runPiUpdate` → `runPiAlign`、`piUpdating` → `piAligning`，按钮「立即更新」→「对齐版本」、忙碌「对齐中…」、结果「已对齐到配套版本 X」/「对齐失败：…」。按下去发生的事是「把它换成我们钉住的版本」，不是「升级到最新」——旧名字本身就是用户那个误会的来源。
6. **远程漂移文案把动作说成「对齐」**：`对齐会把它装回/装到配套版本`。远程这条路的语义一个字没变（ADR 0008 定的六态、`hasUpdate` 的判定都不动）。

## Considered Options

- **保留本机横幅，改成「双向提示 + 对齐动作」** —— 拒绝。用户自己 `pi update` 追的新版会被 app 劝回退，与「追新是你的事」直接相抵；而且本机有两个 pi 在跑（SDK 模式吃包、rpc 模式吃全局命令），一句横幅说不清在对齐谁。
- **只保留「比 pin 旧」的提示** —— 拒绝。本机没有「必须相等」的契约（那是远程的 RPC 协议），而「比 pin 旧但能跑」并不坏；真坏了的那些已经被 `ensurePiReady` 覆盖。留着就是留一条只会在用户耳边响的通道。
- **只删远程尾巴，本机提示留着** —— 拒绝。那正是用户在抱怨的东西。
- **扩展包提示降级到日志** —— 拒绝。为了没人看的一行日志，留一条会 spawn 独立 node 进程的通路。
- **`runtime` 只记账、不改代码**（等 C 落地本机跑捆绑 pi 时再一起改） —— 拒绝。D 之后 `runtime` 只剩一个取值，留着是给死词汇续命；而且名字错了就该在发现它的那一刀里改掉，否则下一个人还得重新发现一次。
- **连 app 更新检查一起删** —— 拒绝。那是捆绑 pi 唯一的通路；删了用户永远拿不到新 pi。

## Consequences

- **用户可见的行为变化（有意）**：本机不再出现 pi 升级横幅与「立即更新」；`pi update --all` 这条路从 app 里消失（用户仍然可以在自己的终端里 `pi update`）；远程对齐之后不再顺手升级用户的扩展包。
- **IPC 契约收窄**：`update:check` / `update:run` 删除；`update:check-target` 的返回少 `latest` 与 `extensions`。`src/preload/index.ts`、`src/renderer/src/global.d.ts`、`renderer/stores/uiStore.ts` 三处手写 wire 类型同步改（现状的税，ADR 0008 已记）。
- **`RemoteUpdateInfo.latest` 删除**：它就是 `drift.bundled`，两个字段说同一件事。
- **测试**：删掉 B 建立的本机真值表用例；`pi-drift.test.ts` / `pi-drift-text.test.ts` 收敛为目标机；`pi-version.test.ts` 那条「保留 `pi update --extensions`」的断言反转为「命令里不许出现 `pi update`」。**ADR 0007 的「命令逐字不变」验收对本切片不适用**——远程对齐命令的字节变化正是本切片的目的。
- **诚实缺口 1**：本机 pi 的版本从此**没有任何周期性检查**。app 只在「要用它」时看它一眼（`ensurePiReady` 与探测缓存），所以「全局 pi 比 pin 旧」不再可观测——这是决策本身，不是漏。
- **诚实缺口 2**：`pty.ts` 的 `installGlobalPiFromBundled()` 仍然会在用户全局位置被覆盖安装（决策 4 的自动修复路径）。本切片只删「催升级」，不动「不可用时装我们那份」这个取舍；C（本机也跑捆绑 pi）会重新讨论它。
- **与决策 36 的关系**：本机「允许用户追最新」这条自由**仍在**（我们不拦、也不动用户自己装的那份，除非它不可用），只是 app 不再提议、不再代劳；远程那半条（对齐 pin）不变。
- **与 ADR 0008 的关系**：本切片覆盖了它三处结论（`runtime` 三元组、本机横幅「先状态再原建议」、`driftRecordText`），已在 0008 的 Status 里注记。六态分类本身、`PiPresence` 四态、以及「漂移不是失败」都保留。
