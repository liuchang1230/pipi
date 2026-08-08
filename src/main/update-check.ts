/**
 * pi 及扩展更新检查（RPC 聊天模式没有 TUI 的 "Update Available" 横幅，
 * 由 app 层补齐）：启动时异步对比本地版本与 npm registry 最新版，
 * 有新版则提示；一键执行 `pi update`（pi 自身 + 扩展包一起更新）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { getGlobalPiBin } from "./pty";

const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest";

export interface UpdateInfo {
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  error?: string;
}

export interface UpdateRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

let cached: UpdateInfo | null = null;
let lastCheckedAt = 0;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // re-check at most every 6h

function parseVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Semver-ish compare: "0.84.1" > "0.84.0". Returns 1/0/-1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (x !== 0) return Math.sign(x);
  }
  return 0;
}

function resolveNodeBin(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, "node.exe");
    if (existsSync(cand)) return cand;
  }
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveCliJs(): string | null {
  const piBin = getGlobalPiBin();
  if (/\.cmd$/i.test(piBin)) {
    try {
      const content = readFileSync(piBin, "utf8");
      const m = content.match(/"([^"]*cli\.js)"/i);
      if (m && existsSync(m[1]!)) return m[1];
    } catch {
      /* fall through */
    }
    const cand = join(dirname(piBin), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (existsSync(cand)) return cand;
  }
  return null;
}

function runPi(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const nodeBin = findNodeBinForSpawn();
    let child;
    if (nodeBin && resolveCliJs()) {
      child = spawn(nodeBin, [resolveCliJs()!, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      const piBin = getGlobalPiBin().replace(/\//g, "\\");
      child = spawn("cmd.exe", ["/d", "/c", `"${piBin}"`, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* */
      }
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function findNodeBinForSpawn(): string | null {
  return resolveNodeBin();
}

async function getLocalPiVersion(): Promise<string | null> {
  try {
    const { stdout } = await runPi(["--version"], 20000);
    return parseVersion(stdout.split(/\r?\n/)[0]);
  } catch {
    return null;
  }
}

async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return parseVersion(data.version);
  } catch {
    return null;
  }
}

/** Check for a pi update (cached; async, never throws). */
export async function checkPiUpdate(force = false): Promise<UpdateInfo> {
  if (!force && cached && Date.now() - lastCheckedAt < CHECK_TTL_MS) return cached;
  const [current, latest] = await Promise.all([getLocalPiVersion(), getLatestVersion()]);
  const info: UpdateInfo = {
    current,
    latest,
    hasUpdate: !!(current && latest && compareVersions(latest, current) > 0),
  };
  if (!latest) info.error = "无法连接 npm registry";
  cached = info;
  lastCheckedAt = Date.now();
  console.log(`[update] pi ${current ?? "?"} → latest ${latest ?? "?"}${info.hasUpdate ? " (update available)" : ""}`);
  return info;
}

/** Run `pi update` (pi itself + extension packages). */
export async function runPiUpdate(): Promise<UpdateRunResult> {
  try {
    const { code, stdout, stderr } = await runPi(["update"], 300000);
    const output = (stdout + "\n" + stderr).trim();
    const ok = code === 0;
    // Invalidate the cached check so the next check reflects the new version.
    cached = null;
    return { ok, output: output.slice(-2000) };
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }
}
