// failureStore: a failure must outlive the toast, must not repeat itself, and
// must never grow without bound.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_DEDUPE_MS, MAX_FAILURES, failureKey, useFailureStore } from "../failureStore";

beforeEach(() => {
  useFailureStore.setState({ failures: [] });
});

describe("failureKey", () => {
  it("identifies the same failure by code, title and cause", () => {
    const a = failureKey({ code: "timeout", title: "读取远程文件失败", cause: "ECONNRESET" });
    const b = failureKey({ code: "timeout", title: "读取远程文件失败", cause: "ECONNRESET" });
    const c = failureKey({ code: "timeout", title: "读取远程文件失败", cause: "ENOENT" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("report", () => {
  it("classifies a thrown error and keeps the caller's title", () => {
    const rec = useFailureStore.getState().report({
      error: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
      title: "远程文件加载失败",
      target: { host: "h", path: "/data" },
    });
    expect(rec.code).toBe("timeout");
    expect(rec.title).toBe("远程文件加载失败");
    expect(rec.hint).toContain("慢");
    expect(rec.target).toEqual({ host: "h", path: "/data" });
  });

  it("keeps a caller-supplied cause verbatim instead of wrapping it", () => {
    const rec = useFailureStore.getState().report({ title: "保存失败", cause: "权限不足" });
    expect(rec.cause).toBe("权限不足");
  });

  it("lists the newest failure first", () => {
    const s = useFailureStore.getState();
    s.report({ title: "first", cause: "1" });
    s.report({ title: "second", cause: "2" });
    expect(useFailureStore.getState().failures.map((f) => f.title)).toEqual(["second", "first"]);
  });

  it("dedupes a repeating failure into a counter instead of flooding the list", () => {
    const s = useFailureStore.getState();
    for (let i = 0; i < 50; i++) s.report({ title: "远程文件加载失败", cause: "ECONNRESET" });
    const failures = useFailureStore.getState().failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]?.count).toBe(50);
  });

  it("records a repeat as a fresh entry once the dedupe window has passed", () => {
    const s = useFailureStore.getState();
    const first = s.report({ title: "远程文件加载失败", cause: "ECONNRESET" });
    // Backdate past the window instead of waiting 30s.
    useFailureStore.setState((st) => ({ failures: st.failures.map((f) => ({ ...f, at: f.at - FAILURE_DEDUPE_MS - 1 })) }));
    s.report({ title: "远程文件加载失败", cause: "ECONNRESET" });
    expect(useFailureStore.getState().failures).toHaveLength(2);
    expect(first.count).toBe(1);
  });

  it("keeps a retry action when it learns one later", () => {
    const s = useFailureStore.getState();
    const retry = vi.fn();
    s.report({ title: "远程文件加载失败", cause: "boom" });
    s.report({ title: "远程文件加载失败", cause: "boom", retry });
    expect(useFailureStore.getState().failures[0]?.retry).toBe(retry);
  });

  it("caps the list so a long session cannot grow it without bound", () => {
    const s = useFailureStore.getState();
    for (let i = 0; i < MAX_FAILURES + 15; i++) s.report({ title: `f${i}`, cause: "x" });
    const failures = useFailureStore.getState().failures;
    expect(failures).toHaveLength(MAX_FAILURES);
    expect(failures[0]?.title).toBe(`f${MAX_FAILURES + 14}`);
  });

  it("survives exotic thrown values", () => {
    expect(() => useFailureStore.getState().report({ error: "just a string" })).not.toThrow();
  });
});

describe("dismiss / clearAll", () => {
  it("removes one record or all of them", () => {
    const s = useFailureStore.getState();
    const a = s.report({ title: "a", cause: "1" });
    s.report({ title: "b", cause: "2" });
    useFailureStore.getState().dismiss(a.id);
    expect(useFailureStore.getState().failures.map((f) => f.title)).toEqual(["b"]);
    useFailureStore.getState().clearAll();
    expect(useFailureStore.getState().failures).toEqual([]);
  });
});
