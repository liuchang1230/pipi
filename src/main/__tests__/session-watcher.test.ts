// Auto-follow session watcher — incremental read path.
// Real temp files (no Electron); the reader/cache logic is exported for tests.
// The integration test watches a REAL temp session dir (homedir is mocked to
// a temp base so we never touch the user's actual ~/.pi).
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPEND_READ_CAP_BYTES,
  ACTIVE_FILE_SCAN_TTL_MS,
  pickActiveJsonl,
  readAppended,
  readTail,
  splitDelta,
  startWatching,
  stopWatching,
  onFilePath,
  type FollowEvent,
} from "../session-watcher";
import { sessionDirFor } from "../session-list";

// homedir is mocked to a temp base (hoisting-safe name). Session dirs then
// resolve under <base>/.pi/agent/sessions/<encoded-cwd> instead of the real
// user home, so the fs.watch integration test is fully sandboxed.
var mockHomedir = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir };
});

function makeSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "pipi-session-watcher-"));
}

/** A valid pi JSONL line whose toolCall touches `path`. */
function toolLine(path: string, kind: "read" | "write"): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: kind, arguments: { path } }],
    },
  });
}

function plainLine(): string {
  return JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });
}

afterEach(() => {
  stopWatching();
});

describe("readAppended", () => {
  it("reads only the appended bytes after the given offset", async () => {
    const dir = makeSessionDir();
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, toolLine("/a.txt", "write") + "\n");
      const first = await readAppended(file, 0);
      expect(first.bytes.toString("utf8")).toContain("/a.txt");
      expect(first.statSize).toBeGreaterThan(0);

      appendFileSync(file, toolLine("/b.txt", "read") + "\n");
      const second = await readAppended(file, first.statSize);
      expect(second.bytes.toString("utf8")).toContain("/b.txt");
      expect(second.bytes.toString("utf8")).not.toContain("/a.txt"); // no replay
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when there is nothing new at/behind the offset", async () => {
    const dir = makeSessionDir();
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, plainLine() + "\n");
      const size = statSync(file).size;
      const r = await readAppended(file, size);
      expect(r.bytes.length).toBe(0);
      expect(r.statSize).toBe(size);
      // Offset beyond the file → empty, statSize still reflects current size.
      const beyond = await readAppended(file, size + 100);
      expect(beyond.bytes.length).toBe(0);
      expect(beyond.statSize).toBe(size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps the read at APPEND_READ_CAP_BYTES and reports the full stat size", async () => {
    const dir = makeSessionDir();
    try {
      const file = join(dir, "big.jsonl");
      writeFileSync(file, "x".repeat(APPEND_READ_CAP_BYTES + 123) + "\n");
      const r = await readAppended(file, 0);
      expect(r.bytes.length).toBe(APPEND_READ_CAP_BYTES);
      expect(r.statSize).toBe(APPEND_READ_CAP_BYTES + 124); // +123 payload + newline
      // The remainder is still pending behind the cap offset.
      const rest = await readAppended(file, APPEND_READ_CAP_BYTES);
      expect(rest.bytes.length).toBe(124);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readTail", () => {
  it("reads only the tail window, never the whole file", async () => {
    const dir = makeSessionDir();
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, "y".repeat(200_000) + toolLine("/tail.txt", "write") + "\n");
      const { text, size } = await readTail(file, 4096);
      expect(size).toBeGreaterThan(200_000);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).toContain("/tail.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty for an empty file", async () => {
    const dir = makeSessionDir();
    try {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      const { text, size } = await readTail(file);
      expect(text).toBe("");
      expect(size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pickActiveJsonl", () => {
  it("reuses the cached file within the TTL without scanning", () => {
    const dir = makeSessionDir();
    try {
      const cachedPath = join(dir, "a.jsonl");
      writeFileSync(cachedPath, plainLine());
      const pick = pickActiveJsonl(dir, { path: cachedPath }, Date.now(), Date.now() + 1000);
      expect(pick?.path).toBe(cachedPath);
      expect(pick?.scanned).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rescans after the TTL and can switch to a newer file", () => {
    const dir = makeSessionDir();
    try {
      const oldPath = join(dir, "old.jsonl");
      writeFileSync(oldPath, plainLine());
      const oldMtime = statSync(oldPath).mtimeMs;
      const lastFullScanAt = Date.now();
      // TTL expired → full scan picks the only file; scanned=true.
      const first = pickActiveJsonl(dir, { path: oldPath }, lastFullScanAt, lastFullScanAt + ACTIVE_FILE_SCAN_TTL_MS + 1);
      expect(first?.scanned).toBe(true);
      expect(first?.path).toBe(oldPath);

      // A newer file appears; after another TTL the scan switches to it.
      const newPath = join(dir, "new.jsonl");
      writeFileSync(newPath, plainLine());
      const future = new Date(oldMtime + 10_000); // beat coarse mtime granularity
      utimesSync(newPath, future, future);
      const second = pickActiveJsonl(dir, { path: oldPath }, Date.now(), Date.now() + ACTIVE_FILE_SCAN_TTL_MS + 1);
      expect(second?.path).toBe(newPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rescans when the cached file disappeared", () => {
    const dir = makeSessionDir();
    try {
      writeFileSync(join(dir, "b.jsonl"), plainLine());
      const pick = pickActiveJsonl(dir, { path: join(dir, "gone.jsonl") }, Date.now(), Date.now() + 500);
      expect(pick?.path).toBe(join(dir, "b.jsonl"));
      expect(pick?.scanned).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the dir has no jsonl", () => {
    const dir = makeSessionDir();
    try {
      const pick = pickActiveJsonl(dir, null, 0, Date.now());
      expect(pick).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("splitDelta", () => {
  it("keeps a line that straddles read boundaries intact (no loss, no dup)", () => {
    // One line LONGER than the per-pass cap, fed in cap-sized chunks: the
    // line must emerge COMPLETE exactly once when its newline finally lands.
    const line =
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "write", arguments: { path: "/big.bin" } }],
          extra: "x".repeat(APPEND_READ_CAP_BYTES + 100), // make it > cap
        },
      }) + "\n";
    expect(line.length).toBeGreaterThan(APPEND_READ_CAP_BYTES);
    const chunks = [
      line.slice(0, APPEND_READ_CAP_BYTES),
      line.slice(APPEND_READ_CAP_BYTES),
    ];
    let partial = "";
    let complete = "";
    for (const c of chunks) {
      const r = splitDelta(partial, c);
      complete += r.complete;
      partial = r.partial;
    }
    // The line is longer than one chunk → it must have stayed in partial
    // until the final chunk brought its newline.
    expect(complete).toBe(line);
    expect(partial).toBe("");
  });

  it("holds a trailing incomplete line and completes it on the next chunk", () => {
    let partial = "";
    let r = splitDelta(partial, toolLine("/a.txt", "write").slice(0, 20));
    expect(r.complete).toBe("");
    partial = r.partial;
    r = splitDelta(partial, toolLine("/a.txt", "write").slice(20) + "\n" + toolLine("/b.txt", "read") + "\n");
    expect(r.complete).toContain("/a.txt");
    expect(r.complete).toContain("/b.txt");
    expect(r.partial).toBe("");
  });
});

// --- Integration: real fs.watch through startWatching/onFilePath ----------
describe("startWatching end-to-end", () => {
  it("emits {path, kind} when a toolCall line is appended", async () => {
    const base = mkdtempSync(join(tmpdir(), "pipi-watch-home-"));
    try {
      mockHomedir = base;
      const cwd = join(base, "work");
      const sessionDir = sessionDirFor(cwd); // <base>/.pi/agent/sessions/<encoded>
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "s-1.jsonl"), plainLine() + "\n");

      startWatching(cwd);
      // Let fs.watch arm, then append a toolCall line.
      await new Promise((r) => setTimeout(r, 100));
      appendFileSync(join(sessionDir, "s-1.jsonl"), toolLine("/appended.txt", "write") + "\n");

      const ev = await new Promise<FollowEvent | null>((resolve) => {
        const off = onFilePath((e) => {
          off();
          resolve(e);
        });
        setTimeout(() => {
          off();
          resolve(null);
        }, 2000); // debounce (150ms) + drain + watch latency
      });
      expect(ev).not.toBeNull();
      expect(ev?.path).toBe("/appended.txt");
      expect(ev?.kind).toBe("write");
    } finally {
      mockHomedir = "";
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("marks the one-time last-touched-file hint as a seed", async () => {
    const base = mkdtempSync(join(tmpdir(), "pipi-watch-home-"));
    try {
      mockHomedir = base;
      const cwd = join(base, "seed-project");
      const sessionDir = sessionDirFor(cwd);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "s-1.jsonl"), toolLine("/last-touched.txt", "write") + "\n");

      const seed = await new Promise<FollowEvent | null>((resolve) => {
        const off = onFilePath((event) => {
          off();
          resolve(event);
        });
        startWatching(cwd);
        setTimeout(() => {
          off();
          resolve(null);
        }, 2000);
      });

      expect(seed).toMatchObject({ path: "/last-touched.txt", kind: "write", seed: true });
    } finally {
      mockHomedir = "";
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not replay history when an append lands inside the seed window", async () => {
    const base = mkdtempSync(join(tmpdir(), "pipi-watch-home-"));
    try {
      mockHomedir = base;
      const cwd = join(base, "work3");
      const sessionDir = sessionDirFor(cwd);
      mkdirSync(sessionDir, { recursive: true });
      // Historical lines — replaying these on resume is exactly the bug.
      writeFileSync(join(sessionDir, "s-1.jsonl"), [
        toolLine("/old1.txt", "write"),
        toolLine("/old2.txt", "write"),
        toolLine("/old3.txt", "write"),
        "",
      ].join("\n"));

      const seen: string[] = [];
      const off = onFilePath((e) => seen.push(e.path));
      startWatching(cwd); // schedules the seed (150ms window)
      // Append DURING the seed window — must not convert the seed into a
      // full-history replay.
      appendFileSync(join(sessionDir, "s-1.jsonl"), toolLine("/new.txt", "write") + "\n");
      await new Promise((r) => setTimeout(r, 1800)); // seed + drain + watch latency
      off();

      expect(seen).toContain("/new.txt");
      expect(seen).not.toContain("/old1.txt");
      expect(seen).not.toContain("/old2.txt");
      // /old3.txt may appear once as the resume hint (last touched file).
      expect(seen.filter((p) => p === "/old3.txt").length).toBeLessThanOrEqual(1);
    } finally {
      mockHomedir = "";
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("surfaces a single line larger than the cap (end-to-end, the old silent-loss case)", async () => {
    const base = mkdtempSync(join(tmpdir(), "pipi-watch-home-"));
    try {
      mockHomedir = base;
      const cwd = join(base, "work5");
      const sessionDir = sessionDirFor(cwd);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "s-1.jsonl"), plainLine() + "\n");

      const seen: string[] = [];
      const off = onFilePath((e) => seen.push(e.path));
      startWatching(cwd);
      await new Promise((r) => setTimeout(r, 300)); // seed settles

      const giant =
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "write", arguments: { path: "/giant.bin" } }],
            extra: "x".repeat(APPEND_READ_CAP_BYTES + 200_000), // ~1.2MB single line
          },
        }) + "\n";
      appendFileSync(join(sessionDir, "s-1.jsonl"), giant + toolLine("/after.txt", "write") + "\n");
      await new Promise((r) => setTimeout(r, 2500)); // drain + catch-up passes
      off();

      expect(seen).toContain("/giant.bin"); // the >cap line must NOT be lost
      expect(seen).toContain("/after.txt"); // and following lines still flow
      expect(seen.filter((p) => p === "/giant.bin").length).toBe(1); // no dup
    } finally {
      mockHomedir = "";
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("switching to another cwd drops the old watcher's pending seed (no replay)", async () => {
    const base = mkdtempSync(join(tmpdir(), "pipi-watch-home-"));
    try {
      mockHomedir = base;
      const dirA = sessionDirFor(join(base, "projA"));
      const dirB = sessionDirFor(join(base, "projB"));
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });
      writeFileSync(join(dirA, "s.jsonl"), [toolLine("/a1.txt", "write"), toolLine("/a2.txt", "write"), ""].join("\n"));
      writeFileSync(join(dirB, "s.jsonl"), [toolLine("/b1.txt", "write"), toolLine("/b2.txt", "write"), ""].join("\n"));

      const seen: string[] = [];
      const off = onFilePath((e) => seen.push(e.path));
      startWatching(join(base, "projA"));
      await new Promise((r) => setTimeout(r, 30)); // A's seed timer is pending
      startWatching(join(base, "projB")); // replaces state before A's seed runs
      await new Promise((r) => setTimeout(r, 700)); // B's seed + drain settle
      off();

      // A's pending seed must die with its state — no replay of A's history.
      expect(seen.some((p) => p.startsWith("/a"))).toBe(false);
      // B's resume hint may surface its LAST touched file exactly once.
      expect(seen.filter((p) => p === "/b2.txt").length).toBeLessThanOrEqual(1);
      expect(seen).not.toContain("/b1.txt");
    } finally {
      mockHomedir = "";
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("emits only the delta after the first drain (no replay of consumed lines)", async () => {
    const base = mkdtempSync(join(tmpdir(), "pipi-watch-home-"));
    try {
      mockHomedir = base;
      const cwd = join(base, "work4");
      const sessionDir = sessionDirFor(cwd);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "s-1.jsonl"), plainLine() + "\n");

      const seen: string[] = [];
      const off = onFilePath((e) => seen.push(e.path));
      startWatching(cwd);
      await new Promise((r) => setTimeout(r, 300)); // let the seed settle

      appendFileSync(join(sessionDir, "s-1.jsonl"), toolLine("/a.txt", "write") + "\n");
      await new Promise((r) => setTimeout(r, 800));
      appendFileSync(join(sessionDir, "s-1.jsonl"), toolLine("/b.txt", "write") + "\n");
      await new Promise((r) => setTimeout(r, 800));
      off();

      expect(seen).toContain("/a.txt");
      expect(seen).toContain("/b.txt");
      // Each line emitted exactly once — the offset must advance past consumed
      // bytes so a later append never re-reads and re-emits earlier lines.
      expect(seen.filter((p) => p === "/a.txt").length).toBe(1);
      expect(seen.filter((p) => p === "/b.txt").length).toBe(1);
    } finally {
      mockHomedir = "";
      rmSync(base, { recursive: true, force: true });
    }
  });
});
