// The toast must not be the only trace of a failure: opting in records it in
// the failure center, which persists and can offer a retry.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFailureStore } from "../failureStore";
import { useUiStore } from "../uiStore";

beforeEach(() => {
  useFailureStore.setState({ failures: [] });
  useUiStore.setState({ toast: null });
});

describe("showToast", () => {
  it("keeps a hint as a plain transient toast", () => {
    useUiStore.getState().showToast("请把 <会话名> 替换成实际名称", "err");
    expect(useUiStore.getState().toast?.text).toContain("会话名");
    expect(useFailureStore.getState().failures).toEqual([]);
  });

  it("records a real failure (with a retry) in the failure center", () => {
    const retry = vi.fn();
    useUiStore.getState().showToast("远程文件加载失败：ECONNRESET", "err", {
      failure: true,
      cause: "ECONNRESET",
      target: { host: "h", path: "/data" },
      retry,
    });

    const failures = useFailureStore.getState().failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]?.title).toBe("远程文件加载失败：ECONNRESET");
    expect(failures[0]?.cause).toBe("ECONNRESET");
    expect(failures[0]?.target).toEqual({ host: "h", path: "/data" });
    expect(failures[0]?.retry).toBe(retry);
    // Not retryable per the taxonomy, but the call site's retry wins.
    expect(failures[0]?.code).toBeTruthy();
  });

  it("still shows the transient toast alongside the persistent record", () => {
    useUiStore.getState().showToast("保存失败", "err", { failure: true });
    expect(useUiStore.getState().toast).toEqual({ text: "保存失败", type: "err" });
    expect(useFailureStore.getState().failures).toHaveLength(1);
  });
});
