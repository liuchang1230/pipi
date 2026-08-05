// Layout store: cross-pane geometry that both resizer directions write.
import { beforeEach, describe, expect, it } from "vitest";
import { useLayoutStore } from "../layoutStore";

beforeEach(() => {
  useLayoutStore.setState({ leftWidth: 260, rightWidth: 420, viewerCollapsed: false });
});

describe("layout store", () => {
  it("tracks the pane widths written by either resizer side", () => {
    useLayoutStore.getState().setLeftWidth(320);
    useLayoutStore.getState().setRightWidth(500);
    const s = useLayoutStore.getState();
    expect(s.leftWidth).toBe(320);
    expect(s.rightWidth).toBe(500);
  });

  it("toggleViewer flips the collapse flag (drives viewer + hydration-toast position)", () => {
    expect(useLayoutStore.getState().viewerCollapsed).toBe(false);
    useLayoutStore.getState().toggleViewer();
    expect(useLayoutStore.getState().viewerCollapsed).toBe(true);
    useLayoutStore.getState().toggleViewer();
    expect(useLayoutStore.getState().viewerCollapsed).toBe(false);
  });

  it("only notifies subscribers whose slice actually changed", () => {
    const seen: string[] = [];
    const unsub = useLayoutStore.subscribe((s, prev) => {
      if (s.rightWidth !== prev.rightWidth) seen.push("right");
      if (s.viewerCollapsed !== prev.viewerCollapsed) seen.push("collapsed");
    });
    useLayoutStore.getState().setRightWidth(600);
    expect(seen).toEqual(["right"]);
    useLayoutStore.getState().toggleViewer();
    expect(seen).toEqual(["right", "collapsed"]);
    unsub();
  });
});
