/**
 * runner.ts — 「在某台机器上跑一条命令」这件事的类型与**唯一一份实现**。
 *
 * 为什么有它：pi 版本探测/对齐要在几种目标上跑同样的命令（免密 ssh、ssh2
 * 密码、wsl.exe），而 update-check 为每种传输各写了一份 spawn；content-sync
 * 早就有同一个形状（`run({command, stdin, timeoutMs})`，把脚本走 stdin），
 * 只是它叫 `SshScriptRunner` 且只在 key-auth ssh 里用。这里给它一个不含传输
 * 名字的名字，让三种绑定和两种用途共用一份类型。
 *
 * 决策与代价（为什么不复用 `Target`、为什么 exec 通道自己有一个窄 seam）：
 * `docs/adr/0007-pi-runtime-seam.md`。
 *
 * ## 为什么内容不能走 argv
 *
 * `child_process.spawn` 在 Windows 上经由 CreateProcess，命令行上限 32,767
 * 字符。超过之后 Node **不会**发 'error' 事件——它从 `spawn()` **同步抛出**
 * ENAMETOOLONG，于是失败变成调用方的一个异常。
 *
 * 这不是假设：把每个随包扩展都 base64 进 ssh 命令行，argv 一度长到 35,367
 * 字符（pipi-approval-gate.ts 一个就 17.6KB，另外四个加起来才 ~12KB），于是
 * `syncKeyAuthExtensions` 每次 key-auth 远程连接都在 `tab:create` 的 IPC 处理
 * 里抛，**在** emitTabs()/emitActive() 之前。
 *
 * 因此契约是：**argv 只放那条短小、不含内容的命令（`sh -s`）；随内容增长的
 * 东西一律走 stdin**，stdin 没有这个上限。
 *
 * ## 契约
 * - **命令文本由调用方给**（POSIX 文本，由目标 shell 展开）；凭据、二进制与
 *   shell 方言由绑定方给。绑定发生在 index.ts / update-check 一侧。
 * - **不抛异常**：二进制缺失、连不上、超时、非零退出，全部以 `ok: false` +
 *   `error` 回来（一个失败不该把它的调用方一起带走）。同步抛出的 spawn 失败
 *   （上面的 ENAMETOOLONG）同样在这里被接住。
 */
import { spawn } from "node:child_process";

export interface RunOptions {
  /** 目标机上的命令。保持小且无内容——内容走 `stdin`。 */
  command: string;
  /** 喂给命令 stdin 的载荷（一段 shell 脚本、一个 tar…）。省略则关闭 stdin。 */
  stdin?: string;
  /** 默认 DEFAULT_COMMAND_TIMEOUT_MS；到点杀进程。 */
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  /** 退出码；进程从未起来或被超时杀掉时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 失败原因：`spawn failed: …` / `timeout` / `ssh not found` / `exit 1`。 */
  error?: string;
}

export type CommandRunner = (options: RunOptions) => Promise<RunResult>;

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** 抓到的输出超过这个长度就截断——远端可以无限刷 stdout。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

/** 一次 spawn 需要的全部东西。argv 的形状是绑定方的事（`sshArgv` /
 *  `wslArgv`）；这里只负责把它跑完并兑现上面的契约。 */
export interface SpawnSpec {
  bin: string;
  argv: string[];
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 二进制缺失时给用户的原因（`ssh not found` / `wsl not found`）。 */
  notFound: string;
}

/** 把输出收到上限为止的累加器。runCommand 与 ssh2 绑定共用（它们是同一条
 * 契约的两个实现），所以它是导出的。 */
export function createOutputCollector(max: number): { add(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let length = 0;
  return {
    add(chunk: Buffer): void {
      if (length >= max) return;
      const room = max - length;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      length += kept.length;
    },
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function describeSpawnError(error: unknown, notFound: string): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "ENOENT") return notFound;
    const message = error instanceof Error ? error.message : "";
    return `${code}${message ? `: ${message}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 跑一个子进程并把结果规约成 `RunResult`。永不 reject、永不抛——包括
 *  `spawn()` 同步抛出的那条路（ENAMETOOLONG，见模块头）。 */
export function runCommand(spec: SpawnSpec): Promise<RunResult> {
  const max = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdin = spec.stdin;

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.bin, spec.argv, {
        windowsHide: true,
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ ok: false, code: null, stdout: "", stderr: "", error: describeSpawnError(error, spec.notFound) });
      return;
    }

    const out = createOutputCollector(max);
    const err = createOutputCollector(max);
    child.stdout?.on("data", (chunk: Buffer) => out.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.add(chunk));

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      settle({ ok: false, code: null, stdout: out.text(), stderr: err.text(), error: "timeout" });
    }, spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

    child.on("error", (error: unknown) => {
      settle({ ok: false, code: null, stdout: "", stderr: "", error: describeSpawnError(error, spec.notFound) });
    });

    child.on("close", (code: number | null) => {
      settle({
        ok: code === 0,
        code,
        stdout: out.text(),
        stderr: err.text(),
        ...(code === 0 ? {} : { error: `exit ${code ?? "signal"}` }),
      });
    });

    if (stdin !== undefined && child.stdin) {
      // 远端提前退出（命令写错、链路断了）会重置管道，那个 EPIPE 不该以
      // 未处理错误的形式冒出来——这是尽力而为的写入。
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin, "utf8");
    }
  });
}
