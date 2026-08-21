/**
 * debug-log.ts — file-based diagnostic logging for remote RPC sessions.
 *
 * The dev terminal is the only console today, which is invisible when the
 * app is driven by the user. Remote-tree debugging (why get_tree never
 * answers on one server) needs the full RPC chain on disk: spawn → send →
 * bytes → response → renderer action. This module appends tagged, timestamped
 * lines to <userData>/pipi-debug.log. Logging must never break the app, so
 * every failure is swallowed.
 */
import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let logPath: string | null = null;

export function debugLog(tag: string, msg: string): void {
  try {
    if (!logPath) {
      const dir = app.getPath("userData");
      mkdirSync(dir, { recursive: true });
      logPath = join(dir, "pipi-debug.log");
    }
    appendFileSync(logPath, `${new Date().toISOString()} [${tag}] ${msg}\n`);
  } catch {
    /* logging must never break the app */
  }
}
