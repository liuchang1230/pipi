/**
 * extension-ui.ts — pi 的「扩展界面面」的语义镜像，与 shared/transcript.ts 同类。
 *
 * 一个 pi 扩展通过 `ctx.ui` 声明的界面状态（`setStatus` / `setWidget` /
 * `setTitle`）在两种后端下到达我们：
 *   - 本地 tab：`pi` 的 SDK 跑在我们的 worker 里，worker 自己 post 帧；
 *   - WSL / 远程 tab：用户自己的 `pi --mode rpc` 子进程，它按上游 rpc 协议
 *     输出 `extension_ui_request`。
 * 两条路的字段名必须完全一致，否则同一条帧在一台后端有一半字段是 undefined，
 * 而帧是**一次性**的（pi 不会重发，`get_state` 也不携带它）——丢了就是永久丢。
 * 所以帧的形状放在 shared：两台后端的生产者与消费者共用一个类型，字段名错位
 * 变成编译错误，而不是运行时静默丢字段。
 *
 * 这里只放**判定**（什么算一条有效的声明、`undefined` 是什么意思、哪些成员我们
 * 明确不兑现），不放界面。渲染在 renderer，权威状态在 main。
 */

/**
 * `setWidget` 的落点。上游默认 `aboveEditor`（见 interactive-mode 的
 * `options?.placement ?? "aboveEditor"`），我们照抄默认值。
 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionUiWidget {
  /** 原始行，未经解析（widget 是纯文本行，不是 markdown）。 */
  lines: string[];
  /** 可缺省：上游的 `widgetPlacement` 就是可选参数，缺省值 `aboveEditor`
   *  由观看方套用（与 pi 的 `options?.placement ?? "aboveEditor"` 一致）。
   *  所以观看方不能假定它一定存在，否则 widget 会整块消失。 */
  placement?: WidgetPlacement;
}

/**
 * 一个 tab 的扩展界面面：扩展声明了什么，就是什么。没有声明的东西不存在
 * （而不是有默认值）——空面就是空面。
 */
export interface ExtensionUiSurface {
  /** statusKey → 文本，插入顺序即扩展的声明顺序。 */
  status: Record<string, string>;
  /** widgetKey → widget。key 跨落点唯一：同一个 key 换落点会替换掉旧的。 */
  widgets: Record<string, ExtensionUiWidget>;
  /** `setTitle` 的标题；空串表示没有标题。 */
  title: string;
}

/**
 * 我们真正会动手的「即发即忘」帧。对话框类（select/confirm/input/editor）
 * 归 UiDialog，不在这个类型里。
 *
 * 字段名与上游 `modes/rpc/rpc-types.d.ts` 的 `RpcExtensionUIRequest` 逐字一致：
 * `statusKey`/`statusText`、`widgetKey`/`widgetLines`/`widgetPlacement`、
 * `title`、`text`。**不要**改名（我们的 worker 曾经发 `widgetContent` 并把
 * placement 展平在顶层，于是本地 tab 的 widget 在远程被静默丢掉）。
 */
export type ExtensionUiFrame =
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: WidgetPlacement;
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** 对话框方法：渲染层把它们画成 `<UiDialog>` 并等 `extension_ui_response`。
 *  UiDialog 的消化判定读这里，不当第二份硬编码清单。 */
export const DIALOG_UI_METHODS = ["select", "confirm", "input", "editor"] as const;

export function isDialogUiMethod(method: unknown): boolean {
  return typeof method === "string" && (DIALOG_UI_METHODS as readonly string[]).includes(method);
}

/** 这些帧我们**会**处理（含对话框）：渲染层照做，绝不当成对话框去渲染。 */
export const HANDLED_UI_METHODS = [
  // 面（判定在 applySurfaceFrame）
  "setStatus",
  "setWidget",
  "setTitle",
  // 渲染层动作
  "set_editor_text",
  "notify",
  ...DIALOG_UI_METHODS,
] as const;

