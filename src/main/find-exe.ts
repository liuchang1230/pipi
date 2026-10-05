/**
 * 「这台 Windows 机器上某个可执行文件在哪」——纯查找，没有领域知识。
 *
 * 这一层从 `pty.ts` 搬出来是因为它有两个消费者：`local-pi.ts`（pi / node）与
 * `pty.ts`（ssh / wsl / npm / shell）。留在一个文件里会逼出「谁 import 谁」的
 * 反向依赖（`local-pi` 需要 `pty` 的查找函数，而 `pty` 又需要 `local-pi` 的解析）。
 * 它不认识 pi，也不认识 Target，只有 PATH 与常见安装位置。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Hard cap for every detection spawn (where.exe / node --version / pi --version).
 *  These run on the tab:create click path, so an unbounded child means an
 *  unbounded main-process freeze: the whole app (every IPC, every terminal
 *  stream) stops until the child exits. A timed-out probe reports "not
 *  detected"; the re-check TTL in local-pi lets a transient timeout self-heal
 *  instead of poisoning the cache for the rest of the session. */
export const DETECT_SPAWN_TIMEOUT_MS = 10_000;

/** spawnSync reports hitting its own `timeout` as an ETIMEDOUT error. */
export function isSpawnTimeout(result: { error?: unknown }): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

/** npm global dir (where `pi.cmd` / the pi package live). */
export function npmGlobalDir(): string {
  return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"), "npm");
}

/** Generic: find an executable's absolute path. */
export function findExe(name: string, commonFallbacks: string[]): string {
  // 1. process.execPath if it matches.
  if (process.execPath && process.execPath.toLowerCase().endsWith(name.toLowerCase())) {
    return process.execPath;
  }
  // 2. Search PATH.
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    const cand = join(dir, name);
    if (existsSync(cand)) return cand;
  }
  // 3. Common install locations.
  for (const c of commonFallbacks) {
    if (c && existsSync(c)) return c;
  }
  // 4. Fallback to bare name.
  return name.replace(/\.(exe|cmd)$/i, "");
}

/** findExe, but returns null instead of the bare-name fallback when missing. */
export function findExeOrNull(name: string, fallbacks: string[]): string | null {
  const found = findExe(name, fallbacks);
  const bare = name.replace(/\.(exe|cmd)$/i, "");
  return found === bare ? null : found;
}

export function findViaWhere(command: string): string | null {
  const result = spawnSync("where.exe", [command], { encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: DETECT_SPAWN_TIMEOUT_MS });
  if (result.error || result.status !== 0) return null;

  const candidates = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferred = candidates.find((line) => /\.(cmd|exe)$/i.test(line));
  return preferred || candidates[0] || null;
}
