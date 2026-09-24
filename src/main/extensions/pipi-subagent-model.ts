/**
 * pipi 随 app 分发的扩展：让子代理（analyst / reviewer / scout）用「当前会话的模型」。
 *
 * 为什么必须有它：pi 从不把 PI_MODEL/PI_PROVIDER 写进自己的进程 env ——
 * `dist/core/tools/bash.js` 只为 bash 子进程**新建一份** env（先 delete 再从
 * `ctx.model` 填）。而 pi 的委派代理扩展（analyst/index.ts）起子代理时读的正是
 * **自己进程的** `process.env.PI_MODEL`，所以那个值是「pi 启动时 app 注入了什么」
 * 就永远是什么：会话里用 /model 或 Ctrl+P 换了模型，子代理**不会**跟着换，落回
 * pi 的默认模型（settings.json 的 defaultModel）—— 与用户当前选的模型不一致。
 *
 * 这里用 pi 的事件把它补上：`model_select` 在 /model、Ctrl+P 循环、会话恢复时触发
 * （docs/extensions.md「model_select」），拿到 event.model.provider/id 写回进程 env，
 * 于是**任何**读 env 起子代理的扩展都会跟随当前会话模型（包括我们没在维护的）。
 *
 * 例外：用户在 pipi 的「子代理模型」里显式指定了模型时，app 会注入
 * `PIPI_SUBAGENT_MODEL_PINNED=1`，此时本扩展不覆盖用户的选择（显式优先）。
 *
 * 该文件由主进程启动时写入 ~/.pi/agent/extensions/（见 extension-sync.ts），
 * 并同步到 WSL/远程的 agent 目录。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** app 用它在子代理模型被显式指定时锁住本次注入。 */
export const PINNED_ENV = "PIPI_SUBAGENT_MODEL_PINNED";

export interface SelectedModel {
  provider?: string;
  id?: string;
}

/**
 * 把当前会话模型写进 pi 进程 env。返回是否写入。
 *
 * 纯函数（env 可注入，便于单测）；**只在值确实变化时赋值**，避免每次
 * turn 都动 env（也让"没变化"与"没生效"在测试里可区分）。
 */
export function syncSubagentModelEnv(
  model: SelectedModel | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!model?.id) return false;
  if (env[PINNED_ENV]) return false;
  let changed = false;
  if (env.PI_MODEL !== model.id) {
    env.PI_MODEL = model.id;
    changed = true;
  }
  if (model.provider && env.PI_PROVIDER !== model.provider) {
    env.PI_PROVIDER = model.provider;
    changed = true;
  }
  return changed;
}

export default function (pi: ExtensionAPI) {
  const apply = (event: unknown): void => {
    const model = (event as { model?: SelectedModel } | undefined)?.model;
    try {
      syncSubagentModelEnv(model);
    } catch {
      // 一个扩展绝不能因为同步 env 失败而打断模型切换
    }
  };

  // 主路径：/model、Ctrl+P 循环、会话恢复（恢复时模型可能与 pi 默认不同）。
  pi.on("model_select", async (event) => apply(event));
  // 兜底：pi 在会话启动时也会走一次模型选择；若某些版本不带 model 载荷则无副作用。
  pi.on("session_start", async (event) => apply(event));
}
