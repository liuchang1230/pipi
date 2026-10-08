// extension-ui: pi 的扩展界面面的语义。重点有三条——帧是一次性的（所以判定必须
// 精确到字段）、`undefined` 和空值是两件事、以及哪些成员我们根本不兑现（说清楚
// 比假装收到强）。
import { describe, expect, it } from "vitest";
import {
  DEGRADED_UI_MEMBERS,
  DIALOG_UI_METHODS,
  HANDLED_UI_METHODS,
  SESSION_IDENTITY_COMMANDS,
  WIDGET_LINE_CAP,
  applySurfaceFrame,
  emptySurface,
  isDialogUiMethod,
  isHandledUiMethod,
  isSurfaceMethod,
  startsNewSessionIdentity,
} from "../extension-ui";

const frame = (o: Record<string, unknown>): Record<string, unknown> => ({ type: "extension_ui_request", id: "r1", ...o });

describe("applySurfaceFrame — setStatus", () => {
  it("declares a status and keeps declaration order", () => {
    let surface = emptySurface();
    surface = applySurfaceFrame(surface, frame({ method: "setStatus", statusKey: "b", statusText: "二" }))!;
    surface = applySurfaceFrame(surface, frame({ method: "setStatus", statusKey: "a", statusText: "一" }))!;
    expect(Object.keys(surface.status)).toEqual(["b", "a"]);
    expect(surface.status).toEqual({ b: "二", a: "一" });
  });

  it("treats undefined as removal but empty string as a declared (empty) value", () => {
    let surface = applySurfaceFrame(emptySurface(), frame({ method: "setStatus", statusKey: "k", statusText: "x" }))!;
    surface = applySurfaceFrame(surface, frame({ method: "setStatus", statusKey: "k", statusText: "" }))!;
    expect(surface.status).toEqual({ k: "" });
    surface = applySurfaceFrame(surface, frame({ method: "setStatus", statusKey: "k", statusText: undefined }))!;
    expect(surface.status).toEqual({});
  });

  it("returns the same surface object when nothing changed, so callers can skip the push", () => {
    const surface = applySurfaceFrame(emptySurface(), frame({ method: "setStatus", statusKey: "k", statusText: "x" }))!;
    expect(applySurfaceFrame(surface, frame({ method: "setStatus", statusKey: "k", statusText: "x" }))).toBe(surface);
    expect(applySurfaceFrame(surface, frame({ method: "setStatus", statusKey: "gone", statusText: undefined }))).toBe(surface);
  });

  it("rejects a frame without a key or with a non-string text", () => {
    expect(applySurfaceFrame(emptySurface(), frame({ method: "setStatus", statusText: "x" }))).toBeNull();
    expect(applySurfaceFrame(emptySurface(), frame({ method: "setStatus", statusKey: "", statusText: "x" }))).toBeNull();
    expect(applySurfaceFrame(emptySurface(), frame({ method: "setStatus", statusKey: "k", statusText: 7 }))).toBeNull();
  });
});

describe("applySurfaceFrame — setWidget", () => {
  it("defaults the placement to aboveEditor, like pi's TUI", () => {
    const surface = applySurfaceFrame(emptySurface(), frame({ method: "setWidget", widgetKey: "w", widgetLines: ["a"] }))!;
    expect(surface.widgets.w).toEqual({ lines: ["a"], placement: "aboveEditor" });
  });

  it("replaces a widget whose key moved to the other placement (pi removes from both maps)", () => {
    let surface = applySurfaceFrame(emptySurface(), frame({ method: "setWidget", widgetKey: "w", widgetLines: ["a"] }))!;
    surface = applySurfaceFrame(
      surface,
      frame({ method: "setWidget", widgetKey: "w", widgetLines: ["b"], widgetPlacement: "belowEditor" }),
    )!;
    expect(surface.widgets.w).toEqual({ lines: ["b"], placement: "belowEditor" });
    expect(Object.keys(surface.widgets)).toEqual(["w"]);
  });

  it("treats undefined as removal and an empty array as a declared (empty) widget", () => {
    let surface = applySurfaceFrame(emptySurface(), frame({ method: "setWidget", widgetKey: "w", widgetLines: ["a"] }))!;
    surface = applySurfaceFrame(surface, frame({ method: "setWidget", widgetKey: "w", widgetLines: [] }))!;
    expect(surface.widgets.w).toEqual({ lines: [], placement: "aboveEditor" });
    surface = applySurfaceFrame(surface, frame({ method: "setWidget", widgetKey: "w", widgetLines: undefined }))!;
    expect(surface.widgets).toEqual({});
  });

  it("ignores a component factory's content shape instead of inventing lines", () => {
    // 组件工厂过不了 JSON seam：内容不是字符串数组时不该被当成行。
    expect(applySurfaceFrame(emptySurface(), frame({ method: "setWidget", widgetKey: "w", widgetLines: "text" }))).toBeNull();
    expect(applySurfaceFrame(emptySurface(), frame({ method: "setWidget", widgetKey: "w", widgetLines: [1, 2] }))).toBeNull();
    expect(applySurfaceFrame(emptySurface(), frame({ method: "setWidget", widgetLines: ["a"] }))).toBeNull();
  });
});