export function isHandledUiMethod(method: unknown): boolean {
  return typeof method === "string" && (HANDLED_UI_METHODS as readonly string[]).includes(method);
}

/**
 * 一条帧去掉信封（`type` / `id`）后的部分——生产者的**规格**。
 * `Omit` 不分配联合，所以这里是手工分配版：这样 `postUi(tabId, {...})` 的每个
 * 成员都会被编译期检查字段名（`widgetLines` 写成 `widgetContent` 就不再编译过）。
 */
export type ExtensionUiFrameSpec = ExtensionUiFrame extends infer F
  ? F extends ExtensionUiFrame
    ? Omit<F, "type" | "id">
    : never
  : never;

/** 面的方法（不改输入框、不弹窗、只改扩展声明的那块界面）。 */
export function isSurfaceMethod(method: unknown): boolean {
  return method === "setStatus" || method === "setWidget" || method === "setTitle";
}

export interface DegradedUiMember {
  /** `ExtensionUIContext` 上的成员名。 */
  name: string;
  /** 为什么兑现不了——写清楚，免得下次评审再提「把它也接上」。 */
  why: string;
}

/**
 * 降级成员：pi 的 `ExtensionUIContext` 上我们明确不兑现的成员。
 *
 * 前 9 个是**结构性**的——`pi --mode rpc` 自己就不传输它们（上游注释写着
 * "requires TUI loader access" / "requires TUI message rendering access"），
 * 而远程后端就是用户自己的 pi 二进制，我们无法从外部补上。
 * 后 3 个是**组件工厂**：把一个 TUI 组件工厂跨 JSON seam 送到另一台机器上的
 * 渲染层没有意义（它是个函数），我们能做的只是别假装收到了。
 * 记录在 docs/adr/0006-extension-ui-surface.md，并标在 pi-api-stub.d.ts。
 */
export const DEGRADED_UI_MEMBERS: readonly DegradedUiMember[] = [
  { name: "setWorkingMessage", why: "rpc 后端不传输（需 TUI loader 访问）" },
  { name: "setWorkingVisible", why: "rpc 后端不传输（需 TUI loader 访问）" },
  { name: "setWorkingIndicator", why: "rpc 后端不传输（需 TUI loader 访问）；chat view 里我们的转圈是 DOM，无闪烁可言" },
  { name: "setHiddenThinkingLabel", why: "rpc 后端不传输（需 TUI 消息渲染访问）" },
  { name: "setFooter", why: "rpc 后端不传输（需 TUI 访问）" },
  { name: "setHeader", why: "rpc 后端不传输（需 TUI 访问）" },
  { name: "custom", why: "rpc 后端不传输（需 TUI 访问）" },
  { name: "getEditorText", why: "rpc 后端返回空串（同步方法等不了 RPC 应答）" },
  { name: "onTerminalInput", why: "rpc 后端不传输（无原始终端输入）" },
  { name: "addAutocompleteProvider", why: "组件工厂：跨 JSON seam 送不过去" },
  { name: "setEditorComponent", why: "组件工厂：跨 JSON seam 送不过去" },
  { name: "getEditorComponent", why: "组件工厂：跨 JSON seam 送不过去" },
];

/**
 * `setWidget` 的行数上限，对齐 pi 自己的 TUI（`InteractiveMode.MAX_WIDGET_LINES
 * = 10`，超出时它渲染一行 "... (widget truncated)"）。我们用同一个上限，但
 * 不丢信息：多出来的行可以通过展开看到（见 extension-ui-view）。
 */
export const WIDGET_LINE_CAP = 10;

/**
 * 这些命令一旦发出，当前会话的身份就换了——扩展此前声明的一切都不再属于
 * 当前会话，必须清掉（`set_session_name` **不在**这里：改名是同一个会话，
 * 扩展的 status 应该留着）。
 *
 * 这六个命令都经过 main 的 `tab:rpc-send` 这**一个**漏斗，所以清理规则只需
 * 在那里实现一次，两台后端共用。
 */
