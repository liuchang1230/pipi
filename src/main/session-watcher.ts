/**
 * Auto-follow: watch the active project's session directory and emit the
 * file path whenever pi's read/write/edit tool touches a file.
 *
 * Mechanism (no SDK, no terminal parsing):
 *  1. fs.watch the session dir for the active cwd.
 *  2. Track the most-recently-modified .jsonl (the active conversation).
 *  3. On each change, read only the newly-appended bytes (seek from last
 *     consumed offset, capped per pass) and scan complete JSONL lines for
 *     toolCall entries whose name is read/write/edit — extract
 *     `arguments.path` and the tool kind.
 *  4. Emit each new {path, kind} event to the renderer (debounced).
 *
 * The read path is INCREMENTAL and never blocks the event loop:
 *  - `readAppended` is an async position read from the last consumed offset
 *    (fs.promises open + handle.read with a byte position) — no whole-file
 *    sync read on the pty's event loop, which is what used to make the
 *    terminal stutter whenever pi was actively writing files.
 *  - Each pass is capped (`APPEND_READ_CAP_BYTES`); a line that straddles a
 *    cap boundary is carried in `state.partial` until its newline lands, so
 *    no line is ever lost, duplicated, or split across parses — including
 *    single lines larger than the cap. Chunks are decoded with a
 *    `StringDecoder` so a multi-byte character never splits across passes.
 *  - Drains are single-flight (`draining` + `debouncedPending`): an fs.watch
 *    event during an in-flight pass is remembered and re-scheduled after the
 *    pass, so two passes can never read the same delta twice.
 *  - Every pass snapshots the state object and re-checks `state !== st` after
 *    each await, so a tab switch (state replacement) mid-pass aborts the
 *    stale pass instead of replaying the previous session against the new
 *    state's offsets.
 *  - The active-file scan (`mostRecentJsonl`) runs at most once per
 *    `ACTIVE_FILE_SCAN_TTL_MS`; between scans only the cached file is stat'd,
 *    so write bursts cost one stat instead of a full directory scan.
 *  - The resume seed (`seedActiveFile`) is protected by `state.seeding` so a
 *    watch event in the seed window can never convert the tail-scan hint into
 *    a full-history replay.
 *
 * This survives pi updates as long as the JSONL format (type:"message" →
 * assistant content → toolCall block with arguments.path) stays stable.
 * If the format drifts (or the tool block shape changes), we count schema
 * anomalies and notify listeners so the UI can surface the degraded state
 * instead of failing silently. The state self-recovers if valid lines show
 * up again (e.g. the user switches back to a compatible session).
 */
import { watch, existsSync, statSync, readdirSync, FSWatcher, promises as fsp } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { sessionDirFor } from "./session-list";

const FILE_TOOLS = new Set(["read", "write", "edit"]);

/** Max bytes read+parsed per pass — bounds the sync per-line JSON.parse cost. */
export const APPEND_READ_CAP_BYTES = 1024 * 1024;
/** Full dir scan at most this often; between scans only the cached file is stat'd. */
export const ACTIVE_FILE_SCAN_TTL_MS = 2000;
/** Coalesce rapid write bursts into one pass. */
const DEBOUNCE_MS = 150;
/** Delay for catch-up passes that know more bytes are pending. */
const FOLLOW_UP_MS = 10;
/** Seed/auto-follow tail scan window. */
const SEED_TAIL_BYTES = 64 * 1024;
/** A single line longer than this is dropped (pathological) to bound memory. */
const PARTIAL_MAX_BYTES = 8 * 1024 * 1024;

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
  partial: string; // incomplete trailing line carried across passes
  decoder: StringDecoder; // carries incomplete UTF-8 sequences across passes
  lastFullScanAt: number; // last time the whole dir was scanned for the active file
  debounceTimer: NodeJS.Timeout | null;
  seeding: boolean; // a resume seed is pending and must not be clobbered into a replay
  debouncedPending: boolean; // watch fired while a drain was in flight → re-drain after
  followUpFast: boolean; // next re-drain should use the short catch-up delay
  anomalies: number; // schema anomalies seen since (last) degradation
  degraded: boolean;
}

let state: WatchState | null = null;
let draining = false; // a drain pass is in flight (single-flight guard)
const listeners = new Set<PathListener>();
const statusListeners = new Set<StatusListener>();

/**
 * Read newly-appended bytes starting at `fromByte`, capped at
 * APPEND_READ_CAP_BYTES. Async position read — never blocks the event loop.
 * `statSize` is the file size at stat time; `bytes` is what was actually
 * read (shorter than the pending delta when capped, empty on shrink/no-growth).
 */
