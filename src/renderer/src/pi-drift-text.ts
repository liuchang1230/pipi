/**
 * 目标机 pi 的漂移状态 → 给用户看的一句话（ADR 0008 / 0009）。
 *
 * 这里是漂移状态的**唯一**文案出口：全局横幅（`App.tsx`）与聊天页通知条
 * （`ChatPane.tsx`）原本各自抄了同一段三目表达式，现在都调 `updateBannerText`
 * —— 两处说同一件事，就不该有两份判定。纯函数（无 React、无 store），所以状态
 * 表可以直接单测。
 *
 * 只有「目标机对齐」用得上它：本机的升级提示在 ADR 0009 全部删掉了（app 不再追
 * npm 最新、也不再提示用户升级自己那份 pi）；本机 pi 坏掉走另一条路——`local-pi`
 * 的 `PiPresence` 说清是「没装」还是「装了跑不起来」，并进失败中心。
 *
 * 措辞三件事：它是什么版本、为什么这事要紧（RPC 协议）、按下去会发生什么
 * （对齐回配套版本）。
 */
import type { PiDrift } from "../../shared/pi-drift";
import type { UpdateNoticeInfo } from "./stores/uiStore";

/** 目标机 pi 的状态叙述；`pinned`（就是契约版本）返回空串 —— 没事可说。 */
export function driftText(drift: PiDrift, label?: string): string {
  const detail = drift.detail ? `：${drift.detail}` : "";
  const whom = label ? `${label} 的 pi` : "目标机上的 pi";
  const base = `应用配套的 ${drift.bundled ?? "?"}`;
  switch (drift.state) {
    case "pinned":
      return "";
    case "drifted-newer":
      return `${whom} 是 ${drift.found}（比${base} 新，RPC 协议可能不匹配；对齐会把它装回配套版本）`;
    case "drifted-older":
      return `${whom} 是 ${drift.found}（比${base} 旧，RPC 协议可能不匹配；对齐会把它装到配套版本）`;
    case "absent":
      return `没有找到 ${whom}（未安装或不在 PATH）`;
    case "unrunnable":
      return `${whom} 跑不起来${detail}`;
    case "unknown":
      return `${whom} 版本未探明`;
  }
}

/** 横幅那一行字：目标机 = 状态即文案（没有「本机建议」这回事了）。
 *
 *  兜底那句只防「状态说不出话却还摆着按钮」：调用方只在实测版本 ≠ 契约版本时
 *  设 `updateInfo`，那时状态必然是 `drifted-*`，所以今天到不了这里。 */
export function updateBannerText(info: UpdateNoticeInfo): string {
  return driftText(info.drift, info.targetLabel)
    || `${info.targetLabel ?? "目标机"} 上的 pi 与配套版本（${info.drift.bundled ?? "?"}）不一致；对齐会把它装回配套版本`;
}
