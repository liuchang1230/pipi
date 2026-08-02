/**
 * Auto-follow: watch the active project's session directory and emit the
 * file path whenever pi's read/write/edit tool touches a file.
 *
 * Mechanism (no SDK, no terminal parsing):
 *  1. fs.watch the session dir for the active cwd.
 *  2. Track the most-recently-modified .jsonl (the active conversation).
 *  3. On each change, read only the newly-appended bytes (seek from last
 *     known size) and scan complete JSONL lines for toolCall entries whose
 *     name is read/write/edit — extract `arguments.path` and the tool kind.
 *  4. Emit each new {path, kind} event to the renderer (debounced).
 *
 * This survives pi updates as long as the JSONL format (type:"message" →
 * assistant content → toolCall block with arguments.path) stays stable.
 * If the format drifts (or the tool block shape changes), we count schema
 * anomalies and notify listeners so the UI can surface the degraded state
 * instead of failing silently. The state self-recovers if valid lines show
 * up again (e.g. the user switches back to a compatible session).
 */
import { watch, existsSync, statSync, readFileSync, readdirSync, FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { sessionDirFor } from "./session-list";

const FILE_TOOLS = new Set(["read", "write", "edit"]);

export type FollowKind = "read" | "write";

export interface FollowEvent {
  path: string;
  kind: FollowKind;
}

export interface FollowStatus {
  ok: boolean;
  reason?: string;
}

type PathListener = (ev: FollowEvent) => void;
type StatusListener = (status: FollowStatus) => void;

/** Schema anomalies accumulated since watch start; reaching this → degraded. */
const ANOMALY_THRESHOLD = 5;

interface WatchState {
  dir: string;
  watcher: FSWatcher;
  activeFile: string | null;
  activeSize: number; // bytes already consumed from activeFile
  debounceTimer: NodeJS.Timeout | null;
  anomalies: number; // schema anomalies seen since (last) degradation
  degraded: boolean;
}

let state: WatchState | null = null;
const listeners = new Set<PathListener>();
const statusListeners = new Set<StatusListener>();

/** Read appended lines from a file starting at `fromByte`. Returns {lines, newSize}. */
function readAppended(filePath: string, fromByte: number): { lines: string[]; newSize: number } {
  const st = statSync(filePath);
  const newSize = st.size;
  if (newSize <= fromByte) return { lines: [], newSize };
  const fd = readFileSync(filePath);
  const slice = fd.subarray(fromByte, newSize).toString("utf8");
  return { lines: slice.split("\n").filter((l) => l.trim()), newSize };
}

/**
 * Extract {path, kind} pairs from toolCall entries in a JSONL line.
 * Returns `anomaly: true` when the line parsed but no longer matches the
 * expected message/toolCall shape (a sign the pi format changed).
 */
function extractFromLine(line: string): { events: FollowEvent[]; anomaly: boolean } {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return { events: [], anomaly: false };
  }
  const msg = e as { type?: string; message?: { content?: unknown } } | null;
  if (msg?.type !== "message" || !msg.message) {
    // "message" type without a message object = schema drift.
    return { events: [], anomaly: msg?.type === "message" };
  }
  const content = msg.message.content;
  // content-less lines (e.g. bashExecution role messages) are legitimate —
  // only missing message objects or malformed toolCall blocks signal drift.
  if (!Array.isArray(content)) return { events: [], anomaly: false };
  let anomaly = false;
  const events: FollowEvent[] = [];
  for (const block of content as unknown[]) {
    const b = block as { type?: string; name?: string; arguments?: { path?: unknown } } | null;
    if (!b || b.type !== "toolCall") continue;
    if (typeof b.name !== "string" || !b.arguments) {
      anomaly = true; // toolCall block no longer shaped as expected
      continue;
    }
    if (!FILE_TOOLS.has(b.name)) continue;
    const p = b.arguments.path;
    if (typeof p === "string" && p) {
      events.push({ path: p, kind: b.name === "read" ? "read" : "write" });
    }
  }
  return { events, anomaly };
}

