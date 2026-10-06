/**
 * pi 漂移（Pi Drift）：应用配套的**契约版本**（bundled）与**实际会跑的那个
 * pi** 之间的关系。
 *
 * 漂移不是错误。决策 36 故意留了两条自由：本机全局 pi 可以 `pi update` 追 npm
 * 最新（终端里那个 `pi` 命令），远程/WSL 的 pi 则对齐契约版本（RPC 协议）。但在
 * 收成状态之前，这两条自由都塌成一个布尔 `hasUpdate`（「有新版本吗」）：
 * 「比契约新」与「比契约旧」在界面上长得一样，探测失败、「还没探测」与「装了跑
 * 不起来」也分不开。这里只做一件事 —— **给它们名字**（`docs/adr/0008`）。
 *
 * 纯模块：无 IO、无 Electron。主进程用它分类，渲染层用同一套词汇渲染
 * （`tsconfig.web.json` 收 `src/shared`）。状态**不缓存**：它是缓存事实（探测
 * 结果）的纯函数，缓存两份就会有两种真相。
 */
import { compareVersions } from "./version-compare";

/** 哪个 pi 真的会跑。`bundled` = 应用自带的（本机聊天 / `pi update` /
 *  `--list-models` 走它），`global` = 用户 PATH 上的（本机终端 TUI 走它），
 *  `remote` = 目标机（SSH / WSL）上的。 */
export type PiRuntime = "bundled" | "global" | "remote";

/** 漂移状态。「漂移」= 不是契约版本，但可能完全没问题（决策 36）。 */
export type PiDriftState =
  /** 就是契约版本。 */
  | "pinned"
  /** 比契约新：本机全局 pi 追了最新，或服务器自己升过。 */
  | "drifted-newer"
  /** 比契约旧：RPC 协议可能不匹配（远端对齐要修的正是这一种）。 */
  | "drifted-older"
  /** 明确没装（ENOENT / `command not found`）。 */
  | "absent"
  /** 装了，但跑不起来（本机全局 pi 缺依赖、服务器 Node 过旧…）。 */
  | "unrunnable"
  /** 契约版本读不到 / 探测超时 / 传输失败 / 在场但读不出版本：**不猜**。 */
  | "unknown";

/**
 * 一次「那个 pi 是哪个版本」的探测结果。读不到 ≠ 不存在（`content-sync` 的
 * `UNREADABLE` 是同一个约定）：`absent` 只给「明确不在」，超时与「没探测」是
 * `timeout` / `unverified`，装了跑不起来是 `unrunnable`，跑起来了但输出里没有
 * semver 是 `version: null`（在场但无名 → 分类为 `unknown`）。
 */
export type PiProbeOutcome =
  /** 跑起来了。`version: null` = 输出里没有 semver。 */
  | { kind: "version"; version: string | null }
  | { kind: "absent" }
  | { kind: "unrunnable"; detail?: string }
  | { kind: "timeout" }
  | { kind: "unverified" };

/** 漂移状态 + 说清它所需的全部事实（渲染层只读它，不再自己拼判定）。 */
export interface PiDrift {
  state: PiDriftState;
  runtime: PiRuntime;
  /** 应用配套的契约版本；`null` = 连契约都读不到（此时状态只能是 unknown）。 */
  bundled: string | null;
  /** 实测到的版本；`null` = 没拿到版本号。 */
  found: string | null;
  /** 给人看的失败细节（`unrunnable` 的诊断原文）。 */
  detail?: string;
}

export interface PiDriftFacts {
  bundled: string | null;
  runtime: PiRuntime;
  probe: PiProbeOutcome;
}

/** 纯分类：今天「契约 / 实测 / 探测结论」三者一算就能命名的那件事。 */
export function classifyPiDrift({ bundled, runtime, probe }: PiDriftFacts): PiDrift {
  const found = probe.kind === "version" ? probe.version : null;
  const base = { runtime, bundled, found };
  if (!bundled) return { ...base, state: "unknown" };
  switch (probe.kind) {
    case "version": {
      // 在场但读不出 semver：不猜（拿 "0.0.0" 去比会得出「比契约旧」这种假话）。
      if (!probe.version) return { ...base, state: "unknown" };
      const cmp = compareVersions(probe.version, bundled);
      return { ...base, state: cmp === 0 ? "pinned" : cmp > 0 ? "drifted-newer" : "drifted-older" };
    }
    case "absent":
      return { ...base, state: "absent" };
    case "unrunnable":
      return { ...base, state: "unrunnable", ...(probe.detail ? { detail: probe.detail } : {}) };
    case "timeout":
    case "unverified":
      return { ...base, state: "unknown" };
  }
}

/** 这个状态算不算「用户需要知道的一次失败」（硬规则 8）。
 *
 *  `drifted-*` **不算**：那是决策 36 允许的自由，报成失败就是把特性说成 bug。
 *  `absent` / `unrunnable` 算（有东西坏了）；`unknown` 不算（没探明不是失败，
 *  传输层失败由调用方按 `info.error` 另行留痕，避免同一件事记两遍）。 */
export function piDriftNeedsRecord(state: PiDriftState): boolean {
  return state === "absent" || state === "unrunnable";
}
