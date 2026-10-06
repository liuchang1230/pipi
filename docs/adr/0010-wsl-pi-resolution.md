# ADR 0010：WSL 目标只认发行版自己的 pi（PATH 清洗 + `--exec` argv）

Status: **accepted**（2026-10-05）

## 动机

WSL 目标上「pi 在不在、是哪个版本」这个问题，app 一直拿到的是**宿主机**的答案：
互操作默认把整条 Windows PATH 翻译成 `/mnt/...` 追加进发行版 PATH，`command -v pi`
命中 Windows 侧的 npm 全局 shim——它跑在宿主 node 上，对齐还会从发行版内部往宿主
npm 里装。实测（`docs/diagnosis/2026-10-05.md`）：探测 Ubuntu-22.04 得到宿主的
0.85.0，乃至 app 自身仓库 node_modules 里的 0.85.1——**探测结果由宿主机决定，与
发行版装没装 pi 无关**；而终端标签、聊天传输用的正是同一套环境，探到的就是会跑的。

动手修复时又发现第二层：`wsl.exe -d X -- bash -c '…'` 的 `--` 之后 wsl.exe 仍按
**Windows 侧环境**预展开 `$VAR`（没有的变空串），命令里的 `$( )`、`$P`、`${P#~/}`
全部失真——`targetPiCommand` 的 base64 cwd 解析在 WSL 上从未真正执行过，「能用」
纯属运气。

用户拍板（2026-10-05）：**只认 distro 自己的 pi**——distro 里装了就用它的，没装就
是「没装」（提示对齐，一键装进 distro）；对齐也装进 distro。不做「回退宿主」。

## 决策

1. **PATH 清洗是命令的一部分**（`src/main/wsl-shell.ts` 的 `wslInnerCommand`）：
   发行版内把 `/mnt/*` 从 PATH 滤掉再跑原命令。四个消费者共用——探针与对齐
   （`wsl-exec.ts`）、聊天传输（`rpc-session.ts`）、终端 pty（`pty.ts`
   `createWslTab`）——保证「探到的」与「会启动的」是同一个 pi（ADR 0001 的
   「一处目标、一种真相」）。**不给探钢单独清洗**：那会让探针报「没装」而终端
   启动宿主 pi。
2. **argv 用 `--exec /bin/bash` 而不是 `-- bash`**（`wslArgv`）：`--exec` 绕开
   wsl.exe 的 `$VAR` 预展开层，命令文本原样到达发行版 shell。`targetPiCommand`
   与 `buildRemoteAlignCommand` 的命令文本**一个字不改**，改的只是送达方式。
3. **发行版里没装 pi 就是没装**：探测报 `absent`（ADR 0008 的语义），横幅提示
   对齐；对齐（`npm install -g`）在清洗后的 PATH 里跑，自然落进 distro 自己的
   npm 全局（nvm 或 apt 的），命令无需特判 WSL。
4. SSH 目标不受影响：远端 PATH 是远端机器自己的事，本决策只覆盖「透过 wsl.exe
   进发行版」的调用。

## Considered Options

- **只给探针清洗 PATH** —— 拒绝。探针与执行分叉是 ADR 0001 要消灭的「一处目标、
  两种真相」；当时（ADR 0007 期间）不动它正因为漏的不止探针。
- **允许回退宿主 pi**（用户未选）—— 拒绝。回退让每个消费者都带两层逻辑，且
  「跑的是 Windows 侧 pi」很难在界面上持续说清；不如让「distro 没装」成为明确
  状态、用对齐补齐。
- **保持 `--`，把命令改成不含 `$` 的写法** —— 拒绝。`targetPiCommand` 的 cwd
  解析、`P=$(command -v pi)` 的安装方式判别都离不开 `$`；全部 base64 化是给
  死词汇续命，且 `--exec` 一处改动就修好全部现有文本。
- **关掉互操作**（`/etc/wsl.conf` 的 `[interop] appendWindowsPath=false`）——
  拒绝。那是用户机器的全局配置，改它影响 distro 里其他工作流，app 无权替用户决定。

## Consequences

- **用户可见行为变化（有意）**：WSL distro 没装 pi 时，界面从「显示宿主版本、
  提示已对齐/需更新」变成「没装 + 一键对齐」；WSL 终端里的 `pi` 也变成 distro
  自己的（不再莫名用到 Windows node）。distro 自己装了 pi（nvm 等排在 `/mnt/*`
  之前的常见情形）的用户行为不变。
- **对齐的落点随之正确**：`npm install -g` 在清洗后的 PATH 里解析到 distro 自己
  的 npm；此前若 distro 没装 npm，命令会意外命中宿主 `/mnt/c/.../npm` 并把包装进
  Windows 侧。
- **`--exec` 是 wsl.exe 的行为契约**：修复了 cwd/安装方式解析从未生效的暗伤；
  但 `bash -ic` 的 rc 加载语义在 `--exec` 下不变（`-i` 仍读 `.bashrc`），实测
  nvm 路径正常出现。
- **诚实缺口**：`index.ts:1760` 提及菜单的文件搜索也走 `wsl.exe -- bash -lc`，
  它不解析 pi，本次未动；若未来在命令里用 `$VAR` 需注意同样的预展开。
  docker-desktop 这类精简 distro 没有 `/bin/bash`，`--exec` 会失败——此前 `--`
  形状同样失败（没有可用的发行版 shell），非回归。
- 决策与真机证据：`docs/diagnosis/2026-10-05.md`（原发现 + `--` 预展开追记）。