/**
 * Commands after which pi has a NEW extension runner bound, so the previous
 * session's UI declarations are stale and only the new session can re-declare
 * them. Every entry is a command whose SDK path actually calls
 * `rebindSession` (sdk-worker.ts: `new_session`/`switch_session`/`fork`/
 * `clone`) or whose upstream emits `session_start` (`reload`,
 * agent-session.js:2237).
 *
 * `navigate_tree` is deliberately ABSENT: upstream `navigateTree` rebinds
 * nothing and emits only `session_tree` (agent-session.js:2617-2624), so the
 * extension runner that declared a widget is the same one still running.
 * Clearing here would delete a declaration pi still considers valid, and
 * nothing would ever re-send it (frames are one-shot) — while the remote
 * backend, which reaches the same `navigateTree` through the `/pipi-tree-nav`
 * prompt, never cleared, so local and remote tabs disagreed.
 */
export const SESSION_IDENTITY_COMMANDS: readonly string[] = [
  "new_session",
  "switch_session",
  "fork",
  "clone",
  "reload",
];

export function startsNewSessionIdentity(commandType: unknown): boolean {
  return typeof commandType === "string" && SESSION_IDENTITY_COMMANDS.includes(commandType);
}

export function emptySurface(): ExtensionUiSurface {
  return { status: {}, widgets: {}, title: "" };
}

function isWidgetPlacement(value: unknown): value is WidgetPlacement {
  return value === "aboveEditor" || value === "belowEditor";
}

/**
 * 把一条帧应用到面上，返回新的面。
 *
 * 返回 `null` 表示**这条帧不归面管**（不是面的方法，或形状不合法——例如没有
 * key，或 widget 的行不是字符串数组）。调用方据此决定是否推送。
 *
 * 返回**同一个对象**表示这条帧没有改变任何东西（例如删一个不存在的 key），
 * 调用方据此跳过推送。值语义：
 *   - `statusText === undefined` → 删除该 key；空串是「声明了但为空」，保留；
 *   - `widgetLines === undefined` → 删除该 key；`[]` 是「声明了但为空」，保留；
 *   - 同一个 widgetKey 换落点 → 替换（对齐 pi：它在两个 map 里都先按 key 删）。
 */
export function applySurfaceFrame(surface: ExtensionUiSurface, req: Record<string, unknown>): ExtensionUiSurface | null {
  switch (req.method) {
    case "setStatus": {
      const key = req.statusKey;
      if (typeof key !== "string" || !key) return null;
      const text = req.statusText;
      if (text !== undefined && typeof text !== "string") return null;
      if (text === undefined) {
        if (!(key in surface.status)) return surface;
        const status = { ...surface.status };
        delete status[key];
        return { ...surface, status };
      }
      if (surface.status[key] === text) return surface;
      return { ...surface, status: { ...surface.status, [key]: text } };
    }
    case "setWidget": {
      const key = req.widgetKey;
      if (typeof key !== "string" || !key) return null;
      const lines = req.widgetLines;
      if (lines !== undefined && (!Array.isArray(lines) || lines.some((line) => typeof line !== "string"))) return null;
      if (lines === undefined) {
        if (!(key in surface.widgets)) return surface;
        const widgets = { ...surface.widgets };
        delete widgets[key];
        return { ...surface, widgets };
      }
      const placement: WidgetPlacement = isWidgetPlacement(req.widgetPlacement) ? req.widgetPlacement : "aboveEditor";
      const existing = surface.widgets[key];
      if (existing && existing.placement === placement && sameLines(existing.lines, lines)) return surface;
      return { ...surface, widgets: { ...surface.widgets, [key]: { lines: [...lines], placement } } };
    }
    case "setTitle": {
      if (typeof req.title !== "string") return null;
      if (surface.title === req.title) return surface;
      return { ...surface, title: req.title };
    }
    default:
      return null;
  }
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