/** Find the most recently modified .jsonl in a directory. */
function mostRecentJsonl(dir: string): string | null {
  try {
    let best: { file: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dir, f);
      const m = statSync(full).mtimeMs;
      if (!best || m > best.mtime) best = { file: full, mtime: m };
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

/**
 * Seed: surface the last file the session touched without replaying the
 * whole history. Scans only the file tail for the last complete file event
 * and returns the file size so subsequent appends start from the end.
 */
function seedActiveFile(filePath: string): number {
  try {
    const st = statSync(filePath);
    if (st.size === 0) return 0;
    const tailBytes = Math.min(st.size, 64 * 1024);
    const fd = readFileSync(filePath);
    const tail = fd.subarray(st.size - tailBytes, st.size).toString("utf8");
    const lines = tail.split("\n");
    // Scan from the end; a partial last line (in-progress write) fails to
    // parse and is skipped. The LAST file event wins.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const { events } = extractFromLine(line);
      if (events.length > 0) {
        const last = events[events.length - 1];
        for (const l of listeners) l(last);
        return st.size;
      }
    }
    return st.size;
  } catch {
    return 0;
  }
}

/** Process changes: pick active file, read appended bytes, emit events. */
function processChange(seed = false) {
  if (!state) return;
  const dir = state.dir;
  // Debounce: coalesce rapid writes into one pass.
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    if (!state) return;
    const recent = mostRecentJsonl(dir);
    if (!recent) return;
    // If the active file changed (new session became most recent), reset offset.
    if (recent !== state.activeFile) {
      state.activeFile = recent;
      state.activeSize = 0;
    }
    if (seed) {
      // Resume hint only: tail-scan, never replay history or count anomalies.
      state.activeSize = seedActiveFile(state.activeFile);
      return;
    }
    const { lines, newSize } = readAppended(state.activeFile, state.activeSize);
    state.activeSize = newSize;
    let anomalies = 0;
    for (const line of lines) {
      const { events, anomaly } = extractFromLine(line);
      if (anomaly) anomalies++;
      for (const ev of events) {
        for (const l of listeners) l(ev);
      }
    }
    if (anomalies > 0) state.anomalies += anomalies;
    if (!state.degraded && state.anomalies >= ANOMALY_THRESHOLD) {
      state.degraded = true;
      state.anomalies = 0; // fresh counter so recovery detection is clean
      const reason = "会话日志格式与预期不符（工具调用结构变化），自动跟随已失效";
      console.warn("[auto-follow] degraded:", reason);
      for (const l of statusListeners) l({ ok: false, reason });
    } else if (state.degraded && anomalies === 0 && lines.length > 0) {
      // Valid lines again — the format (or the active session) is compatible.
      state.degraded = false;
      state.anomalies = 0;
      for (const l of statusListeners) l({ ok: true });
    }
  }, 150);
}

/** Start watching a cwd's session directory. Switches if already watching. */
export function startWatching(cwd: string): void {
  stopWatching();
  const dir = sessionDirFor(cwd);
  if (!existsSync(dir)) {
    // No sessions for this project yet — pi creates the session dir lazily.
    // Watch the parent and re-arm as soon as the dir appears.
    const parent = dirname(dir);
    try {
      const watcher = watch(parent, { persistent: false }, () => {
        if (existsSync(dir)) startWatching(cwd);
      });
      state = { dir, watcher, activeFile: null, activeSize: 0, debounceTimer: null, anomalies: 0, degraded: false };
    } catch {
      /* permission errors etc. — auto-follow silently disabled */
    }
    return;
  }
  try {
    const watcher = watch(dir, { persistent: false }, () => processChange());
    state = { dir, watcher, activeFile: null, activeSize: 0, debounceTimer: null, anomalies: 0, degraded: false };
    // Seed: show the last-read file so resuming a session immediately
    // displays the file pi was working on (tail-scan, debounced like normal
    // changes so the renderer has time to subscribe).
    const recent = mostRecentJsonl(dir);
    if (recent) {
      state.activeFile = recent;
      processChange(true);
    }
  } catch {
    /* permission errors etc. — auto-follow silently disabled */
  }
}

/** Stop watching. */
export function stopWatching(): void {
  if (state) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    try {
      state.watcher.close();
    } catch {
      /* */
    }
    state = null;
  }
}

/** Subscribe to follow events. Returns an unsubscribe function. */
export function onFilePath(listener: PathListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to degraded/recovered status changes. Returns an unsubscribe function. */
export function onStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}
