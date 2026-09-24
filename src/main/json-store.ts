/**
 * json-store.ts — atomic, recoverable persistence for user data.
 *
 * Two failure modes this removes, both of which destroyed data silently:
 *
 * 1. **Torn writes.** Every config file was written with a plain
 *    `writeFileSync(path, JSON.stringify(...))`. A crash, power loss or an
 *    antivirus/indexer touching the file mid-write leaves a half-written JSON —
 *    and the readers answered that with `return []`, i.e. the user's projects,
 *    models and remote history silently became empty. Writes now go to a temp
 *    file that is fsynced and then renamed over the target, so a reader only
 *    ever sees the old file or the new one.
 *
 * 2. **Read-modify-write over a corrupt file.** Once a read returns the
 *    fallback, the next `add` writes fallback+new — the data is GONE. So a file
 *    that failed to read is **write-blocked** for the session: the write is
 *    refused with an explanation instead of overwriting something the user may
 *    still be able to recover from the `.corrupt-*` copy we keep.
 *
 * Every corruption is reported (see `onCorruptReport`) rather than swallowed —
 * "my projects disappeared" must never be an unexplained event.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface CorruptFileReport {
  file: string;
  /** Where the unreadable content was preserved ("" when it could not be moved). */
  backupPath: string;
  reason: string;
  at: number;
}

export interface ReadResult<T> {
  value: T;
  /** Present only when the stored file could not be used. */
  report?: CorruptFileReport;
}

const corruptReports: CorruptFileReport[] = [];
const writeBlocked = new Set<string>();
const listeners = new Set<(report: CorruptFileReport) => void>();

export function onCorruptReport(listener: (report: CorruptFileReport) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reports discovered so far, and forget which ones were returned. */
export function drainCorruptReports(): CorruptFileReport[] {
  return corruptReports.splice(0, corruptReports.length);
}

/** True when the file failed to read, so writing it would overwrite good data. */
export function isWriteBlocked(file: string): boolean {
  return writeBlocked.has(file);
}

export function resetJsonStoreForTests(): void {
  corruptReports.length = 0;
  writeBlocked.clear();
  listeners.clear();
}

export function corruptBackupPath(file: string, now = Date.now()): string {
  return `${file}.corrupt-${now}`;
}

export function backupPathFor(file: string): string {
  return `${file}.bak`;
}

function blockAndReport(file: string, reason: string, moveAside: boolean): CorruptFileReport {
  let backupPath = "";
  if (moveAside) {
    const candidate = corruptBackupPath(file);
    try {
      renameSync(file, candidate);
      backupPath = candidate;
    } catch {
      /* the file may be locked; blocking the write is still the safe outcome */
    }
  }
  writeBlocked.add(file);
  const report: CorruptFileReport = { file, backupPath, reason, at: Date.now() };
  corruptReports.push(report);
  for (const listener of listeners) {
    try {
      listener(report);
    } catch {
      /* a broken listener must not break persistence */
    }
  }
  return report;
}

/**
 * Write JSON so that readers never observe a partial file: temp → fsync →
 * rename (with retries, because a scanner or indexer can hold the target open
 * on Windows). Keeps one `.bak` of the previous content.
 */
export function writeJsonAtomic(file: string, data: unknown, opts: { mode?: number; backup?: boolean } = {}): void {
  if (writeBlocked.has(file)) {
    throw new Error(
      `配置文件已损坏，为避免覆盖你的数据，本次写入被拒绝：${file}（备份在 ${corruptBackupPath(file, 0).replace(/\d+$/, "*")}）`,
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (opts.mode !== undefined) {
    try {
      chmodSync(tmp, opts.mode);
    } catch {
      /* best effort (Windows ignores most modes) */
    }
  }
  if (opts.backup !== false && existsSync(file)) {
    try {
      copyFileSync(file, backupPathFor(file));
    } catch {
      /* a missing backup must not block the write */
    }
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* nothing to clean up */
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Read JSON, surviving corruption: keeps the unreadable content as
 * `.corrupt-<ts>`, blocks future writes to that path, reports what happened and
 * returns the fallback so the app still starts.
 */
export function readJsonRecoverable<T>(
  file: string,
  fallback: T,
  validate?: (raw: unknown) => T | null,
): ReadResult<T> {
  if (!existsSync(file)) return { value: fallback };

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // Present but unreadable (locked / permissions): we cannot prove it is
    // damaged, but a read-modify-write would replace it, so block writes too.
    const reason = `无法读取：${error instanceof Error ? error.message : String(error)}`;
    return { value: fallback, report: blockAndReport(file, reason, false) };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    const value = validate ? validate(parsed) : (parsed as T);
    if (value === null) throw new Error("内容结构不符合预期");
    return { value };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { value: fallback, report: blockAndReport(file, reason, true) };
  }
}