export async function readAppended(
  filePath: string,
  fromByte: number
): Promise<{ bytes: Buffer; statSize: number }> {
  const st = await fsp.stat(filePath);
  if (st.size <= fromByte) return { bytes: Buffer.alloc(0), statSize: st.size };
  const len = Math.min(st.size - fromByte, APPEND_READ_CAP_BYTES);
  const handle = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, fromByte);
    return { bytes: buf.subarray(0, bytesRead), statSize: st.size };
  } finally {
    await handle.close().catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Read the tail of a file (position read, max `maxBytes`). Used to seed the
 * last file event without replaying the whole history — a whole-file read
 * would stall the event loop on large session files.
 */
export async function readTail(filePath: string, maxBytes = SEED_TAIL_BYTES): Promise<{ text: string; size: number }> {
  const st = await fsp.stat(filePath);
  if (st.size === 0) return { text: "", size: 0 };
  const from = Math.max(0, st.size - maxBytes);
  const handle = await fsp.open(filePath, "r");
  try {
    const len = st.size - from;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, from);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), size: st.size };
  } finally {
    await handle.close().catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Pure delta splitter: prepend the carried partial line to a new chunk and
 * return the COMPLETE lines (through the last newline) plus the held partial.
 * A line that straddles a read boundary stays in `partial` until its newline
 * arrives — never lost, never duplicated, never parsed half.
 */
export function splitDelta(partial: string, chunk: string): { complete: string; partial: string } {
  const text = partial + chunk;
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { complete: "", partial: text };
  return { complete: text.slice(0, lastNl + 1), partial: text.slice(lastNl + 1) };
}

/**
 * Choose the active .jsonl for a cwd's session dir.
 *
 * Hot-path rule: a write burst must not pay a full directory scan. If the
 * cached candidate still exists and the TTL hasn't expired, stat only that
 * one file and reuse it; the full scan (new-session detection) runs at most
 * once per TTL. Clock injected for tests.
 */
export function pickActiveJsonl(
  dir: string,
  cached: { path: string } | null,
  lastFullScanAt: number,
  now: number,
  ttlMs = ACTIVE_FILE_SCAN_TTL_MS
): { path: string; scanned: boolean } | null {
  if (cached) {
    try {
      statSync(cached.path); // still exists?
      if (now - lastFullScanAt < ttlMs) return { path: cached.path, scanned: false };
    } catch {
      /* cached file gone → full scan below */
    }
  }
  const best = mostRecentJsonl(dir);
  if (!best) return null;
  return { path: best, scanned: true };
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

/** Find the most recently modified .jsonl in a directory (full scan). */
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
 * whole history. Reads only the file tail (position read) and returns the
 * file size so subsequent appends start from the end. On failure, falls back
 * to a best-effort stat so the offset stays honest (never 0 → replay).
 */
async function seedActiveFile(filePath: string): Promise<number> {
  try {
    const { text, size } = await readTail(filePath);
    if (size === 0) return 0;
    const lines = text.split("\n");
    // Scan from the end; a partial last line (in-progress write) fails to
    // parse and is skipped. The LAST file event wins.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const { events } = extractFromLine(line);
      if (events.length > 0) {
        const last = events[events.length - 1];
        for (const l of listeners) l(last);
        return size;
      }
    }
    return size;
  } catch {
    try {
      return (await fsp.stat(filePath)).size; // file may have just vanished
    } catch {
      return 0;
    }
  }
}

/** Debounced, single-flight drain scheduling. */
function scheduleDrain(seed = false, delay = DEBOUNCE_MS): void {
  if (!state) return;
  if (seed) state.seeding = true; // a pending seed must stay a seed
  if (draining) {
    // A pass is in flight; it re-checks for pending work when it finishes.
    state.debouncedPending = true;
    return;
  }
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => void runDrain(), delay);
}

async function runDrain(): Promise<void> {
  if (!state) return;
  draining = true;
  try {
    const st = state;
    const isSeed = st.seeding;
    st.seeding = false;
    await drainChanges(st, isSeed);
  } catch (error) {
    console.error("[auto-follow] drain failed:", error instanceof Error ? error.message : String(error));
    if (state) state.partial = "";
  } finally {
    draining = false;
    // Pick up anything that arrived while the pass was in flight.
    if (state?.debouncedPending) {
      state.debouncedPending = false;
      const fast = state.followUpFast;
      state.followUpFast = false;
      scheduleDrain(false, fast ? FOLLOW_UP_MS : DEBOUNCE_MS);
    }
  }
}

/**
 * One drain pass: pick the active file, read its pending delta (capped,
 * async), split complete lines via the carried partial, emit follow events.
 * When the delta was capped, a fast follow-up pass is scheduled until caught
 * up. `st` is the state snapshot — every await re-checks `state === st` so a
 * tab switch (state replacement) aborts the stale pass cleanly.
 */
