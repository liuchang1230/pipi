// outcome: one error contract. The point is that a caller can never mistake a
// failure for data, and that the user always gets a cause + a next step.
import { describe, expect, it } from "vitest";
import { classifyError, describeAppError, fail, makeError, ok, toAppError } from "../outcome";

describe("Outcome", () => {
  it("keeps success and failure mutually exclusive at the type level", () => {
    const good = ok(7);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value).toBe(7);

    const bad = fail<number>(makeError("timeout", "读取超时", "DeadlineError: 30s"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("timeout");
  });
});

describe("classifyError", () => {
  const cases: Array<[string, unknown]> = [
    ["timeout", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
    ["timeout", Object.assign(new Error("x"), { name: "DeadlineError" })],
    ["permission", Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })],
    ["notfound", Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })],
    ["conflict", Object.assign(new Error("EEXIST"), { code: "EEXIST" })],
    ["auth", new Error("Permission denied (publickey).")],
    ["offline", new Error("SSH 连接已断开（对端关闭）")],
    ["offline", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["protocol", new Error("Unexpected token < in JSON at position 0")],
    ["internal", new Error("boom")],
    ["internal", "just a string"],
  ];

  it.each(cases)("classifies %s", (expected, error) => {
    expect(classifyError(error)).toBe(expected);
  });

  it("does not mistake a filesystem EACCES for an auth failure", () => {
    expect(classifyError(Object.assign(new Error("EACCES"), { code: "EACCES" }))).toBe("permission");
  });
});

describe("makeError", () => {
  it("attaches a per-code next step by default", () => {
    expect(makeError("auth", "登录失败", "Permission denied").hint).toContain("密码");
  });

  it("marks retryability per class (a protocol mismatch is not retryable)", () => {
    expect(makeError("timeout", "t", "c").retryable).toBe(true);
    expect(makeError("protocol", "t", "c").retryable).toBe(false);
    expect(makeError("cancelled", "t", "c").retryable).toBe(false);
  });

  it("honours an explicit hint, including its absence", () => {
    expect(makeError("cancelled", "已取消", "user", { hint: "" }).hint).toBe("");
  });
});

describe("toAppError", () => {
  it("uses the caller's context as the title and keeps the technical cause", () => {
    const e = toAppError(Object.assign(new Error("ENOENT: no such file, open '/data/x'"), { code: "ENOENT" }), {
      title: "读取远程文件失败",
      target: { host: "h", path: "/data/x" },
    });
    expect(e.code).toBe("notfound");
    expect(e.title).toBe("读取远程文件失败");
    expect(e.cause).toContain("/data/x");
    expect(e.target).toEqual({ host: "h", path: "/data/x" });
  });

  it("never throws on exotic thrown values (React can throw anything)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toAppError(cyclic)).not.toThrow();
    expect(toAppError(undefined).code).toBe("internal");
  });
});

describe("describeAppError", () => {
  it("produces one greppable line with the code and the target", () => {
    expect(describeAppError(makeError("offline", "连接断开", "ECONNRESET", { target: { host: "h", path: "/r" } }))).toBe(
      "offline: 连接断开 — ECONNRESET [h:/r]",
    );
  });
});
