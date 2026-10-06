/**
 * wsl-shell.ts — WSL distro 里跑命令时「哪个 pi 才算数」的规则，一处定义。
 *
 * 两层坑，都在 `docs/diagnosis/2026-10-05.md`：
 *
 * 1. **PATH 泄漏**：WSL 互操作默认把整条 Windows PATH 翻译成 `/mnt/...` 追加进
 *    发行版 PATH。`command -v pi` 会命中 Windows 侧的 npm 全局 shim —— 它跑在
 *    宿主 node 上，对齐也会从发行版内部往宿主 npm 里装。实测：探测
 *    Ubuntu-22.04 得到宿主 0.85.0，乃至 app 自身仓库 node_modules 里的 0.85.1。
 *    解法：命令前置 PATH 清洗，只留发行版自己的条目（ADR 0010）。
 *
 * 2. **wsl.exe `--` 预展开**：`wsl.exe -d X -- bash -c '…$VAR…'` 里的 `$VAR`
 *    会被 wsl.exe 在启动发行版 shell **之前**展开成空（用 Windows 侧的环境）。
 *    `X=abc; echo "[$X]"` 打出 `[]`；换成 `--exec /bin/bash` 同一条命令就得到
 *    `[abc]`。产品里的探测/对齐/聊天/终端全部走 `-- bash -ic`，所以
 *    `targetPiCommand` 的 `$(…)`、`$P`、`${P#~/}` 在 WSL 上从来没正确执行过。
 *    解法：argv 用 `--exec /bin/bash`，绕开预展开层（`wslArgv`，wsl-exec.ts）。
 *
 * 决策（ADR 0010）：**WSL 目标只认发行版自己的 pi**。探针、对齐、聊天传输、
 * 终端 pty 四个消费者共用 `wslInnerCommand`，保证「探到的」与「会启动的」是
 * 同一个 pi（ADR 0001 的「一处目标、一种真相」）。发行版里没装 pi 就是没装：
 * 横幅提示对齐，一键装进 distro 自己的 npm 全局。
 *
 * 注意这只对「透过 wsl.exe 进发行版」的调用生效。SSH 目标的远端 PATH 是远端
 * 机器自己的事，与本文件无关。
 */

/** 发行版内的 PATH 清洗：丢掉所有 `/mnt/*` 项（Windows 侧的翻译件），其余
 *  原样保序。`$PATH` 由 bash 自己展开 —— 所以调用方必须用 `--exec`（见上）。 */
export function wslCleanPathSnippet(): string {
  return 'PATH=$(printf %s "$PATH" | tr ":" "\\n" | grep -v "^/mnt/" | paste -sd:) && export PATH';
}

/** 用清洗后的 PATH 跑一段发行版内命令。`inner` 是已经在发行版 shell 里成立
 *  的命令文本（现有各处拼法不变，直接前置清洗）。 */
export function wslInnerCommand(inner: string): string {
  return `${wslCleanPathSnippet()} && ${inner}`;
}

/** wsl.exe 的 argv 形状。`--exec /bin/bash` 而不是 `-- bash`：`--` 之后
 *  wsl.exe 仍会按自己的规则预展开 `$VAR`（Windows 侧没有的变量一律变空），
 *  命令里的 `$( )`、`$P`、`${P#~/}` 全部失真；`--exec` 把字符串原样交给
 *  发行版 shell。命令始终是最后一个参数，且不随载荷增长。 */
export function wslArgv(distro: string, command: string): string[] {
  return ["-d", distro, "--exec", "/bin/bash", "-ic", wslInnerCommand(command)];
}
