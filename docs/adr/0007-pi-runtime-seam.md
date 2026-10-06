# ADR 0007：pi 运行时 seam —— 注入 CommandRunner，不复用 Target

Status: **accepted**（2026-10-05）

## 动机

「哪一个 pi、哪个版本、在哪个目标上跑什么命令」这件事今天散在三处，各有各的实现：

- **本机解析三份**：`pty.ts:373`（`resolvePiBin`，优先全局 `pi.cmd`）、`pty.ts:991`（`runPiVersion`，spawnSync）、`rpc-session.ts:255`（`localSpawnPlan`）；`update-check.ts:78` 与 `rpc-session.ts:218` 还各自有一份 node/cli 解析。
- **目标机执行三份自造传输**：`update-check.ts:622`（裸 `ssh.exe` spawn）、`:635`（自建 `ssh2` 客户端）、`:629`（裸 `wsl.exe` spawn）。而同一个仓库里 `content-sync.ts:644` 已经在用**已存在的** seam —— `ssh-exec.ts` 的 `SshScriptRunner`（`content-sync.ts:624`），它的注释写着「tests can drive it with a fake; the caller has already bound the remote and the ssh binary」。
- **版本缓存两处**：`pty.ts` 的 `cachedPiOk` / `cachedPiTimedOut` / `PI_RECHECK_TTL_MS`，与 `update-check.ts:462` 的 6h Map（键是就地拼的字符串，已经是第三种 targetKey 格式）。

而 ADR 0001 的 Consequences 不但点名了这种形状，还**明确把这件事推迟**：

> 「git 通道（`diff-session.ts` 自有 `GitCtx`）与 exec 通道（`sshExec` / `sshCatRemoteFile` / `file:diagnose-mentions` 自建 `SshClient`）**不在本 seam 内**。若将来把 `Target` 扩成它们的共同表示，那是另一个决策。」

本 ADR 就是那个决策，而且答案是：**不扩 `Target`，exec 通道要有自己的窄 seam。**

## 决策

