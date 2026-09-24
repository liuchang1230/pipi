/**
 * debug-log.ts — file-based diagnostic logging for the whole app.
 *
 * One tagged, timestamped line per event, appended to
 * `<userData>/pipi-debug.log`. Logging must never break the app: every failure
 * is swallowed.
 *
 * ## Levels
 *
 * `PIPI_LOG=debug|info|warn|error` (default `info`) selects the minimum level.
 * The default level is chosen so that the log is a record of *what mattered*,
 * not of every byte: per-message RPC frames, 3s tree polls and other
 * high-frequency repetition are `debug`, while lifecycle, failures, slow
 * operations and warnings are `info`+. Measured on a real log, the old
 * always-on firehose was 11.4MB / ~130k lines, of which 41% was per-message
 * RPC frames and 35% was one dialog's poll loop — the signal was in there, but
 * buried.
 *
 * ## Why the writes are batched
 *
 * `appendFileSync` per line put a synchronous disk write on the event loop for
 * *every* logged event (including the per-message and per-poll lines above) —
 * i.e. the diagnostic tool made the lag it was meant to explain. Writes for
 * `info`/`debug` are now buffered and flushed with an async `appendFile`;
 * `warn`/`error` (and anything that may precede a crash) still hit the disk
 * synchronously, so a crash right after a warning keeps its evidence.
 *
 * The buffer is bounded: if the disk cannot keep up, the OLDEST lines are
 * dropped and the loss is stated in the log rather than growing memory.
 *
 * ## Rotation
 *
 * 8MB per file, `pipi-debug.log.1 … .3`. Checked at open and after every 2MB
 * written, so a long-running session cannot grow the file without bound.
 */
import { app } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

/** Higher = more severe. `shouldLog` compares against the configured minimum. */
const LEVEL_ORDER: Record<LogLevel, number> = { error: 3, warn: 2, info: 1, debug: 0 };

export const MAX_LOG_BYTES = 8 * 1024 * 1024;
export const KEEP_LOG_FILES = 3;
const FLUSH_MS = 200;
const MAX_BUFFER_LINES = 4000;
const ROTATE_CHECK_BYTES = 2 * 1024 * 1024;

function parseLevel(value: string | undefined): LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug" ? value : "info";
}

let minLevel: LogLevel = parseLevel(process.env.PIPI_LOG);
let logPath: string | null = null;
let buffer: string[] = [];
let dropped = 0;
let timer: NodeJS.Timeout | null = null;
let flushing = false;
let writtenSinceCheck = 0;

/** Discard everything buffered so far (shutdown, tests). */
export function flushLog(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (buffer.length === 0) return;
  writeSync(takeBuffer());
}

/** Minimum level to record; exposed for tests and for `PIPI_LOG`. */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

/** Info line, batched. The default for call sites that do not care about levels. */
export function debugLog(tag: string, msg: string): void {
  debugLogAt("info", tag, msg);
}

/** High-frequency repetition (per-message frames, poll loops): hidden unless PIPI_LOG=debug. */
export function debugLogDebug(tag: string, msg: string): void {
  debugLogAt("debug", tag, msg);
}

/** Degraded/abnormal: written immediately, so it survives a crash right after. */
export function debugLogWarn(tag: string, msg: string): void {
  debugLogAt("warn", tag, msg);
}

/** A failure the user would care about: written immediately. */
export function debugLogError(tag: string, msg: string): void {
  debugLogAt("error", tag, msg);
}

export function debugLogAt(level: LogLevel, tag: string, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = `${new Date().toISOString()} [${tag}] ${msg}\n`;
  if (buffer.length >= MAX_BUFFER_LINES) {
    buffer.shift();
    dropped += 1;
  }
  buffer.push(entry);
  if (level === "error" || level === "warn") {
    flushLog();
    return;
  }
  schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushAsync();
  }, FLUSH_MS);
  // Never keep the process alive just to flush a log line.
  timer.unref?.();
}

function takeBuffer(): string {
  let text = buffer.join("");
  if (dropped > 0) {
    text = `${new Date().toISOString()} [log] ${dropped} 行因写入滞后被丢弃\n${text}`;
    dropped = 0;
  }
  buffer = [];
  return text;
}

async function flushAsync(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const text = takeBuffer();
  const file = logFilePath();
  try {
    await appendFile(file, text);
    writtenSinceCheck += text.length;
    rotateIfGrown(file);
  } catch {
    /* logging must never break the app */
  }
  flushing = false;
  if (buffer.length > 0) schedule();
}

function writeSync(text: string): void {
  try {
    const file = logFilePath();
    appendFileSync(file, text);
    writtenSinceCheck += text.length;
    rotateIfGrown(file);
  } catch {
    /* logging must never break the app */
  }
}

function logFilePath(): string {
  if (logPath) return logPath;
  const dir = app.getPath("userData");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* exists, or unwritable — the append below will fail and be swallowed */
  }
  logPath = join(dir, "pipi-debug.log");
  try {
    if (statSync(logPath).size >= MAX_LOG_BYTES) rotateFiles(logPath, KEEP_LOG_FILES);
  } catch {
    /* no file yet */
  }
  return logPath;
}

function rotateIfGrown(file: string): void {
  if (writtenSinceCheck < ROTATE_CHECK_BYTES) return;
  writtenSinceCheck = 0;
  try {
    if (statSync(file).size >= MAX_LOG_BYTES) rotateFiles(file, KEEP_LOG_FILES);
  } catch {
    /* file vanished (rotated/removed) — the next append recreates it */
  }
}

/**
 * Shift `base` → `base.1` → `base.2` … keeping `keep` old files.
 *
 * Renames can legitimately fail (AV scanner or indexer holding the handle);
 * that must never lose the current log, so a failed rotate is a no-op and the
 * app keeps appending to the existing file.
 */
export function rotateFiles(base: string, keep: number): void {
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${base}.${i}`, `${base}.${i + 1}`);
    } catch {
      /* that generation does not exist */
    }
  }
  try {
    renameSync(base, `${base}.1`);
  } catch {
    /* held open — keep appending to the current file */
  }
}

/** Test seam: forget the cached path/buffer/level so a temp dir can be used. */
export function resetLogForTests(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  buffer = [];
  dropped = 0;
  flushing = false;
  writtenSinceCheck = 0;
  logPath = null;
  minLevel = "info";
}
