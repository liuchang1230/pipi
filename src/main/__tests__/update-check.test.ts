/**
 * Remote pi 探测失败 → 给人看的话术（纯文本映射）。命令怎么造、探测怎么
 * 分类，看 pi-version.test.ts；这里只测「原文 → 用户读到的句子」。
 */
import { describe, expect, it } from "vitest";
import { PiCommandError } from "../pi-version";
import { friendlyRemoteInstallError, friendlyRemoteProbeError, remoteProbeFailureText, stripShellNoise } from "../update-check";

describe("remoteProbeFailureText", () => {
  it("keeps the remote stderr verbatim (the friendly mapper reads it)", () => {
    const e = new PiCommandError("failed", undefined, "bash: pi: command not found\n", "exit 127", "");
    expect(remoteProbeFailureText(e)).toBe("bash: pi: command not found");
  });

  it("falls back to 远程 pi 不可用 for a bare exit code", () => {
    expect(remoteProbeFailureText(new PiCommandError("failed", "install", "", "exit 1", ""))).toBe("远程 pi 不可用");
  });

  it("treats a signal death (no exit code) as noise too", () => {
    // ssh2 的 channel 可以不给退出码就关掉（被信号杀掉）：旧实现同样退到
    // “远程 pi 不可用”，而不是把 `exit signal` 当诊断原文给用户。
    expect(remoteProbeFailureText(new PiCommandError("failed", undefined, "", "exit signal", ""))).toBe("远程 pi 不可用");
  });

  it("surfaces a transport reason that is not an exit code", () => {
    expect(remoteProbeFailureText(new PiCommandError("failed", undefined, "", "ssh not found", ""))).toBe("ssh not found");
  });

  it("names the timeout in our own words", () => {
    expect(remoteProbeFailureText(new PiCommandError("timeout", undefined, "", "timeout", ""))).toBe("远程 pi 版本检查超时");
  });

  it("passes non-PiCommandError through", () => {
    expect(remoteProbeFailureText(new Error("boom"))).toBe("boom");
    expect(remoteProbeFailureText("boom")).toBe("boom");
  });
});

describe("friendlyRemoteInstallError", () => {
  it("maps stale-cache ETARGET to the paste-ready npmmirror install command", () => {
    const raw =
      "npm error code ETARGET\n" +
      "npm error notarget No matching version found for @earendil-works/pi-coding-agent@0.85.1\n";
    const hint = friendlyRemoteInstallError(raw, "0.85.1");
    expect(hint).toContain("过期缓存");
    expect(hint).toContain("--registry=https://registry.npmmirror.com");
    expect(hint).toContain("@0.85.1");
  });

  it("maps FETCH_ERROR/network failures to the same actionable command", () => {
    const hint = friendlyRemoteInstallError("npm error code FETCH_ERROR\nnpm error network timeout at: https://registry.npmjs.org/…", "0.85.1");
    expect(hint).toContain("网络连接失败");
    expect(hint).toContain("--registry=https://registry.npmmirror.com");
    const hint2 = friendlyRemoteInstallError("getaddrinfo EAI_AGAIN registry.npmjs.org", "0.85.0");
    expect(hint2).toContain("npmmirror.com");
    expect(hint2).toContain("@0.85.0");
  });

  it("returns empty for unrelated failures (no misleading hint)", () => {
    expect(friendlyRemoteInstallError("npm error code EACCES", "0.85.1")).toBe("");
    expect(friendlyRemoteInstallError("", "0.85.1")).toBe("");
  });

  it("does not recommend the mirror when npmmirror itself answered the ETARGET", () => {
    // Mirror-lag sub-case: fresh bundle not yet synced. The mirror command
    // just failed — the hint must not tell the user to re-run it.
    const raw =
      "npm error code ETARGET\n" +
      "npm error 404 Not Found - GET https://registry.npmmirror.com/@earendil-works%2fpi-coding-agent - No matching version found for @earendil-works/pi-coding-agent@0.86.0\n";
    const hint = friendlyRemoteInstallError(raw, "0.86.0");
    expect(hint).toContain("尚未同步");
    expect(hint).not.toContain("--registry=");
  });

  it("keeps the stale-cache hint when only the official registry is mentioned", () => {
    const raw =
      "npm error code ETARGET\n" +
      "npm error notarget No matching version found for @earendil-works/pi-coding-agent@0.85.1 (at https://registry.npmjs.org)\n";
    const hint = friendlyRemoteInstallError(raw, "0.85.1");
    expect(hint).toContain("过期缓存");
    expect(hint).toContain("--registry=https://registry.npmmirror.com");
  });

  it("composes with stripShellNoise: bash noise stripped, hint still maps from raw", () => {
    const raw =
      "bash: cannot set terminal process group (-1): Inappropriate ioctl for device\n" +
      "bash: no job control in this shell\n" +
      "npm error code ETARGET\n" +
      "npm error notarget No matching version found for @earendil-works/pi-coding-agent@0.85.1\n";
    const cleaned = stripShellNoise(raw);
    expect(cleaned).toContain("No matching version found");
    expect(cleaned).not.toContain("ioctl");
    // The hint runs on the RAW text (npm's verdict lines live on stderr) and
    // must still classify it after noise would have been stripped away.
    expect(friendlyRemoteInstallError(raw, "0.85.1")).toContain("npmmirror.com");
  });
});

describe("friendlyRemoteProbeError", () => {
  it("detects the runtime-too-old case (undici markAsUncloneable)", () => {
    const stderr =
      "bash: cannot set terminal process group (123): Inappropriate ioctl for device\n" +
      "TypeError: webidl.util.markAsUncloneable is not a function (In 'webidl.util.markAsUncloneable(this)')";
    const msg = friendlyRemoteProbeError(stderr);
    expect(msg).toContain("Node ≥20.10");
    expect(msg).toContain("Bun");
  });

  it("detects pi missing / not on PATH", () => {
    expect(friendlyRemoteProbeError("bash: pi: command not found")).toContain("未检测到 pi");
  });

  it("detects a missing remote directory", () => {
    expect(friendlyRemoteProbeError("cd: no such file or directory: /gone/proj")).toContain("远程目录不存在");
  });

  it("filters ioctl noise and returns the useful tail", () => {
    const msg = friendlyRemoteProbeError("bash: no job control in this shell\nError: boom");
    expect(msg).toBe("Error: boom");
  });
});

describe("stripShellNoise", () => {
  it("removes the two bash -ic tty warnings above the real error", () => {
    const stderr =
      "bash: cannot set terminal process group (-1): Inappropriate ioctl for device\n" +
      "bash: no job control in this shell\n" +
      "npm error code ETARGET\n" +
      "npm error notarget No matching version found for @earendil-works/pi-coding-agent@0.85.0\n";
    const cleaned = stripShellNoise(stderr);
    expect(cleaned).not.toContain("ioctl");
    expect(cleaned).not.toContain("job control");
    expect(cleaned).toContain("No matching version found");
    expect(cleaned).toContain("npm error code ETARGET");
  });

  it("keeps both ends of a very long payload", () => {
    const long = stripShellNoise("A".repeat(2000));
    expect(long.length).toBeLessThan(1700);
    expect(long.startsWith("A".repeat(800))).toBe(true);
    expect(long.endsWith("A".repeat(800))).toBe(true);
    expect(long).toContain("…");
  });

  it("passes clean text through untouched", () => {
    expect(stripShellNoise("npm error code ETARGET\n")).toBe("npm error code ETARGET");
  });
});
