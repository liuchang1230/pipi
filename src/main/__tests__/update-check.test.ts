/**
 * Remote pi alignment + probe diagnostics — pure-logic tests. The remote
 * commands nest inside `bash -ic '…'`, so the invariants here matter: no
 * single quotes, no metacharacters from inputs, version pinned to the app's
 * bundle, and the probe stderr maps to an actionable message.
 */
import { describe, expect, it } from "vitest";
import {
  buildRemoteAlignCommand,
  friendlyRemoteProbeError,
  pickVersionFromOutput,
  stripShellNoise,
  targetPiCommand,
} from "../update-check";

describe("buildRemoteAlignCommand", () => {
  it("pins the exact bundled version and detects bun installs", () => {
    const cmd = buildRemoteAlignCommand("0.84.4");
    expect(cmd).toContain("@earendil-works/pi-coding-agent@0.84.4");
    expect(cmd).toContain("*/.bun/*) PM=\"bun install -g\"");
    expect(cmd).toContain("*) PM=\"npm install -g\"");
  });

  it("contains no single quotes (safe inside bash -ic '…')", () => {
    for (const v of ["0.84.4", "0.85.0"]) {
      expect(buildRemoteAlignCommand(v)).not.toContain("'");
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
