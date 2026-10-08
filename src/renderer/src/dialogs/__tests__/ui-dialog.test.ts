// The renderer's half of pi's fire-and-forget extension UI frames. The failure
// mode these tests pin: an unconsumed frame that is NOT a dialog would be
// rendered as an empty question (ChatPane renders <UiDialog> whenever
// handleFireAndForget returns false), and a surface frame that still arrives
// here means main's surface module let it through — it must not become a dialog.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../../stores/uiStore";
import { handleFireAndForget, type UiRequest } from "../UiDialog";

const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  useUiStore.setState({ toast: null });
  (globalThis as unknown as { window: unknown }).window = {
    api: { debug: { log: (msg: string) => logged.push(msg) } },
  };
});

const req = (patch: Partial<UiRequest>): UiRequest => ({ id: "1", method: "", ...patch });

describe("handleFireAndForget", () => {
  it("turns notify into a toast", () => {
    expect(handleFireAndForget(req({ method: "notify", message: "hi", notifyType: "error" }))).toBe(true);
    expect(useUiStore.getState().toast?.text).toBe("hi");
    expect(useUiStore.getState().toast?.type).toBe("err");
  });

  it("strips theme colour codes from a notify message (a toast is DOM text, not a terminal)", () => {
    handleFireAndForget(req({ method: "notify", message: "\u001b[38;5;244m已保存\u001b[39m" }));
    expect(useUiStore.getState().toast?.text).toBe("已保存");
  });

  it("hands set_editor_text to the caller and consumes it", () => {
    const setText = vi.fn();
    expect(handleFireAndForget(req({ method: "set_editor_text", text: "draft" }), setText)).toBe(true);
    expect(setText).toHaveBeenCalledWith("draft");
    expect(logged).toEqual([]);
  });

  it("does not invent text for a set_editor_text without one", () => {
    const setText = vi.fn();
    expect(handleFireAndForget(req({ method: "set_editor_text" }), setText)).toBe(true);
    expect(setText).not.toHaveBeenCalled();
  });

  it("leaves the four dialog methods to ChatPane", () => {
    for (const method of ["select", "confirm", "input", "editor"]) {
      expect(handleFireAndForget(req({ method }))).toBe(false);
    }
    expect(logged).toEqual([]);
  });

  it("consumes and logs an unknown method instead of rendering an empty dialog", () => {
    expect(handleFireAndForget(req({ method: "setSomethingFromAFuturePi" }))).toBe(true);
    expect(logged[0]).toContain("setSomethingFromAFuturePi");
  });

  it("consumes a surface frame that should have been absorbed by main", () => {
    expect(handleFireAndForget(req({ method: "setWidget" }))).toBe(true);
    expect(logged[0]).toContain("setWidget");
  });
});
