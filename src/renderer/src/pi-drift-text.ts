/**
 * 漂移状态 → 给用户看的一句话（ADR 0008）。
 *
 * 这里是漂移状态的**唯一**文案出口：全局横幅（`App.tsx`）与聊天页通知条
 * （`ChatPane.tsx`）原本各自抄了同一段三目表达式，现在都调 `updateBannerText`
 * —— 两处说同一件事，就不该有两份判定。纯函数（无 React、无 store），所以状态
 * 表可以直接单测。
 *
 * 「先状态、再原建议」：本机横幅先陈述事实（契约版本 vs 终端真正跑的那个 pi），
 * 之后**逐字保留**原来的升级建议（追 npm 最新是决策 36 的自由，不是错误）；
 * 远程横幅由状态驱动（对齐 = 把它换成契约版本）。
 */
import { piDriftNeedsRecord, type PiDrift } from "../../shared/pi-drift";
import type { UpdateNoticeInfo } from "./stores/uiStore";

/** 某个 pi 的状态叙述；`pinned`（就是契约版本）返回空串 —— 没事可说。 */
export function driftText(drift: PiDrift, label?: string): string {
  const detail = drift.detail ? `：${drift.detail}` : "";
  const base = `应用配套的 ${drift.bundled ?? "?"}`;
  if (drift.runtime === "remote") {
    const whom = label ? `${label} 的 pi` : "目标机上的 pi";
    switch (drift.state) {
      case "pinned":
        return "";
      case "drifted-newer":
        return `${whom} 是 ${drift.found}（比${base} 新，RPC 协议可能不匹配；更新会对齐回配套版本）`;
      case "drifted-older":
        return `${whom} 是 ${drift.found}（比${base} 旧，RPC 协议可能不匹配；更新会对齐到配套版本）`;
      case "absent":
        return `没有找到 ${whom}（未安装或不在 PATH）`;
      case "unrunnable":
        return `${whom} 跑不起来${detail}`;
      case "unknown":
        return `${whom} 版本未探明`;
    }
  }
  if (drift.runtime === "global") {
    // 本机终端 TUI 真正启动的那个 pi（用户自己 `pi update` 追的是它）。
    switch (drift.state) {
      case "pinned":
        return "";
      case "drifted-newer":
        return `终端用的全局 pi 是 ${drift.found}（比${base} 新，是你自己升级的；终端里跑的就是它）`;
      case "drifted-older":
        return `终端用的全局 pi 是 ${drift.found}（比${base} 旧，终端里跑的就是它）`;
      case "absent":
        return "本机没有全局 pi 命令（未安装或不在 PATH）";
      case "unrunnable":
        return `本机全局 pi 跑不起来${detail}`;
      case "unknown":
        return "本机全局 pi 的版本没探明";
    }
  }
  // 应用自带的那个 pi（本机聊天 / `pi update` / `--list-models` 走它）。
  switch (drift.state) {
    case "pinned":
      return "";
    case "drifted-newer":
    case "drifted-older":
      return `应用自带的 pi 是 ${drift.found}，与${base}不一致`;
    case "absent":
      return "应用自带的 pi 找不到（安装不完整）";
    case "unrunnable":
      return `应用自带的 pi 跑不起来${detail}`;
    case "unknown":
      return "应用自带 pi 的版本没探明";
  }
}

/** 原来的远程横幅文案（探不明状态时的退路）：一字不改。 */
function remoteFallback(info: UpdateNoticeInfo): string {
  return `${info.targetLabel} pi agent 版本（${info.current ?? "?"}）与应用配套版本（${info.latest ?? "?"}）不一致；更新将对齐版本并同步扩展包`;
}

/** 原来的本机横幅建议（逐字保留）：追 npm 最新是决策 36 的自由。 */
function localAdvice(info: UpdateNoticeInfo): string {
  if (info.latest) {
    return `pi agent 有新版本：${info.current ?? "?"} → ${info.latest}${info.extensions.length ? `；扩展包也有更新：${info.extensions.join("、")}` : ""}`;
  }
  return `pi 扩展包有更新：${info.extensions.join("、")}`;
}

/** 横幅那一行字：本机 = 先状态再原建议；远程 = 状态即文案。 */
export function updateBannerText(info: UpdateNoticeInfo): string {
  if (info.targetLabel) {
    return driftText(info.drift, info.targetLabel) || remoteFallback(info);
  }
  const lines = [info.drift, info.terminalDrift]
    .filter((d): d is PiDrift => !!d)
    .map((d) => driftText(d))
    .filter((t) => t.length > 0);
  const state = [...new Set(lines)].join("；");
  const advice = localAdvice(info);
  return state ? `${state}；${advice}` : advice;
}

/** 这次状态该不该进 FailureCenter（硬规则 8）。
 *
 *  漂移**不算**失败（决策 36 允许的自由）；「没装」「跑不起来」算。同一个状态
 *  在一次会话里只记一次，由调用方的 ref 保证（与远程探测失败的既有做法一致）。 */
export function driftRecordText(drift: PiDrift, label?: string): { text: string; cause: string } | null {
  if (!piDriftNeedsRecord(drift.state)) return null;
  const text = driftText(drift, label);
  return { text, cause: drift.detail ?? text };
}