1. **seam 的输入是注入的 runner，不是目标描述。** `CommandRunner = (o: { command, stdin?, timeoutMs? }) => Promise<RunResult>`（`RunResult = { ok, code, stdout, stderr, error? }`）。命令文本由调用方给（POSIX 文本，由目标 shell 展开），凭据、二进制与 shell 方言由绑定方给。它就是 content-sync 里 `SshScriptRunner` 的通用形态，**改名并搬到 `src/main/runner.ts`**（连带 `DEFAULT_SSH_TIMEOUT_MS` → `DEFAULT_COMMAND_TIMEOUT_MS`、输出截断上限）。绑定由调用方注入：免密 → `runSshCommand`（`ssh-exec.ts`）、密码 → `runSsh2Command`（`ssh2-exec.ts`）、WSL → `runWslCommand`（`wsl-exec.ts`）；这三处的现场是 `update-check.ts` 的 `portForTarget()` 与 `index.ts` 的 key-auth 绑定，不是某个中央工厂。
2. **拆成两个 module**：`localPi`（本机解析 / 在场 / 探测）与 `piVersion`（runner 侧 `probe` / `align` / `invalidate`）。一半是纯本机 fs + 探测，一半全在 runner 那侧，硬装一个会得到 interface 里一半成员与另一半无关的浅模块。
3. **`PiPort = { run: CommandRunner, key }`**（实现里还带一个可选的 `target: { cwd?, agentDir? }`——`piVersion` 得自己拼 `bash -ic '…'` 与 `cd`，所以它至少要知道“在哪个目录、要不要注入 `PI_CODING_AGENT_DIR`”，但这只是启动参数，不是目标词汇）是一次远程调用的完整输入；`key` 是缓存身份（`"local"` / `wsl:<distro>` / `buildRemoteKey(remote)`，`pty.ts:1135`），版本缓存挂它，`align` 成功后 `invalidate(key)`。注入 `PiPort` 意味着 `piVersion` **不认识**目标词汇，因此不会长出第七份「目标」。
4. **输出事实，不输出 spawn plan**：`resolveLocal()` 给 `{ source, nodeBin, cliJs, version? }`，版本只在显式 `probe()` 时取。`createTab` 是同步的（`pty.ts:1386` → `:1397`），点击路径只做纯解析——探测是副作用与延迟，不该藏在解析里。
5. **模块 throw 分类错误**，**用户文案留在边界**。落成实现时收敛为两个轴：`kind: "timeout" | "failed"`（超时与其它失败——旧代码也是这么分的）加 `phase: "install" | "verify"`（对齐的哪一步），另带原始 `stderr`（友好文案靠它分流）、运行器给的 `detail`（`ssh not found` / `exit 127`）与已产出的安装日志。原计划的 `not-found` 并入了 `failed` + `detail`：运行器已经说清了是“没找到 ssh”还是“pi 不在 PATH”。文案仍逐字沿用今日的串，留在边界（同 ADR 0001 ③ 的 `mutationErrorText`）。
6. **`localPi.present()` 返回三态 `present | unverified | absent`。** 「探测超时 ≠ 缺失」从 `pty.ts:403-430` 的注释升级为具名状态，折叠（`p !== "absent"`）由三个调用方（`index.ts:1260/1266/1276`）各写一行，行为不变。
7. **pin 的真值只有一处**：`localPi.bundledPiVersion()` —— 只读 app 自带包，兜底读 app `package.json` 的精确 pin，**用户全局 pi 永不参与**（决策 38 的 ETARGET 事故）。`piVersion` 不知道 bundle，pin 永远是显式参数。
8. **策略不进模块**：要不要提示、要不要对齐、对齐完弹什么，留在 `update-check` 与渲染层。module 只回答「能不能跑、什么版本、来源是什么」。
9. **切片：远程先行。** ① 免密 ssh（`update-check.ts:506/622` → runner，删自造 `runSshCommand`）→ ② WSL（`:510/629`）→ ③ ssh2 密码（`:515/639` → `src/main/ssh2-exec.ts` 的 `runSsh2Command`，2026-10-05 完成：`portForTarget` 成为唯一入口，自造 `runSsh2Version`/`runSsh2Command`/`collectVersion`/`remoteCached` 与 `...Legacy` fork 全删；本次**只重绑这两处**，`index.ts:2503/1640`、`diff-session.ts:98/551` 留下一个 slice）→ ④ 本机 `localPi` 搬迁并删 `RemoteUpdateTarget` + `updateTargetForTab`（ADR 0001 点名的「每个消费者各自再派生一次」），**2026-10-05 完成，分两段**：
   - **④a 删掉第七份目标词汇**：`RemoteUpdateTarget` 接口与 `index.ts` 的 `updateTargetForTab` 全删，两条 IPC（`update:check-target` / `update:run-target`）改成 `tab ? targetFromTab(tab) : undefined` —— 用的就是 ADR 0001 那个桥，与它旁边的会话文件路径（`index.ts:2247`）同一个写法。`portForTarget(target: Target)` 因此只剩 `local → null` 一个守卫，「信息不完整」的假目标不见了。label/`kind` 仍在边界层拼（`WSL <distro>` / `user@host`，渲染层逐字不变）。
   - **④b `local-pi.ts` 接手本机解析**：`resolveLocal()`（`{ piBin, source, nodeBin, cliJs }`，纯解析）、`globalPiBin()`、`localPiSpawnPlan(args)`（node + cli.js 优先，否则 cmd shim）、`present(): present | unverified | absent`、`warm()`、`invalidate()`、`bundledPiVersion()`（pin 的唯一真值）。四个消费者改成问它：`pty.ts` 的 `resolvePiBin`（TUI 仍**偏好 cmd shim**，那是另一条策略）、`rpc-session.ts` 的 `localSpawnPlan`（`--mode rpc`）、`update-check.ts` 的 `runPi`（`pi update` / `pi --version`）、`projects.ts` 的模型验证（`pi --list-models`）。Windows 可执行文件查找（`findExe` / `findExeOrNull` / `findViaWhere` / `npmGlobalDir` / `DETECT_SPAWN_TIMEOUT_MS`）另起 `find-exe.ts`：它的消费者还有 `findSshBin` / `findWslBin` / npm，而 `local-pi` 需要它 —— 不拆开就会出现 `pty ↔ local-pi` 的循环依赖（原来的注释说 `findExe` 留 `pty.ts`，实现时发现留不住）。

   验收是**可机测**的行为不变：交给 fake runner 的 command 与今日 `buildRemoteAlignCommand` / `targetPiCommand` 输出字节相同，用户文案逐字相同（本机侧则是同一段探测代码的搬运）。

