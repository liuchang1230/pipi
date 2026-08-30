// uiStore update workflow: one action owns both renderer presentations.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../uiStore";

const reset = () => useUiStore.setState({
  toast: null,
  updateInfo: null,
  updateResult: null,
  piUpdating: false,
});

describe("uiStore runPiUpdate", () => {
  beforeEach(() => {
    reset();
    vi.restoreAllMocks();
  });

  it("verifies the installed version after a successful update", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, output: "updated" });
    const check = vi.fn().mockResolvedValue({ current: "0.85.0", latest: "0.85.0", hasUpdate: false });
    vi.stubGlobal("window", { api: { update: { run, check } } });
    useUiStore.getState().setUpdateInfo({ current: "0.84.0", latest: "0.84.1", extensions: [] });

    await useUiStore.getState().runPiUpdate();

    expect(check).toHaveBeenCalledWith(true);
    expect(useUiStore.getState()).toMatchObject({
      piUpdating: false,
      updateInfo: null,
      updateResult: { ok: true, version: "0.85.0" },
    });
  });

  it("keeps a successful update successful when verification rejects", async () => {
    vi.stubGlobal("window", {
      api: {
        update: {
          run: vi.fn().mockResolvedValue({ ok: true, output: "updated" }),
          check: vi.fn().mockRejectedValue(new Error("verification unavailable")),
        },
      },
    });

    await useUiStore.getState().runPiUpdate();

    expect(useUiStore.getState()).toMatchObject({
      piUpdating: false,
      updateResult: { ok: true },
    });
  });

  it("resets busy state when update IPC rejects", async () => {
    vi.stubGlobal("window", { api: { update: { run: vi.fn().mockRejectedValue(new Error("IPC closed")) } } });

    await useUiStore.getState().runPiUpdate();

    expect(useUiStore.getState()).toMatchObject({
      piUpdating: false,
      updateResult: { ok: false, error: "IPC closed" },
    });
  });

  it("does not start a second renderer update while one is running", async () => {
    let complete!: (value: { ok: boolean; output: string }) => void;
    const run = vi.fn(() => new Promise<{ ok: boolean; output: string }>((resolve) => { complete = resolve; }));
    const check = vi.fn().mockResolvedValue({ current: "0.85.0", latest: "0.85.0", hasUpdate: false });
    vi.stubGlobal("window", { api: { update: { run, check } } });

    const first = useUiStore.getState().runPiUpdate();
    const second = useUiStore.getState().runPiUpdate();
    expect(run).toHaveBeenCalledTimes(1);
    complete({ ok: true, output: "updated" });
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
