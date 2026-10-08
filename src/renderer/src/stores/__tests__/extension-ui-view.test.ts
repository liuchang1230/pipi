// The renderer's view rules for pi's extension UI surface. These are the
// decisions a user can be wronged by: a status that vanishes instead of showing
// empty, widget lines silently dropped, an ordering that re-sorts itself, a
// title drawn when the extension declared none.
import { describe, expect, it } from "vitest";
import { WIDGET_LINE_CAP, emptySurface, type ExtensionUiSurface } from "../../../../shared/extension-ui";
import { STATUS_TEXT_MAX, WIDGET_REST_MAX, editorTextAction, statusEntries, titleOf, widgetView, widgetViews } from "../extension-ui-view";

function surface(patch: Partial<ExtensionUiSurface>): ExtensionUiSurface {
  return { ...emptySurface(), ...patch };
}

describe("statusEntries", () => {
  it("keeps the extension's declaration order", () => {
    const s = surface({ status: { ctx: "42%", queue: "2 queued", branch: "main" } });
    expect(statusEntries(s).map((e) => e.key)).toEqual(["ctx", "queue", "branch"]);
  });

  it("skips a status declared as empty text (an extension's way of clearing it)", () => {
    const s = surface({ status: { ctx: "42%", queue: "  " } });
    expect(statusEntries(s).map((e) => e.key)).toEqual(["ctx"]);
  });

  it("clips a long status but keeps the full text for the tooltip", () => {
    const long = "x".repeat(STATUS_TEXT_MAX + 20);
    const [entry] = statusEntries(surface({ status: { note: long } }));
    expect(entry.text.length).toBe(STATUS_TEXT_MAX);
    expect(entry.text.endsWith("…")).toBe(true);
    expect(entry.full).toBe(long);
  });

  it("collapses newlines so one status cannot stretch the row", () => {
    const [entry] = statusEntries(surface({ status: { note: "a\nb" } }));
    expect(entry.text).toBe("a b");
  });

  it("strips the theme's colour codes — an extension writes for the TUI, not for a DOM", () => {
    // 用户报的原字符串：输入框上方显示 [38;5;241m◆ [39m[38;5;244m3 checkpoints[39m
    const ESC = "\u001b";
    const raw = `${ESC}[38;5;241m◆ ${ESC}[39m${ESC}[38;5;244m3 checkpoints${ESC}[39m`;
    const [entry] = statusEntries(surface({ status: { rewind: raw } }));
    expect(entry.text).toBe("◆ 3 checkpoints");
    expect(entry.full).toBe("◆ 3 checkpoints"); // tooltip 也不能带转义码
  });

  it("treats a status that is nothing but colour codes as empty", () => {
    const ESC = "\u001b";
    expect(statusEntries(surface({ status: { ctx: `${ESC}[2m${ESC}[22m` } }))).toEqual([]);
  });
});

describe("widgetViews", () => {
  it("separates placements and defaults to aboveEditor", () => {
    const s = surface({
      widgets: {
        a: { lines: ["above"], placement: "aboveEditor" },
        b: { lines: ["below"], placement: "belowEditor" },
        c: { lines: ["default"] },
      },
    });
    expect(widgetViews(s, "aboveEditor").map((w) => w.key)).toEqual(["a", "c"]);
    expect(widgetViews(s, "belowEditor").map((w) => w.key)).toEqual(["b"]);
  });

  it("draws no widget for a declared-but-empty one", () => {
    const s = surface({ widgets: { a: { lines: [], placement: "aboveEditor" } } });
    expect(widgetViews(s, "aboveEditor")).toEqual([]);
  });

  it("caps the drawn lines and keeps the rest expandable", () => {
    const lines = Array.from({ length: WIDGET_LINE_CAP + 3 }, (_, i) => `L${i}`);
    const view = widgetView("w", { lines, placement: "aboveEditor" });
    expect(view?.lines).toHaveLength(WIDGET_LINE_CAP);
    expect(view?.rest).toEqual(["L10", "L11", "L12"]);
  });

  it("has nothing to expand when the widget fits under the cap", () => {
    expect(widgetView("w", { lines: ["one"], placement: "aboveEditor" })?.rest).toEqual([]);
  });

  it("bounds what an expand can put in the DOM, and says how much it held back", () => {
    // A widget comes from code we did not write: one bad loop must not become
    // thousands of DOM nodes, and the truncation must be visible.
    const total = WIDGET_LINE_CAP + WIDGET_REST_MAX + 7;
    const lines = Array.from({ length: total }, (_, i) => `L${i}`);
    const view = widgetView("w", { lines, placement: "aboveEditor" });
    expect(view?.rest).toHaveLength(WIDGET_REST_MAX);
    expect(view?.hidden).toBe(7);
    expect(view!.lines.length + view!.rest.length + view!.hidden).toBe(total);
  });

  it("reports nothing hidden for a widget that fits", () => {
    const lines = Array.from({ length: WIDGET_LINE_CAP + 2 }, (_, i) => `L${i}`);
    expect(widgetView("w", { lines, placement: "aboveEditor" })?.hidden).toBe(0);
  });

  it("strips colour codes from widget lines without changing how many lines there are", () => {
    const lines = ["\u001b[1mhead\u001b[0m", "body"];
    const view = widgetView("w", { lines, placement: "aboveEditor" });
    expect(view?.lines).toEqual(["head", "body"]);
    expect(view?.rest).toEqual([]);
  });
});

describe("editorTextAction", () => {
  it("fills an empty composer", () => {
    expect(editorTextAction("", "draft from extension")).toEqual({ kind: "fill", text: "draft from extension" });
    expect(editorTextAction("   \n ", "x")).toEqual({ kind: "fill", text: "x" });
  });

  it("never destroys a draft the user is typing", () => {
    expect(editorTextAction("half a thought", "x")).toEqual({ kind: "hint", text: "x" });
  });

  it("ignores an empty offer (pi may send set_editor_text with no text)", () => {
    expect(editorTextAction("", "")).toBeNull();
    expect(editorTextAction("a draft", "")).toBeNull();
  });
});

describe("titleOf", () => {
  it("is null when no extension declared one (the header slot stays empty)", () => {
    expect(titleOf(emptySurface())).toBeNull();
    expect(titleOf(surface({ title: "   " }))).toBeNull();
  });

  it("returns the declared title", () => {
    expect(titleOf(surface({ title: "checkpoint 3" }))).toBe("checkpoint 3");
  });

  it("strips colour codes from a title (it lands in the chat header as plain text)", () => {
    expect(titleOf(surface({ title: "\u001b[2mcheckpoint 3\u001b[0m" }))).toBe("checkpoint 3");
    expect(titleOf(surface({ title: "\u001b[2m\u001b[0m" }))).toBeNull();
  });
});
