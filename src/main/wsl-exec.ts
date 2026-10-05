/**
 * wsl-exec.ts — run ONE command inside a WSL distro through `wsl.exe`.
 *
 * 这是 `CommandRunner` 的 WSL 绑定（ssh-exec 与它并列，第三个绑定是 ssh2 密码
 * 通道）。spawn、超时、输出截断与失败契约都在 `runner.ts` 的 `runCommand()`；
 * 这里只负责 `wsl.exe` 的 argv 形状与默认值。
 *
 * 形状：`wsl.exe -d <distro> -- bash -ic '<命令>'`
 * - `-d` 选发行版（WSL 的默认发行版可能不是标签指向的那个）。
 * - `--` 结束 wsl.exe 自己的选项解析，免得命令里的 `-` 开头参数被它吃掉。
 * - 命令走 `bash -ic`：Linux 侧的 PATH 常由 rc 文件设置（nvm / bun /
 *   ~/.local/bin），非登录 shell 看不到 pi。
 *
 * 决策与代价：`docs/adr/0007-pi-runtime-seam.md`。
 */
import { runCommand, type RunOptions, type RunResult } from "./runner";

export interface WslTarget {
  distro: string;
}

/** 一次 WSL 调用：`command` / `stdin` / `timeoutMs` 是共享的运行器契约
 *  （runner.ts）；WSL 补齐发行版、二进制与输出上限。 */
export interface WslRunOptions extends RunOptions {
  distro: string;
  /** 覆盖 wsl.exe 路径（app 用 findWslBin() 解析一次）。 */
  wslBin?: string;
  /** 抓到的输出超过这个长度就截断。 */
  maxOutputBytes?: number;
}

export const DEFAULT_WSL_BIN = "wsl.exe";

/** WSL 调用的 argv。导出以便测试断言其**形状**——尤其是命令始终是最后一个
 *  参数、且不随载荷增长。 */
export function wslArgv(distro: string, command: string): string[] {
  return ["-d", distro, "--", "bash", "-ic", command];
}

/** 在 `distro` 里跑 `command`。与 `runSshCommand` 同契约：永不 reject、永不抛，
 *  失败以 `ok: false` + 原因回来。 */
export function runWslCommand(opts: WslRunOptions): Promise<RunResult> {
  return runCommand({
    bin: opts.wslBin ?? DEFAULT_WSL_BIN,
    argv: wslArgv(opts.distro, opts.command),
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    notFound: "wsl not found",
  });
}
