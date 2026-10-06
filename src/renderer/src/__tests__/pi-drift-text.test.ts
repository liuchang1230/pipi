// 横幅那一行字：目标机 pi 的状态怎么说。两个面板（全局横幅与聊天通知条）读同一
// 个函数，所以这里守着「状态即文案」这条决策（ADR 0008 / 0009）。
import { describe, expect, it } from "vitest";
import { classifyPiDrift, type PiDrift } from "../../../shared/pi-drift";
import { driftText, updateBannerText } from "../pi-drift-text";
import type { UpdateNoticeInfo } from "../stores/uiStore";

const bundled = "0.85.1";

function drift(state: PiDrift["state"], detail?: string): PiDrift {
  const found = state === "pinned" ? bundled : state.startsWith("drifted") ? (state === "drifted-newer" ? "0.90.0" : "0.84.2") : null;
  return { state, bundled, found, ...(detail ? { detail } : {}) };
}

function remote(patch: Partial<UpdateNoticeInfo> = {}): UpdateNoticeInfo {
  return { targetLabel: "u@h", drift: drift("drifted-older"), ...patch };
}

describe("driftText", () => {
  it("says nothing when the pi IS the contract version", () => {
    expect(driftText(drift("pinned"))).toBe("");
  });

  it("名状态：比契约旧/新是两句话，且都说清了动作", () => {
    expect(driftText(drift("drifted-older"))).toContain("比应用配套的 0.85.1 旧");
    expect(driftText(drift("drifted-older"))).toContain("对齐会把它装到配套版本");
    // 「比契约新」不是错，但对齐会把它换回去 —— 这句话必须说清。
    expect(driftText(drift("drifted-newer"))).toContain("比应用配套的 0.85.1 新");
    expect(driftText(drift("drifted-newer"))).toContain("对齐会把它装回配套版本");
  });

  it("says WHERE the pi is (带 label 说主机，没有就说「目标机上」)", () => {
    expect(driftText(drift("absent"), "u@h")).toBe("没有找到 u@h 的 pi（未安装或不在 PATH）");
    expect(driftText(drift("unrunnable", "Cannot find module 'x'"), "u@h")).toBe("u@h 的 pi 跑不起来：Cannot find module 'x'");
    expect(driftText(drift("unknown"))).toBe("目标机上的 pi 版本未探明");
  });
});

describe("updateBannerText", () => {
  it("状态就是文案（不再说「不一致」这种没信息量的话）", () => {
    expect(updateBannerText(remote())).toBe("u@h 的 pi 是 0.84.2（比应用配套的 0.85.1 旧，RPC 协议可能不匹配；对齐会把它装到配套版本）");
    expect(updateBannerText(remote({ drift: drift("drifted-newer") }))).toContain("对齐会把它装回配套版本");
  });

  it("状态说不出话时也有一句话（横幅不会空着还带按钮）", () => {
    expect(updateBannerText(remote({ drift: drift("pinned") }))).toBe(
      "u@h 上的 pi 与配套版本（0.85.1）不一致；对齐会把它装回配套版本",
    );
    expect(updateBannerText({ drift: drift("pinned") })).toBe(
      "目标机 上的 pi 与配套版本（0.85.1）不一致；对齐会把它装回配套版本",
    );
  });

  it("agrees with the classifier it is fed from", () => {
    const classified = classifyPiDrift({ bundled, probe: { kind: "absent" } });
    expect(updateBannerText({ targetLabel: "u@h", drift: classified })).toBe("没有找到 u@h 的 pi（未安装或不在 PATH）");
  });
});
