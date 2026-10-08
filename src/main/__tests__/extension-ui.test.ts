// The authoritative extension-UI surface (main side).
//
// Why this state exists at all is a timing fact, not a preference: a tab's
// backend is built before the renderer is told the tab exists, so the first
// setStatus frame is sent while nobody can receive it, and pi never re-sends a
// frame. These tests pin the properties that make the mirror correct:
// monotonic seq (the renderer drops late snapshots with it), and honest
// consumption of surface frames so they cannot fall through to the dialog path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DEGRADED_UI_MEMBERS } from "../../shared/extension-ui";

const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
  },
}));
vi.mock("../debug-log", () => ({ debugLog: () => {}, debugLogDebug: () => {} }));

const { clearUiSurface, forgetUiSurface, getUiSurface, observeUiRequest } = await import("../extension-ui");

const statusFrame = (key: string, text: string | undefined) => ({ method: "setStatus", statusKey: key, statusText: text });

beforeEach(() => {
  sent.length = 0;
  forgetUiSurface("t1");
});

describe("observeUiRequest", () => {
  it("consumes the three surface methods and forwards nothing itself", () => {
    expect(observeUiRequest("t1", statusFrame("ctx", "42%"))).toBe(true);
    expect(observeUiRequest("t1", { method: "setTitle", title: "cp3" })).toBe(true);
    expect(observeUiRequest("t1", { method: "setWidget", widgetKey: "w", widgetLines: ["a"] })).toBe(true);
    expect(getUiSurface("t1").surface.title).toBe("cp3");
  });

  it("lets dialogs / notify / set_editor_text through to the renderer", () => {
    expect(observeUiRequest("t1", { method: "select", title: "pick" })).toBe(false);
    expect(observeUiRequest("t1", { method: "notify", message: "hi" })).toBe(false);
    expect(observeUiRequest("t1", { method: "set_editor_text", text: "draft" })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("consumes a malformed surface frame instead of letting it pose as something else", () => {
    expect(observeUiRequest("t1", { method: "setStatus" })).toBe(true);
    expect(observeUiRequest("t1", { method: "setWidget", widgetKey: "w", widgetLines: [1, 2] })).toBe(true);
    expect(sent).toEqual([]);
    expect(getUiSurface("t1").seq).toBe(0);
  });

  it("pushes only real changes (a delete of nothing is not a change)", () => {
    observeUiRequest("t1", statusFrame("ctx", "42%"));
    expect(sent).toHaveLength(1);
    observeUiRequest("t1", statusFrame("ctx", "42%"));
    expect(sent).toHaveLength(1);
    observeUiRequest("t1", statusFrame("nope", undefined));
    expect(sent).toHaveLength(1);
  });

  it("keeps seq monotonic across a clear, so a late snapshot is the only thing dropped", () => {
    observeUiRequest("t1", statusFrame("ctx", "42%"));
    observeUiRequest("t1", statusFrame("ctx", "50%"));
    expect(getUiSurface("t1").seq).toBe(2);
    clearUiSurface("t1", "view switch");
    expect(getUiSurface("t1").seq).toBe(3);
    expect(getUiSurface("t1").surface.status).toEqual({});
    observeUiRequest("t1", statusFrame("ctx", "60%"));
    const last = sent.at(-1)?.payload as { seq: number };
    expect(last.seq).toBe(4);
  });

  it("does not rewind seq when it clears an already-empty surface", () => {
    observeUiRequest("t1", statusFrame("ctx", "42%"));
    observeUiRequest("t1", statusFrame("ctx", undefined)); // extension cleared it itself
    const seqAfterClear = getUiSurface("t1").seq;
    expect(seqAfterClear).toBe(2);
    sent.length = 0;
    clearUiSurface("t1", "view switch"); // nothing to push
    expect(sent).toEqual([]);
    expect(getUiSurface("t1").seq).toBe(seqAfterClear);
    observeUiRequest("t1", statusFrame("ctx", "70%"));
    expect((sent.at(-1)?.payload as { seq: number }).seq).toBe(seqAfterClear + 1);
  });

  it("is per tab", () => {
    observeUiRequest("t1", { method: "setTitle", title: "one" });
    observeUiRequest("t2", { method: "setTitle", title: "two" });
    expect(getUiSurface("t1").surface.title).toBe("one");
    expect(getUiSurface("t2").surface.title).toBe("two");
    clearUiSurface("t2", "pi exited");
    expect(getUiSurface("t1").surface.title).toBe("one");
    expect(getUiSurface("t2").surface.title).toBe("");
    forgetUiSurface("t2");
  });

  it("forgets a closed tab completely (a reused tab id starts fresh)", () => {
    observeUiRequest("t1", { method: "setTitle", title: "one" });
    forgetUiSurface("t1");
    expect(getUiSurface("t1")).toEqual({ seq: 0, surface: { status: {}, widgets: {}, title: "" } });
  });
});

// The worker's UI context is a hand-written copy of upstream's
// `createExtensionUIContext` (rpc-mode.js), and upstream does NOT fill in the
// members we omit: `ExtensionRunner.setUIContext` only spreads our object over
// its own prompt wrappers (runner.js:270-282), so a missing member makes
// `ctx.ui.X()` THROW inside the extension callback — and because the runner
// catches per handler, the rest of that handler (an innocent `setStatus` two
// lines down) never runs. Local tabs broke that way while remote tabs stayed
// quiet: `setFooter` / `setHeader` were on the degraded list but absent from
// the object. A source-level check is the only way to catch this class without
// booting a worker (which needs pi's whole dist + a parent port).
describe("the SDK worker's UI context covers the degraded list", () => {
  const workerSource = readFileSync(new URL("../chat-backend/sdk-worker.ts", import.meta.url), "utf8");
  const contextSource = workerSource.slice(workerSource.indexOf("function createExtensionUIContext"));
  /** The returned object literal, brace-matched — slicing at the first "\n  };"
   *  would stop inside the `degraded` helper above it (which ends that way) and
   *  silently check an empty body. */
  const returnedObject = (() => {
    const start = contextSource.indexOf("return {") + "return {".length - 1;
    let depth = 0;
    for (let i = start; i < contextSource.length; i++) {
      if (contextSource[i] === "{") depth++;
      else if (contextSource[i] === "}" && --depth === 0) return contextSource.slice(start, i + 1);
    }
    throw new Error("unbalanced braces in createExtensionUIContext");
  })();

  it("defines every member it claims to degrade (absent ≠ no-op: absent throws)", () => {
    const missing = DEGRADED_UI_MEMBERS.map((m) => m.name).filter(
      (name) => !new RegExp(`(^|\\s)${name}\\s*[:,]`, "m").test(returnedObject),
    );
    expect(missing).toEqual([]);
  });

  it("carries the upstream field names for the four members it does transport", () => {
    // The wire names, not the JS member names: `widgetContent` (our old spelling)
    // arrived at the remote backend as an unknown key and was dropped silently.
    for (const wire of ['method: "setStatus"', 'method: "setWidget"', 'method: "setTitle"', 'method: "set_editor_text"']) {
      expect(contextSource).toContain(wire);
    }
    expect(contextSource).toContain("widgetLines: lines, widgetPlacement: options?.placement");
  });
});