## Considered Options

- **吃 `Target`**（顺着 ADR 0001 字面的方向）—— 拒绝。`Target` 的 `kind` 是**用途**轴（`sftp` = 浏览/预览、`ssh` = 会话快路径），而这里要的是**凭据**轴（`remote.password` 的有无决定 `ssh2` 还是 `ssh.exe`，`rpc-session.ts:534/542` 就是这么分的）；它的 `root` 也不是这里要的根——ADR 0001 自己已经因为 `remoteBrowsePath` 与 `remote.path` 两个根吃过一次亏。硬套进去会得到一个带着它不用的 `root`、不用的 kind 轴的浅模块。**`Target` 是文件 IO 的根相对世界里长出来的形状**，exec 通道的窄 seam 是它的对偶，不是它的子集。
- **新造第七份 `PiTarget`** —— 拒绝。现有六份（`Target` / `SessionTarget` / `GitCtx` / `RemoteUpdateTarget` / 渲染层 `TargetRef` / wire `RemoteTarget`）已经够多。
- **一个 module 装两半** —— 拒绝（见决策 2）。
- **返回 spawn plan**（沿用 `localSpawnPlan` 的形状）—— 拒绝：`version` 与 `source` 无处可放，漂移（ADR 0001 之后的下一个决策）没有挂点。
- **保留 `SshScriptRunner` 这个名字** —— 拒绝：WSL 也套这个形状，名字里的 Ssh 会误导下一个人。
- **缓存留在调用方** —— 拒绝：第三种 targetKey 格式会继续存在，而「缓存键与失效点」本身就是这个 module 的事实。
- **全异步 `localPi`** —— 拒绝：`createTab` 是同步的，改成竞态不是本次的目的。
- **错误用 `Outcome` 而不是 throw** —— 拒绝：仓库里 target-fs / content-sync 都是「模块内分类、边界译文案」，并存两套风格没有收益。

## Consequences

