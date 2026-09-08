// pipi-model-sync extension source — static contract tests. The file ships
// verbatim to local/WSL/remote agent dirs (extension-sync.ts), so the
// behavioral guarantees that the chat model-menu hot-sync depends on must
// hold in the SOURCE TEXT: it registers the exact command name the main
// process looks up, refreshes the model registry offline, and awaits ctx.ui
// notifications (unawaited notify crashes pi's RPC mode — the dialog promise
// rejects with "Request already answered" on quit).
import { describe, expect, it } from "vitest";
import { SHIPPED_EXTENSIONS } from "../extension-sync";

const source = SHIPPED_EXTENSIONS.find((e) => e.fileName === "pipi-model-sync.ts");

describe("pipi-model-sync shipped source", () => {
  it("ships with the app", () => {
    expect(source).toBeDefined();
    expect(source!.content.length).toBeGreaterThan(0);
  });

  it("registers the command name main looks up in get_commands", () => {
    expect(source!.content).toContain('pi.registerCommand("pipi-model-sync"');
  });

  it("refreshes the model registry offline (no network on the sync path)", () => {
    expect(source!.content).toContain("ctx.modelRegistry.refresh({ allowNetwork: false })");
  });

  it("awaits ctx.ui.notify so the RPC dialog promise is not dropped", () => {
    // Every notify call must be awaited: notify maps to extension_ui_request
    // + a pending promise in rpc-mode; a floating call crashes the process
    // with "Request already answered" when the session tears down.
    expect(source!.content).not.toMatch(/^\s*ctx\.ui\.notify\(/m);
    expect((source!.content.match(/await ctx\.ui\.notify\(/g) ?? []).length).toBe(3);
  });

  it("reports partial provider refresh failures instead of failing silently", () => {
    expect(source!.content).toContain("result.errors");
  });
});
