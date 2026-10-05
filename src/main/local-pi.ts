/**
 * 本机 pi：**哪一个** pi 在本机跑、在不在、配套的 pin 是什么 —— 唯一答案
 * （ADR 0007 决策 2）。
 *
 * 这一层只输出**事实与在场状态**，不吐 spawn plan、不吐版本号（决策 4）：
 * `createTab` 是同步的（点击路径），所以解析必须是纯解析 —— 探测是副作用与
 * 延迟，只在显式问「在不在」时发生，而且有缓存 + 耗时上限。
 *
 * 这里**不涉及**用户全局 pi 之外的任何目标：远端/WSL 的版本对齐在
 * `pi-version.ts`（runner 那侧），`bundledPiVersion()` 是 pin 的唯一真值，
 * 用户的全局 pi 永不参与 pin（决策 7）。
 */
import { app } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./debug-log";
import { DETECT_SPAWN_TIMEOUT_MS, findExe, findExeOrNull, findViaWhere, isSpawnTimeout, npmGlobalDir } from "./find-exe";
import { parseVersion } from "./pi-version";

// --- Facts: where pi and node are on this machine ---------------------------

/** 解析结果的来源：哪一条候选赢了。`unresolved` = 三条都没命中，手上只是
 *  `findExe` 退回的裸名字（那不是文件）——给诊断用。 */
export type PiSource = "npm-global" | "where" | "fallback" | "unresolved";

export interface PiFacts {
  /** 全局 `pi` shim 的绝对路径（npm 全局布局优先）。 */
  piBin: string;
  source: PiSource;
  /** 能直跑 pi 的 node；找不到时为 null（此时只能走 shim）。 */
  nodeBin: string | null;
  /** shim 指向的 `cli.js`；`piBin` 不是 shim 时为 null。 */
  cliJs: string | null;
}

function nodeFallbacks(): string[] {
  return [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node.exe"),
  ];
}

let cachedPiBin: { bin: string; source: PiSource } | undefined;

function findPiBin(): { bin: string; source: PiSource } {
  if (cachedPiBin !== undefined) return cachedPiBin;
  // 1. npm 全局权威位置（`npm install -g` 的唯一目标目录，绝对路径不受
  //    PATH/where 选择影响）。
  const npmGlobalCandidates = [
    join(npmGlobalDir(), "pi.cmd"),
    join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "pi.cmd"),
  ];
  for (const c of npmGlobalCandidates) {
    if (existsSync(c)) {
      cachedPiBin = { bin: c, source: "npm-global" };
      return cachedPiBin;
    }
  }
  // 2. where.exe（用户 PATH 里的 pi——自定义安装 / nvm 布局）。
  const fromWhere = findViaWhere("pi");
  if (fromWhere) {
    cachedPiBin = { bin: fromWhere, source: "where" };
    return cachedPiBin;
  }
  // 3. 其他常见位置。bare name（findExe 的兜底）意味着三条都没命中。
  const bin = findExe("pi.cmd", [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "pi.cmd"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node-v22.19.0-win-x64", "pi.cmd"),
  ]);
  cachedPiBin = { bin, source: /[\\/]/.test(bin) ? "fallback" : "unresolved" };
  return cachedPiBin;
}

let cachedNodeBin: string | null | undefined;

function findNodeBin(): string | null {
  if (cachedNodeBin !== undefined) return cachedNodeBin;
  // 裸名字（`findExe` 的兜底）不是可 spawn 的路径：对「能不能走 node 直跑
  // cli.js」这件事，它与 null 等价（rpc-session 原本就是这么判的）。
  cachedNodeBin = findExeOrNull("node.exe", nodeFallbacks());
  return cachedNodeBin;
}

/** 全局 `pi` shim 的绝对路径。 */
export function globalPiBin(): string {
  return findPiBin().bin;
}

/**
 * Resolve the real cli.js a pi shim points at. This is exactly what running
 * `pi` in a terminal does (pi.cmd → node cli.js); resolving it lets us verify
 * the install by spawning node.exe directly — node is an .exe, so there is no
 * cmd.exe /c quoting to get wrong (a pi.cmd under a path with spaces used to
 * make the old `cmd /c <path> --version` probe fail → false "pi missing").
 */
export function resolveCliJsFromShim(piBin: string): string | null {
  if (!/\.(cmd|bat)$/i.test(piBin)) return null;
  // Standard npm layout: <npmGlobalDir>\node_modules\@earendil-works\pi-coding-agent\dist\cli.js
  const standard = join(dirname(piBin), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (existsSync(standard)) return standard;
  // Custom layout: read the shim and find the cli.js it references.
  try {
    const content = readFileSync(piBin, "utf8");
    const m = content.match(/("[^"]*cli\.js"|[^\s"]*cli\.js)/i);
    if (m) {
      const cand = m[1].replace(/%dp0%/gi, dirname(piBin)).replace(/"/g, "").replace(/\\/g, "/");
      const abs = cand.startsWith("/") || /^[A-Za-z]:/.test(cand) ? cand : join(dirname(piBin), cand);
      if (existsSync(abs)) return abs;
    }
  } catch {
    /* unreadable shim → fall through */
  }
  return null;
}