- **代价：exec 通道有自己的窄 seam，`Target` 不再「统一一切」。** 这是有意的取舍。将来再有人提「把 PiRuntime 合并进 Target」，读这一节。
- `update-check.ts` 瘦成「app 更新 + 何时提示 + 何时对齐」——**逐 slice 兑现**：slice 1/2 后是 693 → 689 行，因为过渡期的 `...Legacy` fork（ssh2 密码目标的自造传输 + `collectVersion`，约 140 行）还在同一个文件里；**slice 3 接上 ssh2 绑定后跌到 576 行**（`...Legacy`、`collectVersion` / `runSsh2Version` / `runSsh2Command` / `remoteCached` 全删，目标类型的分叉在代码里不再存在）；**slice ④ 把本机解析交出去后跌到 492 行**（`pty.ts` 同时 −296：2004 → 1708，搬出去的是探测缓存 + pi 解析 + 可执行文件查找）。`portForTarget()` 是唯一入口（三类目标：免密 ssh / 密码 ssh2 / WSL），只剩一个 `null` 守卫给「本机标签」。`runner.ts`（类型与**唯一一份** spawn 契约 `runCommand()`）/ `local-pi.ts`（354 行，本机 pi 的事实与在场）/ `find-exe.ts`（69 行，Windows 可执行文件查找）/ `pi-version.ts`（215 行，probe / align / 版本缓存）各领一块职责，传输则是三个薄绑定 `ssh-exec.ts`（key-auth ssh，72 行）/ `wsl-exec.ts`（`wsl.exe`，51 行）/ `ssh2-exec.ts`（密码 ssh2，121 行）——三者只讲连接参数、argv 形状与默认值。两个绑定也把「一个 adapter 是假 seam，两个才是真 seam」那条纪律凑齐了：正是第二个 adapter 才让 spawn/超时/截断/失败契约从 ssh-exec（164 行）搬进 `runner.ts`；第三个适配器（ssh2 不走 `spawn`，而是走库的 channel）又把这套契约里的**有界输出累加器**从 `runner.ts` 的私有实现提为导出（`createOutputCollector`），因为它是「同一契约的第二个实现」共用的那一小块，而不是 spawn 专有的东西。
- **本 effort 不改任何行为**——除了上面几条已实测、已接受的偏差（全部在本机或 Ubuntu-22.04 上跑过，不是纸面推断）。④a / ④b 完成后，**A（seam）这一支的四个 slice 全部落地**。之后的独立一刀：**B** 版本漂移升为一等状态（`PiPresence` 与 `probe()` 的返回形状已经为它铺好三个挂点）、**D** 拆掉三条「追最新」通路（本地对比 npm latest 的横幅、`pi update --all`、扩展包提示；**已落地：`docs/adr/0009-no-chase-latest.md`**）、**C** 本地改跑捆绑 pi（反转决策 36，需先解决 asar 解包）、**E** 不把二进制安装塞进 content-sync 的文件形 `ContentIo`——共用传输 seam，不共用文件形接口。另有一件待用户拍的：WSL 里 `pi` 落到 `/mnt/c`（宿主 npm 全局）还是 distro 自己那份（`docs/diagnosis/2026-10-05.md`，本次只记录不改）。
- **接受的偏差：ssh2 目标的安装日志少了 stderr。** HEAD 的三个传输里，只有 `runSsh2Command`（密码路径的 align）把 stderr 拼进成功输出（`out + (error ? "\n" + error : "")`），两个 `collectVersion` 系（key-auth ssh / WSL）都只取 stdout；新实现三个绑定统一「成功输出 = stdout」，`align` 再决定怎么用。所以密码目标更新成功后弹窗里少一截 npm 的 stderr（npm 的进度/摘要本来大多写 stderr）——**不是 slice 3 新造的不一致，而是 slice 3 把落单的那一个收齐**。要让它变好应反过来统一：`align` 把 stderr 也带上（三个绑定一起改，属于独立一刀），别只给 ssh2 开小灶。
- **接受的偏差：ssh2 目标的连接超时 20s → 15s。** 旧 `runSsh2Version` 的 `readyTimeout` 是 15000、旧 `runSsh2Command`（align）却是 20000，没有任何注释解释这个差别；新绑定统一默认 15000（与探测路径逐字一致：握手超时的错误原文不再被 20s 的整体超时抢先变成「远程 pi 版本检查超时」）。
- **接受的偏差：ssh2 目标的安装失败文案在「空 stderr」时从「远程 pi 更新失败」变成「远程 pi 不可用」。** 旧 align 的 reject 原文是 `stderr || "远程 pi 更新失败"`，新路径统一走 `remoteProbeFailureText`（绑定层只说事实：`stderr` + `detail: "exit <code>"`，给人看的措辞只在边界层拼），裸退出码退到「远程 pi 不可用」——与探测路径同一规则。**同一个归一化也适用于探测路径**（旧 `collectVersion` 同样是 `stderr || "远程 pi 不可用"`，所以两边本就是一回事）。
- **接受的偏差：安装阶段超时的文案从 ssh2 旧路径的「远程 pi 更新超时」变成「远程 pi 版本检查超时」。** 旧代码里三份传输自己搵两套文案：`collectVersion`（key-auth ssh / WSL）超时写死「远程 pi 版本检查超时」，`runSsh2Command`（密码 ssh2 的 align）写死「远程 pi 更新超时」——同一个阶段两个措辞。新边界层统一成一句（`remoteProbeFailureText` 只看 `kind`），所以对 2/3 旧路径逐字相同，只有密码 ssh2 的安装超时换了字。真正的修法是让 `PiCommandError` 带上的 `phase` 决定措辞（`install → 远程 pi 更新超时`）——但会改动另两条路径的现有文案，留作独立一刀。
- **未变：ssh2 的命令字节与验证/成功文案。** 与 HEAD 逐项对齐：`runSsh2Version` / `runSsh2Command` 都是 `conn.exec(\`bash -ic '${targetPiCommand({cwd: remote.path, agentDir: remote.agentDir}, command)}'\`)`，新路径是 `loginShell(targetPiCommand(port.target, …))`，而 `targetPiCommand` 本体与参数搬动前逐字相同（已机测）；认证（`tryKeyboard: true` + keyboard-interactive 回答密码）、TOFU（`hostVerifier: () => true`）、探测 20s / 连接 15s、`conn.end()` 不漏、验证失败文案与 `（）` 空括号的毛病、成功输出 `(output + "\npi " + version).slice(-2000)`，全都一模一样；旧代码用 `[...out.split(/\r?\n/)].reverse().map(parseVersion).find(…)` 取「最后一行像版本号的」，`pi-version.ts` 的 `pickVersionFromOutput` 是同一段逻辑的搬运。（唯一不可达的例外：目标信息缺失时旧代码会在 promise 里抛 TypeError，现在直接返回「目标信息不完整」。）
- **接受的偏差：`cli.js` 的解析统一到了 `pty.ts` 那一版。** HEAD 里有两份：`pty.ts` 的 `resolveCliJsFromShim`（先试标准 npm 布局，再读 shim，认 `%dp0%`）与 `update-check.ts` 自己那份（先读 shim 再试标准布局，不认 `%dp0%`）。现在只剩第一份。对任何真实安装两者给出同一个绝对路径（实测：本机 npm 全局布局两份都指向 `…/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`）；差别只在异常布局上。**例外：`scripts/rpc-spawn-probe.mjs` 仍自带一份 `findNodeBin` / `resolveCliJs`** —— 它是脱离 app 模块图的排查脚本（同样带着自己那份 `findSshBin` 式查找），本次不动；下次有人改本机解析的优先级时，记得它不会跟着变。
- **接受的偏差：远程/WSL 目标的探测与对齐多了一句 `cd $HOME`。** slice ④a 把 `portForTarget` 的输入从 `RemoteUpdateTarget`（带着 `remote.path` / `wsl.path`，可以为 `undefined`）改成 `Target`，而 `targetFromTab` 已经把缺省 path 归一为 `"~"`（ADR 0001 的约定），`targetPiCommand` 再把 `~` 展开成 `$HOME`。所以标签页没填路径时，命令从「不 cd」变成「`cd $HOME`」。**语义上更对**（非交互 `bash -ic` 的默认 cwd 本来就是 `$HOME`，现在探测跑在标签页真正跑 pi 的那个目录里），但字节变了——这是 ④a 唯一一处不逐字的命令差异。
- **接受的偏差：本机侧没有夹具测试，只有实测。** 旧的 `pi-detection-timeout` / `pi-install` 测的是搬走的那几个纯函数，现在从 `local-pi` / `find-exe` 导入（三态断言比旧的布尔断言更严：`unverified` 不再等于 `true`）；`resolveLocal` / `localPiSpawnPlan` / `bundledPiVersion` 没有单测（它们摸真实 fs/PATH/app 路径），靠 slice ④b 的实测与全套回归（`91 passed | 1 skipped` 文件、`1332 passed | 4 skipped` 用例）。
- **slice ④b 实测（本机，2026-10-05）**：`resolveLocal()` 给 `{ piBin: C:\Users\chang\AppData\Roaming\npm\pi.cmd, source: "npm-global", nodeBin: C:\Program Files\nodejs\node.exe, cliJs: …\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js }`，`localPiSpawnPlan(["--version"])` 给出 `node <cli.js> --version`（与旧 `localSpawnPlan` 逐字相同），`bundledPiVersion()` = `0.85.1`。`present()` 在同一台机器上返回 **`absent`** —— 因为那台机器的全局 pi 真的是坏的（`pi --version` 退出 1：`Cannot find package '@earendil-works/pi-server'`，一次中断的 npm 安装），而旧 `hasGlobalPiInstalled()` 会给出同样的结论（同一段探测代码、同一个 `findPiBin` 优先级）。这正是三态存在的理由：`absent` 才让 `ensurePiReady` 拿捆绑副本修复它，而 `unverified` 不会。
- **接受的偏差：WSL 目标多一层 `bash -ic`。** `pi-version` 把命令包成 `bash -ic '…'`（因为 ssh 远端拿到的是非交互 shell，要靠这一层拿到 rc 里的 PATH），而 `wsl-exec` 的 argv 本身就是 `wsl -d <d> -- bash -ic <cmd>`——两边都说了一遍「给我交互 bash」。旧代码在 WSL 路径上是单层（`bash -ic <inner>`），现在是 `bash -ic "bash -ic '<inner>'"`。**实测无害**：Ubuntu-22.04（nvm + pi 0.85.0）上两种写法输出逐字相同（`0.85.0`，`node`/`npm` 都从 nvm PATH 解析），没多出的 rc 输出，耗时差异在冷启动噪声以内。真正的修法是「登录 shell 是传输层保证、`pi-version` 不该自己包」——但那会让 `ssh-exec` 包住 content-sync 的 `sh -s`（多读一次 rc、rc 里的 `cd` 会影响 provisioning 脚本），代价大于收益。记在这里，将来有人重提时先读这段。
- **slice 2 附带发现（未修，已取证）：WSL 目标的 `pi` 解析会漏到宿主机 PATH。** WSL 互操作会把整条 Windows PATH 翻译成 `/mnt/...` 追加进发行版 PATH，于是 `wsl -d D -- bash -ic 'pi --version'` 可能报的是 **Windows 侧**的 pi（本机实测：手工 `bash -ic` 得 0.85.0 = `/mnt/c/.../npm/pi`，探针得 0.85.1 = 宿主机 PATH 里的 app 捆绑 pi）。**不是 slice 2 引入的**（HEAD 的旧 WSL 探测同样不传 `env`/`cwd`），但更关键的是**现在不能只修探针**：WSL 标签页（`pty.ts` `createWslTab`）与 WSL 聊天传输（`rpc-session.ts:521`）用的是同一套环境，所以探针解析到的 pi **正是**标签页会启动的那个。只清洗探针的 PATH 会让两者分叉，而那是 ADR 0001 要消灭的「一处目标、两种真相」——三处一起修属于 ADR 0001 留给后续的 exec/运行通道决策。取证与影响面：`docs/diagnosis/2026-10-05.md` 的「WSL 目标的 `pi` 解析会漏到 Windows 主机 PATH」。
- `findSshBin` / `findWslBin` 留在 `pty.ts`（runner 绑定继续 import；它们是「按名字找一个 Windows 可执行文件」，与 pi 无关），搬迁留作后续；`findExe` 族本来也要留，④b 实现时发现 `local-pi` 需要它，留在 `pty.ts` 会形成 `pty ↔ local-pi` 循环，于是另立 `find-exe.ts`（见决策 9 ④b）。

