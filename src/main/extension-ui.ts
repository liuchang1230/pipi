/**
 * extension-ui.ts (main) — 扩展界面面的权威状态。
 *
 * 为什么权威状态住在主进程，而不是渲染层的 store：帧是**一次性的**
 * （`setStatus` / `setWidget` 是调用不是快照，`get_state` 不携带它们，pi 的 TUI
 * 也不会重发），而渲染层里接收它们的那一层（ChatView）会被卸载——tab 切到终端
 * 视图时、pi 还没起完时、开 tab 的首帧（它在渲染层知道这个 tab 存在**之前**就发出
 * 来了）都算。实测 `tab:create` 是先建后端再发 tab 列表的，所以首帧不是「可能丢」
 * 而是必丢。权威状态放在不会被卸载的这一层，快照就自然解掉这整类问题。
 *
 * 第二个理由：会话身份变更（new_session / fork / clone / …）全都是从渲染层经
 * `tab:rpc-send` 这一个漏斗发给 pi 的，而视图切换（chat ↔ 终端）也都在 index.ts
 * 的两个 handler 里。清理规则因此只需实现一次，两台后端共用。
 *
 * 与 main/rpc-session.ts 的 `setUiRequestHandler` 的关系：pi 的
 * `extension_ui_request` 帧先经这里看一眼（面的三条成员被这里消化掉，不再当成
 * 原始帧转发），其余（对话框 / notify / set_editor_text）照旧转发给渲染层。
 */
import { BrowserWindow } from "electron";
import {
  applySurfaceFrame,
  emptySurface,
  isSurfaceMethod,
  type ExtensionUiSurface,
} from "../shared/extension-ui";
import { debugLogDebug } from "./debug-log";

interface Entry {
  surface: ExtensionUiSurface;
  /** 每次变化 +1；渲染层用它丢弃迟到的快照。 */
  seq: number;
}

const surfaces = new Map<string, Entry>();

/** 一个 tab 的面 + 它的版本号。渲染层 attach 时拉一次，之后收增量。 */
export interface ExtensionUiState {
  seq: number;
  surface: ExtensionUiSurface;
}

export function getUiSurface(tabId: string): ExtensionUiState {
  const entry = surfaces.get(tabId);
  return entry ? { seq: entry.seq, surface: entry.surface } : { seq: 0, surface: emptySurface() };
}

function push(tabId: string, entry: Entry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(`tab:rpc-ui-state:${tabId}`, { seq: entry.seq, surface: entry.surface } satisfies ExtensionUiState);
  }
}

/**
 * 看一条到来的 UI 帧。返回 true 表示这是**面**的帧（已被这里消化，调用方不要
 * 再把它当原始帧转发给渲染层）；false 表示调用方照旧转发。
 */
export function observeUiRequest(tabId: string, req: Record<string, unknown>): boolean {
  if (!isSurfaceMethod(req.method)) return false;
  const prev = surfaces.get(tabId) ?? { surface: emptySurface(), seq: 0 };
  const next = applySurfaceFrame(prev.surface, req);
  if (!next) {
    // 面的方法但形状不合法（没有 key / 行不是字符串数组）。pi 上游不会发这种帧，
    // 但一条坏帧不该让整个面停摆，也不该让它冒充别的帧。
    debugLogDebug("extension-ui", `tab ${tabId} ignored malformed ${String(req.method)} frame`);
    return true;
  }
  if (next === prev.surface) return true; // 没有变化：不推送
  const entry: Entry = { surface: next, seq: prev.seq + 1 };
  surfaces.set(tabId, entry);
  push(tabId, entry);
  return true;
}

/**
 * 清掉一个 tab 的面：会话换了（new_session/fork/clone/…）、视图换了
 * （chat ↔ 终端：那是另一个 pi 进程，它的声明我们看不见）、或 pi 退了。
 * 新会话里的扩展会重新声明它需要的东西（pi 在 reload 后会给新 runner 发
 * session_start），所以清空不是丢状态，而是拒绝让上一个会话的声明冒充当前的。
 */
export function clearUiSurface(tabId: string, reason: string): void {
  const prev = surfaces.get(tabId);
  if (!prev) return;
  // 已经是空面：没啥可推的，但**不能删条目**——seq 必须保持单调。删掉它会让下一条
  // 声明从 seq 1 开始，而渲染层手上还攥着 seq 5，于是渲染层把那条真帧当迟到帧丢掉，
  // 新会话的 status/widget 再也不会出现（直到扩展恰好再改 5 次）。释放靠
  // forgetUiSurface（tab 关闭）。
  if (Object.keys(prev.surface.status).length === 0 && Object.keys(prev.surface.widgets).length === 0 && !prev.surface.title) return;
  debugLogDebug("extension-ui", `tab ${tabId} cleared (${reason})`);
  const entry: Entry = { surface: emptySurface(), seq: prev.seq + 1 };
  surfaces.set(tabId, entry);
  push(tabId, entry);
}

/** tab 没了：连版本号一起忘掉，免得同一个 tabId 复用（重开）时继承旧快照。 */
export function forgetUiSurface(tabId: string): void {
  surfaces.delete(tabId);
}