/** 本机 pi 的完整事实（纯解析，无 spawn、无版本号）。 */
export function resolveLocal(): PiFacts {
  const { bin, source } = findPiBin();
  return { piBin: bin, source, nodeBin: findNodeBin(), cliJs: resolveCliJsFromShim(bin) };
}

/**
 * 「怎么在本机起一个 pi」的 node 直跑分支 —— `rpc-session`（`--mode rpc`）与
 * `update-check`（`pi update`）需要逐字相同的那两行。TUI 的 pty spawn 不用它：
 * 那里**偏好 cmd shim**（conpty 与 batch shim 的历史），所以那是另一条策略。
 */
export function localPiSpawnPlan(extraArgs: string[]): { file: string; args: string[] } {
  const facts = resolveLocal();
  if (facts.nodeBin && facts.cliJs) return { file: facts.nodeBin, args: [facts.cliJs, ...extraArgs] };
  const piBin = facts.piBin.replace(/\//g, "\\");
  return { file: "cmd.exe", args: ["/d", "/c", `"${piBin}"`, ...extraArgs] };
}

// --- The bundled pin (the ONLY version truth) -------------------------------

/** Path to the bundled pi package inside this app (works dev + packaged/asar). */
export function bundledPiPackagePath(): string {
  return join(app.getAppPath(), "node_modules", "@earendil-works", "pi-coding-agent");
}

/**
 * The pi version the app SHIPS, i.e. the RPC protocol contract every remote and
 * WSL pi is aligned to. Read from the app's OWN node_modules (main-process fs
 * reads through app.asar) — NEVER the user's global pi: global pi is free to
 * chase npm latest (local `pi update`), and the align target must stay on the
 * bundle: aligning a server to another version both diverges from the app's RPC
 * protocol and asks the server's npm registry for a version a lagging mirror
 * may not have synced (npm ETARGET).
 *
 * The pin must stay installable on the app's own Electron runtime — that is the
 * real constraint (`docs/adr/0007`「既有记录的修正」), not a frozen version.
 */
let bundledPiVersionCache: string | null = null;
export function bundledPiVersion(): string | null {
  if (bundledPiVersionCache !== null) return bundledPiVersionCache;
  try {
    const pkgPath = join(bundledPiPackagePath(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      const v = parseVersion(pkg.version);
      if (v) bundledPiVersionCache = v;
    }
  } catch {
    /* fall through */
  }
  if (bundledPiVersionCache === null) {
    // Last resort: the app's own package.json pins the dependency exactly
    // ("@earendil-works/pi-coding-agent": "0.85.1" — no caret). Same
    // contract number even if node_modules is not on disk.
    try {
      const appPkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
        dependencies?: Record<string, unknown>;
      };
      const spec = appPkg.dependencies?.["@earendil-works/pi-coding-agent"];
      bundledPiVersionCache = typeof spec === "string" ? parseVersion(spec) : null;
    } catch {
      /* best effort */
    }
  }
  return bundledPiVersionCache;
}

// --- Presence / probing -----------------------------------------------------

/** 「本机 pi 在不在」的三态（决策 6）：超时是 `unverified`，不是 `absent`。 */
export type PiPresence = "present" | "unverified" | "absent";

// Detection spawns child processes that BLOCK the main process: where.exe,
// node --version, and especially `pi --version` (~1.1s on Windows — it boots
// the whole pi CLI). These are environment facts that don't change during the
// app's lifetime; the session-click path (tab:create → ensurePiReady →
// resolvePiBin) used to pay 3-4 sync spawns before the pty even spawned.
// Cache the results and warm them at startup (see warm).
let cachedNodeOk: boolean | null = null;
let cachedPiOk: boolean | null = null;
/** True when the last authoritative probe did not finish inside
 *  DETECT_SPAWN_TIMEOUT_MS. A timeout is INCONCLUSIVE, not "pi is missing" —
 *  see present. */
let cachedPiTimedOut = false;
/** When the last authoritative (sync) pi probe ran; used to throttle the
 *  re-verification of a cached false (a transient failure must self-heal,
 *  but a genuinely missing pi shouldn't block the main thread every click). */
let cachedPiCheckAt: number | null = null;
const PI_RECHECK_TTL_MS = 5000;

/** Reset the detection caches (after auto-installing pi, so the freshly
 *  installed binary is picked up instead of the stale failure). */
export function invalidate(): void {
  cachedPiBin = undefined;
  cachedNodeBin = undefined;
  cachedNodeOk = null;
  cachedPiOk = null;
  cachedPiCheckAt = null;
  cachedPiTimedOut = false;
}

function nodeInstalled(): boolean {
  if (cachedNodeOk !== null) return cachedNodeOk;
  const nodeBin = findExe("node.exe", nodeFallbacks());
  const result = spawnSync(nodeBin, ["--version"], { stdio: "pipe", windowsHide: true, timeout: DETECT_SPAWN_TIMEOUT_MS });
  cachedNodeOk = !result.error && result.status === 0;
  return cachedNodeOk;
}

/** Async version probe (the sync `pi --version` blocks ~1.1s on Windows). */
function spawnVersionProbe(piBin: string): ChildProcess {
  const child = /\.cmd$/i.test(piBin)
    ? spawn("cmd.exe", ["/d", "/c", piBin.replace(/\//g, "\\"), "--version"], { stdio: "ignore", windowsHide: true })
    : spawn(piBin, ["--version"], { stdio: "ignore", windowsHide: true });
  // The warm probe used to have no kill timer: a hung `pi --version` leaked a
  // child process and left cachedPiOk null forever, so every later click paid
  // the authoritative SYNC probe (the 1.1s main-thread freeze this cache
  // exists to avoid).
  const killTimer = setTimeout(() => child.kill(), DETECT_SPAWN_TIMEOUT_MS);
  child.once("exit", () => clearTimeout(killTimer));
  child.once("error", () => clearTimeout(killTimer));
  return child;
}

/** Compute the detection caches in the background (best-effort, no dialogs).
 *  The cheap spawns (where.exe, node --version, ~100ms total) run sync;
 *  `pi --version` boots the whole pi CLI (~1.1s) so it is probed with an
 *  async spawn — the main process never blocks, and by the time the user
 *  clicks a session the cache is warm (zero spawns on the click path). */
export function warm(): void {
  try {
    findPiBin();
    nodeInstalled();
  } catch {
    /* detection is best-effort; ensurePiReady surfaces real problems */
  }
  const piBin = cachedPiBin?.bin;
  if (!piBin) return;
  const child = spawnVersionProbe(piBin);
  // Cache ONLY the success: a transient probe failure must NOT poison the
  // cache — leave it null so the next present() runs the authoritative sync
  // probe on demand (the click path pays ~1.1s only when the warm probe failed).
  child.once("exit", (code) => {
    if (code === 0) cachedPiOk = true;
  });
  child.once("error", () => {
    /* keep cachedPiOk = null → sync re-check on demand */
  });
}

function runPiVersion(piBin: string) {
  // Preferred: shim → cli.js → node.exe directly (= what a terminal does when
  // you run `pi`). Bypasses cmd.exe /c quoting entirely.
  const cli = resolveCliJsFromShim(piBin);
  const nodeBin = findExe("node.exe", nodeFallbacks());
  if (cli && nodeBin) {
    return spawnSync(nodeBin, [cli, "--version"], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
      timeout: DETECT_SPAWN_TIMEOUT_MS,
    });
  }
  // Fallback: run the shim/binary directly as before.
  if (/\.cmd$/i.test(piBin)) {
    const escaped = piBin.replace(/\//g, "\\");
    return spawnSync("cmd.exe", ["/d", "/c", escaped, "--version"], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
      timeout: DETECT_SPAWN_TIMEOUT_MS,
    });
  }
  return spawnSync(piBin, ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout: DETECT_SPAWN_TIMEOUT_MS,
  });
}

/** 权威探测（同步、有上限）：`present()` 的唯一事实来源，也是诊断的全部内容。 */
function probeSync(): {
  ok: boolean;
  timedOut: boolean;
  piBin: string;
  piEnv: string | undefined;
  status: number | null;
  error?: string;
  stdout: string;
  stderr: string;
} {
  const piBin = findPiBin().bin;
  const result = runPiVersion(piBin);
  return {
    ok: !result.error && result.status === 0,
    timedOut: isSpawnTimeout(result),
    piBin,
    piEnv: process.env.PI_CODING_AGENT,
    status: result.status,
    error: result.error?.message,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * 本机 pi 在不在。三态而不是布尔，因为「探测超时」既不能算缺失也不能算证明
 * 在场：调用方（`ensurePiReady`）把缺失读成「用捆绑副本重装」，那会把用户用
 * `pi update` 保持最新的全局 pi 悄悄降级 —— 所以超时报告 `unverified`，让
 * 最坏情况只是每个窗口一次有界冻结。
 */
export function present(): PiPresence {
  if (cachedPiOk === true) return "present";
  // A cached FALSE must not be trusted blindly: the warm async probe can
  // fail transiently (startup load, AV scan, slow CLI boot) and would
  // otherwise poison the cache for the whole session — every local tab would
  // then claim "pi not found". Re-verify with the authoritative sync probe,
  // throttled so a genuinely-missing pi doesn't block the main thread on
  // every click.
  if (cachedPiOk === false && cachedPiCheckAt !== null && Date.now() - cachedPiCheckAt < PI_RECHECK_TTL_MS) {
    return "absent";
  }
  if (cachedPiTimedOut && cachedPiCheckAt !== null && Date.now() - cachedPiCheckAt < PI_RECHECK_TTL_MS) {
    return "unverified";
  }
  cachedPiCheckAt = Date.now();
  const probe = probeSync();
  cachedPiTimedOut = probe.timedOut;
  if (probe.timedOut) {
    cachedPiOk = null;
    debugLog("probe", `pi --version timed out after ${DETECT_SPAWN_TIMEOUT_MS}ms (${probe.piBin}) — assuming present, unverified`);
    return "unverified";
  }
  cachedPiOk = probe.ok;
  return cachedPiOk ? "present" : "absent";
}
