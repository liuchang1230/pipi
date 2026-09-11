/**
 * Remote pi alignment + probe diagnostics — pure-logic tests. The remote
 * commands nest inside `bash -ic '…'`, so the invariants here matter: no
 * single quotes, no metacharacters from inputs, version pinned to the app's
 * bundle, and the probe stderr maps to an actionable message.
 */
import { describe, expect, it } from "vitest";
import {
  buildRemoteAlignCommand,
  friendlyRemoteInstallError,
  friendlyRemoteProbeError,
  pickVersionFromOutput,
  stripShellNoise,
  targetPiCommand,
} from "../update-check";

describe("buildRemoteAlignCommand", () => {
  it("pins the exact bundled version and detects bun installs", () => {
    const cmd = buildRemoteAlignCommand("0.84.4");
    expect(cmd).toContain("@earendil-works/pi-coding-agent@0.84.4");
    // Same npm install on the bun path (bun has no --registry flag; only the
    // runtime differs). Fetch timeouts are clamped on every attempt so a
    // black-holed registry cannot eat the whole 600s command budget.
    expect(cmd).toContain("*/.bun/*) npm install -g --fetch-timeout=60000 --fetch-retries=1 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=10000 @earendil-works/pi-coding-agent@0.84.4;;");
    expect(cmd).toContain("*) npm install -g --fetch-timeout=60000 --fetch-retries=1 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=10000 @earendil-works/pi-coding-agent@0.84.4;;");
  });

  it("registry fallback retries via npmmirror (China-reachable) on the npm path only", () => {
    // 2026-09 incident: server default registry = official registry, but the
    // server could not reach it — npm served STALE CACHE metadata as a bogus
    // ETARGET for a version published days earlier. The official registry is
    // the worst fallback target from inside China; npmmirror syncs within
    // hours and is directly reachable, so it is the baked-in retry target.
    const fallback = buildRemoteAlignCommand("0.85.1", true);
    expect(fallback).toContain("--registry=https://registry.npmmirror.com");
    expect(fallback).not.toContain("registry.npmjs.org");
    // The bun branch has no registry override (bun has no --registry flag;
    // its default registry is the official one anyway).
    expect(fallback).toContain("*/.bun/*) npm install -g --fetch-timeout=60000 --fetch-retries=1 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=10000 @earendil-works/pi-coding-agent@0.85.1;;");
    // The mirror retry reuses the same clamps.
    expect(fallback).toContain("--fetch-retry-maxtimeout=10000 @earendil-works/pi-coding-agent@0.85.1 --registry=https://registry.npmmirror.com");
    // Default (no fallback) has no registry override.
    expect(buildRemoteAlignCommand("0.85.1")).not.toContain("npmmirror");
  });

  it("contains no single quotes (safe inside bash -ic '…'), including the fallback chain", () => {
    for (const v of ["0.84.4", "0.85.0", "0.85.1"]) {
      expect(buildRemoteAlignCommand(v)).not.toContain("'");
      expect(buildRemoteAlignCommand(v, true)).not.toContain("'");
    }
  });

  it("keeps extension update best-effort with a failure guard", () => {
    const cmd = buildRemoteAlignCommand("0.84.4");
    expect(cmd).toContain("pi update --extensions 2>/dev/null || true");
  });
});

describe("targetPiCommand", () => {
  it("resolves ~ and ~/… cwd before cd (tilde expansion must run)", () => {
    const cmd = targetPiCommand(undefined, "~/code/proj", "pi --version");
    expect(cmd).toContain('case "$P" in "~") P="$HOME"');
    expect(cmd).toContain("cd \"$P\" && pi --version");
    expect(cmd).not.toContain("'"); // no quotes inside the nested layer
  });

  it("injects PI_CODING_AGENT_DIR only for a safe agentDir", () => {
    const cmd = targetPiCommand({ agentDir: "~/team-a/agent" } as never, "/home/u/p", "pi --version");
    expect(cmd).toContain("export PI_CODING_AGENT_DIR='~/team-a/agent'");
    // Unsafe agentDir (spaces / ..) must be dropped, not spliced.
    const bad = targetPiCommand({ agentDir: "../../etc" } as never, "/home/u/p", "pi --version");
    expect(bad).not.toContain("export PI_CODING_AGENT_DIR");
  });

  it("passes the command through when no cwd is given", () => {
    const cmd = targetPiCommand(undefined, undefined, "pi --version");
    expect(cmd).toBe("pi --version");
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

describe("pickVersionFromOutput", () => {
  it("takes the last semver-looking line (banner noise before pi's line)", () => {
    const out = "Welcome to Ubuntu 22.04.3 LTS\n0.84.4\n";
    expect(pickVersionFromOutput(out)).toBe("0.84.4");
  });

  it("returns null when nothing looks like a version", () => {
    expect(pickVersionFromOutput("pi: command not found")).toBeNull();
    expect(pickVersionFromOutput("")).toBeNull();
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