## 既有记录的修正：pin 的真值（2026-10-05 实测）

`update-check.ts:344-348` 的注释与 `architecture-decisions.md` 决策 37 都写着「内置 pi 精确锁定 **0.84.2**，因为 app 自己的 Electron 是 Node 20，而 0.84.3+ 用 `fs.globSync`（Node ≥22.13）」。**该约束已经解除**，实测：

| 事实 | 值 |
|---|---|
| app 自带 pi（`node_modules/@earendil-works/pi-coding-agent`） | **0.85.1** |
| 它的 `engines` | `node >= 22.19.0` |
| Electron（`36.9.5`，`ELECTRON_RUN_AS_NODE` 实测） | **Node 22.19.0** |
| app `package.json` 的 pin | `"@earendil-works/pi-coding-agent": "0.85.1"`（无 caret） |

0.85.1 正是「Electron 36 的 Node 刚好等于 engines 下限」的那一版：`fs.globSync` 需要的 Node ≥22 **已经满足**，不是被违背。所以真规则不是「锁死在某个旧版本」，而是 —— **pin 必须满足 app 自带 Electron 的 Node 版本**（`bundledPiVersion()` 可以顺带断言 `semver.satisfies(process.versions.node, bundled.engines.node)`）。三处原本互相矛盾的记录（代码注释 / 决策 37 / `package.json`）按此收敛。
