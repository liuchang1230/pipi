/**
 * pi-version 的输出面只有一个：**交给运行器的那条命令**，以及失败被分到哪一类。
 * 所以这里的断言分两层：
 *  - 命令文本的不变量（版本 pin、npmmirror 回退、无单引号、base64 cwd）——从
 *    update-check 的纯逻辑测试原样搬来，它们描述的是本模块产出的命令；
 *  - seam 行为（fake runner 记录命令、超时/非零退出怎么分类、缓存与失效）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALIGN_TIMEOUT_MS,
  PiCommandError,
  PROBE_TIMEOUT_MS,
  align,
  buildRemoteAlignCommand,
  cachedProbe,
  clearProbeCache,
  invalidate,
  parseVersion,
  pickVersionFromOutput,
  probe,
  targetPiCommand,
  type PiPort,
} from "../pi-version";
import type { RunOptions, RunResult } from "../runner";

/** 记录每一次调用拿到的命令，并按剧本回答。 */
function fakeRunner(answers: Array<Partial<RunResult>> | ((options: RunOptions) => Partial<RunResult>)) {
  const calls: RunOptions[] = [];
  const run = async (options: RunOptions): Promise<RunResult> => {
    calls.push(options);
    const answer = typeof answers === "function" ? answers(options) : (answers.shift() ?? {});
    return { ok: true, code: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, calls };
}

function portWith(run: PiPort["run"], key = "ssh:u@h:22[~/team/agent]"): PiPort {
  return { run, key, target: { cwd: "/srv/app", agentDir: "~/team/agent" } };
}

beforeEach(() => clearProbeCache());

describe("probe", () => {
  it("hands the runner the login-shell pi command for the target", async () => {
    const fake = fakeRunner([{ stdout: "0.85.1\n" }]);
    const port = portWith(fake.run);
    const facts = await probe(port);
    expect(facts.version).toBe("0.85.1");
    // 与今天逐字相同：命令在登录交互 shell 里跑（远端 PATH 常由 rc 文件设置）。
    expect(fake.calls[0]!.command).toBe(`bash -ic '${targetPiCommand(port.target, "pi --version")}'`);
    const inner = fake.calls[0]!.command.slice("bash -ic '".length, -1);
    expect(inner).toContain("base64 -d"); // cwd 走 base64，没有引号边界
    expect(inner).toContain("export PI_CODING_AGENT_DIR='~/team/agent'");
    // 命令只嵌一层登录 shell：没有二次 `bash -ic` / `sh -s`。
    expect(inner.match(/bash -ic/g) ?? []).toHaveLength(0);
    expect(fake.calls[0]!.timeoutMs).toBe(PROBE_TIMEOUT_MS);
  });

  it("classifies a timeout without inventing an exit code", async () => {
    const fake = fakeRunner([{ ok: false, code: null, error: "timeout" }]);
    await expect(probe(portWith(fake.run))).rejects.toMatchObject({
      name: "PiCommandError",
      kind: "timeout",
      phase: undefined,
    });
  });

  it("keeps the remote stderr verbatim — the boundary's diagnosis is built from it", async () => {
    const stderr = "bash: line 1: pi: command not found";
    const fake = fakeRunner([{ ok: false, code: 127, stderr, error: "exit 127" }]);
    const error = await probe(portWith(fake.run)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiCommandError);
    expect((error as PiCommandError).stderr).toBe(stderr);
    expect((error as PiCommandError).kind).toBe("failed");
    expect((error as PiCommandError).detail).toBe("exit 127");
  });

  it("takes pi's version line, not the login banner", async () => {
    const fake = fakeRunner([{ stdout: "Welcome to Ubuntu 22.04.3 LTS\nnoise\n0.85.1\n" }]);
    expect((await probe(portWith(fake.run))).version).toBe("0.85.1");
  });
});

describe("cachedProbe", () => {
  it("serves the second call from the cache (one ssh connection per TTL)", async () => {
    const fake = fakeRunner([{ stdout: "0.85.1\n" }]);
    const port = portWith(fake.run);
    expect((await cachedProbe(port)).version).toBe("0.85.1");
    expect((await cachedProbe(port)).version).toBe("0.85.1");
    expect(fake.calls).toHaveLength(1);
  });

  it("caches the failure too and rethrows it without reconnecting", async () => {
    const fake = fakeRunner([{ ok: false, code: null, error: "timeout" }]);
    const port = portWith(fake.run);
    await expect(cachedProbe(port)).rejects.toBeInstanceOf(PiCommandError);
    await expect(cachedProbe(port)).rejects.toMatchObject({ kind: "timeout" });
    expect(fake.calls).toHaveLength(1);
  });

  it("invalidate only drops the key it is given", async () => {
    const fake = fakeRunner(() => ({ stdout: "0.85.1\n" }));
    const port = portWith(fake.run, "ssh:a@h:22");
    await cachedProbe(port);
    invalidate("ssh:other@h:22");
    await cachedProbe(port);
    expect(fake.calls).toHaveLength(1);
    invalidate("ssh:a@h:22");
    await cachedProbe(port);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("align", () => {
  it("pins the bundle and keeps the npmmirror fallback in the same round trip", async () => {
    const fake = fakeRunner([{ stdout: "added 1 package\n" }, { stdout: "0.85.1\n" }]);
    const port = portWith(fake.run);
    const result = await align(port, "0.85.1");
    expect(fake.calls[0]!.command).toBe(`bash -ic '${targetPiCommand(port.target, buildRemoteAlignCommand("0.85.1", true))}'`);
    expect(fake.calls[0]!.command).toContain("@earendil-works/pi-coding-agent@0.85.1");
    expect(fake.calls[0]!.command).toContain("--registry=https://registry.npmmirror.com");
    expect(fake.calls[0]!.command).not.toContain("registry.npmjs.org");
    expect(fake.calls[0]!.timeoutMs).toBe(ALIGN_TIMEOUT_MS);
    expect(result).toEqual({ output: "added 1 package\n", version: "0.85.1" });
    // 验证是第二次调用，且是无缓存的那条路。
    expect(fake.calls[1]!.command).toBe(`bash -ic '${targetPiCommand(port.target, "pi --version")}'`);
  });

  it("drops the probe cache once something was installed", async () => {
    const fake = fakeRunner(() => ({ stdout: "0.85.1\n" }));
    const port = portWith(fake.run);
    await cachedProbe(port); // 1 次：安装前的旧事实
    await align(port, "0.85.1"); // 2 次：安装 + 验证
    await cachedProbe(port); // 第 4 次：缓存已失效，必须重新探测
    expect(fake.calls).toHaveLength(4);
  });

  it("does not judge the version itself — a different version is still a fact", async () => {
    const fake = fakeRunner([{ stdout: "installed\n" }, { stdout: "0.84.0\n" }]);
    const result = await align(portWith(fake.run), "0.85.1");
    expect(result.version).toBe("0.84.0");
  });

  it("tags a failed install with phase=install", async () => {
    const fake = fakeRunner([{ ok: false, code: 1, stderr: "npm error code ETARGET", error: "exit 1" }]);
    const error = await align(portWith(fake.run), "0.85.1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiCommandError);
    expect((error as PiCommandError).phase).toBe("install");
    expect((error as PiCommandError).stderr).toContain("ETARGET");
  });

  it("tags a failed post-install probe with phase=verify and keeps the install log", async () => {
    const fake = fakeRunner([
      { stdout: "added 1 package\n" },
      { ok: false, code: 1, stderr: "TypeError: webidl.util.markAsUncloneable is not a function", error: "exit 1" },
    ]);
    const error = await align(portWith(fake.run), "0.85.1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiCommandError);
    expect((error as PiCommandError).phase).toBe("verify");
    // 用户要看到安装日志，再看到「装上了但起不来」。
    expect((error as PiCommandError).output).toBe("added 1 package\n");
  });
});

describe("buildRemoteAlignCommand", () => {
  it("pins the exact bundled version and detects bun installs", () => {
    const cmd = buildRemoteAlignCommand("0.84.4");
    expect(cmd).toContain("@earendil-works/pi-coding-agent@0.84.4");
    expect(cmd).toContain("*/.bun/*) npm install -g --fetch-timeout=60000 --fetch-retries=1 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=10000 @earendil-works/pi-coding-agent@0.84.4;;");
    expect(cmd).toContain("*) npm install -g --fetch-timeout=60000 --fetch-retries=1 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=10000 @earendil-works/pi-coding-agent@0.84.4;;");
  });

  it("refuses to npm-install over a pi.dev managed (pi-node) install — 2026-10-07 incident guard", () => {
    // When PATH's pi lives under pi-node/node-*/bin, PATH's npm is usually the
    // managed tree's own npm, and `npm install -g` rewrites the LIVE managed
    // install in place: a running session lazily loading a chunk hits the
    // half-written state and dies with `Cannot find module …/openai-completions-*.js`
    // (measured on 36.151.162.7). The managed tree is upgraded by `pi update`,
    // never by pipi's align — so the guard exits 3 before touching anything.
    const cmd = buildRemoteAlignCommand("1.0.4", true);
    expect(cmd).toContain("*/pi-node/node-*/bin/*)");
    expect(cmd).toContain("pipi-align-blocked");
    expect(cmd).toContain("exit 3");
    expect(cmd).not.toContain("pi update"); // ADR 0009 守卫：对齐命令永不执行 pi update（提示文案也不借这个字面量）
    // And the guard runs BEFORE the install case statement.
    expect(cmd.indexOf("pipi-align-blocked")).toBeLessThan(cmd.indexOf("case \"$P\" in */.bun/*"));
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

  it("installs ONLY the pinned version — no `pi update --extensions` tail (ADR 0009)", () => {
    // 用户自己配的扩展包不是 app 的事：对齐只保证目标机跑的是契约版本。
    const cmd = buildRemoteAlignCommand("0.84.4");
    expect(cmd).not.toContain("pi update");
    expect(cmd).not.toContain("extensions");
    expect(cmd.endsWith("esac")).toBe(true);
  });
});

describe("targetPiCommand", () => {
  it("resolves ~ and ~/… cwd before cd (tilde expansion must run)", () => {
    const cmd = targetPiCommand({ cwd: "~/code/proj" }, "pi --version");
    expect(cmd).toContain('case "$P" in "~") P="$HOME"');
    expect(cmd).toContain('cd "$P" && pi --version');
    expect(cmd).not.toContain("'"); // no quotes inside the nested layer
  });

  it("injects PI_CODING_AGENT_DIR only for a safe agentDir", () => {
    const cmd = targetPiCommand({ cwd: "/home/u/p", agentDir: "~/team-a/agent" }, "pi --version");
    expect(cmd).toContain("export PI_CODING_AGENT_DIR='~/team-a/agent'");
    // Unsafe agentDir (spaces / ..) must be dropped, not spliced.
    const bad = targetPiCommand({ cwd: "/home/u/p", agentDir: "../../etc" }, "pi --version");
    expect(bad).not.toContain("export PI_CODING_AGENT_DIR");
  });

  it("passes the command through when no cwd is given", () => {
    expect(targetPiCommand(undefined, "pi --version")).toBe("pi --version");
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

  it("parseVersion keeps the first x.y.z it sees", () => {
    expect(parseVersion("v0.85.1")).toBe("0.85.1");
    expect(parseVersion("none")).toBeNull();
  });
});