describe("applySurfaceFrame — setTitle and foreign frames", () => {
  it("sets and clears the title", () => {
    let surface = applySurfaceFrame(emptySurface(), frame({ method: "setTitle", title: "构建中" }))!;
    expect(surface.title).toBe("构建中");
    surface = applySurfaceFrame(surface, frame({ method: "setTitle", title: "" }))!;
    expect(surface.title).toBe("");
  });

  it("leaves the surface alone for frames that are not its business", () => {
    // 输入框、通知、对话框都不是「面」的一部分：面不该因此改变。
    for (const req of [
      frame({ method: "set_editor_text", text: "hi" }),
      frame({ method: "notify", message: "hi" }),
      frame({ method: "confirm", title: "?", message: "?" }),
      frame({ method: "setFooter", footer: () => {} }),
    ]) {
      expect(applySurfaceFrame(emptySurface(), req)).toBeNull();
    }
  });
});

describe("method lists", () => {
  it("accepts the four surface/editor members pi actually transports, plus dialogs and notify", () => {
    for (const m of ["setStatus", "setWidget", "setTitle", "set_editor_text", "notify", "select", "confirm", "input", "editor"]) {
      expect(isHandledUiMethod(m), m).toBe(true);
    }
    expect(isSurfaceMethod("set_editor_text")).toBe(false);
    expect(isSurfaceMethod("setStatus")).toBe(true);
  });

  it("separates the dialogs from the rest — that gap IS the consume-vs-render decision", () => {
    // UiDialog consumes everything except these four, so a method listed here
    // wrongly would render an empty question; one missing would hang silently.
    for (const m of DIALOG_UI_METHODS) expect(isDialogUiMethod(m)).toBe(true);
    for (const m of ["notify", "set_editor_text", "setStatus", "setWidget", "setTitle", "setSomethingNewInPi", undefined]) {
      expect(isDialogUiMethod(m), String(m)).toBe(false);
    }
    for (const m of DIALOG_UI_METHODS) expect(isHandledUiMethod(m)).toBe(true);
  });

  it("reports an unknown (future) pi method as unhandled, so the caller logs instead of dialog-izing it", () => {
    expect(isHandledUiMethod("setSomethingNewInPi")).toBe(false);
    expect(isHandledUiMethod(undefined)).toBe(false);
  });

  it("never lists a handled method as degraded, and every degraded member says why", () => {
    const degraded = DEGRADED_UI_MEMBERS.map((m) => m.name);
    for (const handled of HANDLED_UI_METHODS) expect(degraded).not.toContain(handled);
    for (const member of DEGRADED_UI_MEMBERS) expect(member.why.length).toBeGreaterThan(8);
    // setWorkingIndicator 在列（rpc 后端不传输）——我们不为它造一个私有通道。
    expect(degraded).toContain("setWorkingIndicator");
  });
});

describe("session identity", () => {
  it("clears exactly on the commands that rebind pi's extension runner, no more", () => {
    // Contents pinned on purpose: the list is the whole contract, and an
    // iteration-only test cannot notice a member wrongly added (that is how
    // navigate_tree got in and silently deleted live declarations).
    expect([...SESSION_IDENTITY_COMMANDS].sort()).toEqual(
      ["clone", "fork", "new_session", "reload", "switch_session"],
    );
    for (const type of SESSION_IDENTITY_COMMANDS) expect(startsNewSessionIdentity(type)).toBe(true);
  });

  it("does not clear on navigate_tree — upstream rebinds nothing (agent-session.js:2617)", () => {
    // A tree jump keeps the same session file and the same bound extension
    // runner, so a cleared widget would never come back (frames are one-shot).
    expect(startsNewSessionIdentity("navigate_tree")).toBe(false);
  });

  it("does not clear on a rename — same session, the extension's status is still true", () => {
    expect(startsNewSessionIdentity("set_session_name")).toBe(false);
    expect(startsNewSessionIdentity("prompt")).toBe(false);
    expect(startsNewSessionIdentity(undefined)).toBe(false);
  });

  it("keeps the widget cap identical to pi's own TUI limit", () => {
    expect(WIDGET_LINE_CAP).toBe(10);
  });
});
