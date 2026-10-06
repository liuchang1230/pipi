// 漂移分类的真值表：契约版本 × 探测结论 → 状态。ADR 0008 的全部语义都在这里，
// 所以每条规则都是一个断言（这也是「接口即测试面」的那一层）。
//
// 只服务目标机（ADR 0009 之后本机不分类漂移：本机那个 pi 在不在/好不好由
// `local-pi` 的 `PiPresence` 回答）。
import { describe, expect, it } from "vitest";
import { classifyPiDrift, type PiProbeOutcome } from "../pi-drift";
import { compareVersions } from "../version-compare";

const bundled = "0.85.1";

function classify(probe: PiProbeOutcome, b: string | null = bundled) {
  return classifyPiDrift({ bundled: b, probe });
}

describe("classifyPiDrift", () => {
  it("names the contract version as pinned", () => {
    expect(classify({ kind: "version", version: "0.85.1" }).state).toBe("pinned");
  });

  it("separates newer from older (对齐的提议要看方向)", () => {
    expect(classify({ kind: "version", version: "0.90.0" }).state).toBe("drifted-newer");
    expect(classify({ kind: "version", version: "0.84.2" }).state).toBe("drifted-older");
    // 数字段比较，不是字符串比较。
    expect(classify({ kind: "version", version: "0.85.10" }).state).toBe("drifted-newer");
  });

  it("reports the facts it classified on (渲染层只读它，不再自己拼判定)", () => {
    expect(classify({ kind: "version", version: bundled })).toEqual({
      state: "pinned",
      bundled,
      found: bundled,
    });
    expect(classify({ kind: "version", version: "0.84.2" })).toEqual({
      state: "drifted-older",
      bundled,
      found: "0.84.2",
    });
  });

  it("reads a missing binary as absent, and a broken one as unrunnable", () => {
    expect(classify({ kind: "absent" }).state).toBe("absent");
    const broken = classify({ kind: "unrunnable", detail: "Cannot find module 'x'" });
    expect(broken.state).toBe("unrunnable");
    expect(broken.detail).toBe("Cannot find module 'x'");
    // 没有细节也要能分类（detail 可选）。
    expect(classify({ kind: "unrunnable" }).detail).toBeUndefined();
  });

  it("does not guess: timeout / never-probed / no readable version are unknown", () => {
    expect(classify({ kind: "timeout" }).state).toBe("unknown");
    expect(classify({ kind: "unverified" }).state).toBe("unknown");
    // 在场但输出里没有 semver：拿 "0.0.0" 去比会得出「比契约旧」这种假话。
    expect(classify({ kind: "version", version: null }).state).toBe("unknown");
    expect(classify({ kind: "version", version: null }).found).toBeNull();
  });

  it("is unknown when even the contract version cannot be read", () => {
    expect(classify({ kind: "version", version: "0.90.0" }, null).state).toBe("unknown");
    expect(classify({ kind: "absent" }, null).state).toBe("unknown");
  });
});

describe("compareVersions", () => {
  it("compares the first three numeric segments", () => {
    expect(compareVersions("0.85.10", "0.85.9")).toBe(1);
    expect(compareVersions("0.85.1", "0.85.1")).toBe(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.84.2", "0.85.1")).toBe(-1);
  });

  it("treats missing and non-numeric segments as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});