async function drainChanges(st: WatchState, seed: boolean): Promise<void> {
  try {
    const pick = pickActiveJsonl(
      st.dir,
      st.activeFile ? { path: st.activeFile } : null,
      st.lastFullScanAt,
      Date.now()
    );
    if (!pick) return;
    if (state !== st) return; // watcher replaced (tab switch) mid-pass
    if (pick.scanned) st.lastFullScanAt = Date.now();
    if (pick.path !== st.activeFile) {
      // New session became most recent → reset offset (no replay).
      st.activeFile = pick.path;
      st.activeSize = 0;
      st.partial = "";
      st.decoder = new StringDecoder("utf8");
    }
    if (seed) {
      st.activeSize = await seedActiveFile(st.activeFile);
      if (state !== st) return;
      st.partial = "";
      st.decoder = new StringDecoder("utf8");
      return;
    }
    let anomalies = 0;
    let linesSeen = 0;
    let capped = false;
    const emitBlock = (block: string): void => {
      for (const line of block.split("\n").filter((l) => l.trim())) {
        linesSeen++;
        const { events, anomaly } = extractFromLine(line);
        if (anomaly) anomalies++;
        for (const ev of events) {
          for (const l of listeners) {
            try {
              l(ev);
            } catch (error) {
              // A throwing listener must not stall the drain or cause the
              // same block to re-emit on every retry.
              console.error("[auto-follow] listener error:", error instanceof Error ? error.message : String(error));
            }
          }
        }
      }
    };
    for (;;) {
      if (state !== st) return; // watcher replaced mid-pass
      const fromByte = st.activeSize;
      const { bytes, statSize } = await readAppended(st.activeFile, fromByte);
      if (state !== st) return;
      if (bytes.length === 0) {
        // Shrunk or unchanged: reset to the current size (compaction etc.).
        st.activeSize = statSize;
        st.partial = "";
        st.decoder = new StringDecoder("utf8");
        break;
      }
      const consumed = fromByte + bytes.length;
      capped = statSize > consumed;
      const { complete, partial } = splitDelta(st.partial, st.decoder.write(bytes));
      if (complete) emitBlock(complete);
      st.partial = partial;
      if (st.partial.length > PARTIAL_MAX_BYTES) {
        // Pathological: a single line longer than we buffer. Drop it so the
        // watcher keeps following subsequent lines (bounded memory).
        st.partial = "";
      }
      st.activeSize = consumed;
      if (capped) {
        st.followUpFast = true;
        scheduleDrain(); // continue catching up on a fast follow-up pass
        break;
      }
      if (statSize <= consumed) break;
      // File grew between stat and read — loop to read the rest.
    }
    // Best-effort: a complete final line often lacks a trailing newline —
    // parse the held partial once at EOF; hold it only while it doesn't parse.
    if (!capped && st.partial.trim()) {
      const trimmed = st.partial.trim();
      let parsed = false;
      try {
        JSON.parse(trimmed);
        parsed = true;
      } catch {
        /* incomplete — keep buffering until the line completes */
      }
      if (parsed) {
        emitBlock(trimmed);
        st.partial = "";
      }
    }
    if (state !== st) return;
    if (anomalies > 0) st.anomalies += anomalies;
    if (!st.degraded && st.anomalies >= ANOMALY_THRESHOLD) {
      st.degraded = true;
      st.anomalies = 0; // fresh counter so recovery detection is clean
      const reason = "会话日志格式与预期不符（工具调用结构变化），自动跟随已失效";
      console.warn("[auto-follow] degraded:", reason);
      for (const l of statusListeners) l({ ok: false, reason });
    } else if (st.degraded && anomalies === 0 && linesSeen > 0) {
      // Valid lines again — the format (or the active session) is compatible.
      st.degraded = false;
      st.anomalies = 0;
      for (const l of statusListeners) l({ ok: true });
    }
  } catch (error) {
    console.error("[auto-follow] drain failed:", error instanceof Error ? error.message : String(error));
    // Leave the offset where it is; the next watch event retries cleanly.
    if (state) state.partial = "";
  }
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
      state = {
        dir,
        watcher,
        activeFile: null,
        activeSize: 0,
        partial: "",
        decoder: new StringDecoder("utf8"),
        lastFullScanAt: 0,
        debounceTimer: null,
        seeding: false,
        debouncedPending: false,
        followUpFast: false,
        anomalies: 0,
        degraded: false,
      };
    } catch {
      /* permission errors etc. — auto-follow silently disabled */
    }
    return;
  }
  try {
    const watcher = watch(dir, { persistent: false }, () => scheduleDrain());
    state = {
      dir,
      watcher,
      activeFile: null,
      activeSize: 0,
      partial: "",
      decoder: new StringDecoder("utf8"),
      lastFullScanAt: 0,
      debounceTimer: null,
      seeding: false,
      debouncedPending: false,
      followUpFast: false,
      anomalies: 0,
      degraded: false,
    };
    // Seed: show the last-read file so resuming a session immediately
    // displays the file pi was working on (tail-scan, debounced like normal
    // changes so the renderer has time to subscribe).
    const recent = mostRecentJsonl(dir);
    if (recent) {
      state.activeFile = recent;
      state.lastFullScanAt = Date.now();
      scheduleDrain(true);
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
