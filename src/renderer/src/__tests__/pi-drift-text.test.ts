// 横幅那一行字：状态怎么说、原来的建议是否一字不变。两个面板（全局横幅与聊天
// 通知条）现在读同一个函数，所以这里也守着「本机先状态、再原建议」这条决策。
import { describe, expect, it } from "vitest";
import { classifyPiDrift, type PiDrift } from "../../../shared/pi-drift";
import { driftRecordText, driftText, updateBannerText } from "../pi-drift-text";
import type { UpdateNoticeInfo } from "../stores/uiStore";

const bundled = "0.85.1";

function drift(state: PiDrift["state"], runtime: PiDrift["runtime"] = "remote", detail?: string): PiDrift {
  const found = state === "pinned" ? bundled : state.startsWith("drifted") ? (state === "drifted-newer" ? "0.90.0" : "0.84.2") : null;
  return { state, runtime, bundled, found, ...(detail ? { detail } : {}) };
}

function local(patch: Partial<UpdateNoticeInfo> = {}): UpdateNoticeInfo {
  return { current: bundled, latest: "0.90.0", extensions: [], drift: drift("pinned", "bundled"), ...patch };
}

function remote(patch: Partial<UpdateNoticeInfo> = {}): UpdateNoticeInfo {
  return {
    current: "0.84.2", latest: bundled, extensions: [],
    targetLabel: "u@h", drift: drift("drifted-older"), ...patch,
  };
}

describe("driftText", () => {
  it("says nothing when the pi IS the contract version", () => {
    expect(driftText(drift("pinned"))).toBe("");
  });

  it("名状态：远程比契约旧/新是两句话，且都说清了动作", () => {
    expect(driftText(drift("drifted-older"))).toContain("比应用配套的 0.85.1 旧");
    expect(driftText(drift("drifted-older"))).toContain("更新会对齐到配套版本");
    // 「比契约新」不是错，但对齐会把它换回去 —— 这句话必须说清。
    expect(driftText(drift("drifted-newer"))).toContain("比应用配套的 0.85.1 新");
    expect(driftText(drift("drifted-newer"))).toContain("更新会对齐回配套版本");
  });

  it("says WHERE the pi is (远端带 label，本机说清是哪一个)", () => {
    expect(driftText(drift("absent"), "u@h")).toBe("没有找到 u@h 的 pi（未安装或不在 PATH）");
    expect(driftText(drift("unrunnable", "remote", "Cannot find module 'x'"), "u@h")).toBe("u@h 的 pi 跑不起来：Cannot find module 'x'");
    expect(driftText(drift("unknown"))).toBe("目标机上的 pi 版本未探明");
    // 本机终端的那个是全局 pi（用户自己 `pi update` 追的），不是捆绑版。
    expect(driftText(drift("drifted-newer", "global"))).toContain("终端用的全局 pi 是 0.90.0");
    expect(driftText(drift("unrunnable", "global", "missing pi-server"))).toBe("本机全局 pi 跑不起来：missing pi-server");
    expect(driftText(drift("absent", "global"))).toBe("本机没有全局 pi 命令（未安装或不在 PATH）");
    expect(driftText(drift("unrunnable", "bundled", "ENOENT"))).toBe("应用自带的 pi 跑不起来：ENOENT");
  });
});

describe("updateBannerText", () => {
  it("本机：先状态、再原建议 —— 追最新那句逐字保留", () => {
    const info = local({ extensions: ["pi-shell"], terminalDrift: drift("drifted-newer", "global") });
    expect(updateBannerText(info)).toBe(
      "终端用的全局 pi 是 0.90.0（比应用配套的 0.85.1 新，是你自己升级的；终端里跑的就是它）；" +
        "pi agent 有新版本：0.85.1 → 0.90.0；扩展包也有更新：pi-shell",
    );
  });

  it("本机：契约版本一致且终端 pi 无话可说时，文案与旧实现逐字相同", () => {
    expect(updateBannerText(local())).toBe("pi agent 有新版本：0.85.1 → 0.90.0");
    // 只有扩展包有更新（今天也是这一句）。
    expect(updateBannerText(local({ latest: null, extensions: ["pi-shell"] }))).toBe("pi 扩展包有更新：pi-shell");
  });

  it("本机：坏掉的捆绑 pi 也要说出来（否则「立即更新」会莫名失败）", () => {
    const info = local({ drift: drift("unrunnable", "bundled", "ENOENT") });
    expect(updateBannerText(info)).toBe("应用自带的 pi 跑不起来：ENOENT；pi agent 有新版本：0.85.1 → 0.90.0");
  });

  it("远程：状态就是文案（不再说「不一致」这种没信息量的话）", () => {
    expect(updateBannerText(remote())).toBe("u@h 的 pi 是 0.84.2（比应用配套的 0.85.1 旧，RPC 协议可能不匹配；更新会对齐到配套版本）");
    expect(updateBannerText(remote({ drift: drift("drifted-newer"), current: "0.90.0" }))).toContain("更新会对齐回配套版本");
  });

  it("远程：状态说不出话时退回原来那句（不变旧文案的面）", () => {
    expect(updateBannerText(remote({ drift: drift("pinned"), current: bundled }))).toBe(
      "u@h pi agent 版本（0.85.1）与应用配套版本（0.85.1）不一致；更新将对齐版本并同步扩展包",
    );
  });
});

describe("driftRecordText", () => {
  it("只记坏掉的那两种（硬规则 8），漂移与未探明不记", () => {
    expect(driftRecordText(drift("drifted-newer"))).toBeNull();
    expect(driftRecordText(drift("unknown"))).toBeNull();
    expect(driftRecordText(drift("pinned"))).toBeNull();
    expect(driftRecordText(drift("unrunnable", "global", "missing pi-server"))).toEqual({
      text: "本机全局 pi 跑不起来：missing pi-server",
      cause: "missing pi-server",
    });
    // 没有 detail 时，cause 退到那句话本身（别留空原因）。
    expect(driftRecordText(drift("absent"))?.cause).toBe("没有找到 目标机上的 pi（未安装或不在 PATH）");
  });

  it("agrees with the classifier it is fed from", () => {
    const classified = classifyPiDrift({ bundled, runtime: "remote", probe: { kind: "absent" } });
    expect(driftRecordText(classified, "u@h")?.text).toBe("没有找到 u@h 的 pi（未安装或不在 PATH）");
  });
});
