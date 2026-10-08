/**
 * transcript-tail on REAL session files (the reader the IPC handler runs).
 *
 * The unit fixtures are synthetic; this one runs the windowed reader over the session files
 * this machine actually has, because that is where "the last 120 messages" stops being an
 * abstraction: files with a single 1.6 MB tool result, files whose messages are dwarfed by
 * abandoned branches, files with compaction. It asserts the three properties the chat's
 * safety depends on:
 *   - the window's resolve is a SUFFIX of the whole-file resolve (no invented, reordered or
 *     dropped-newest messages),
 *   - a window marked `complete` resolves to EXACTLY the whole-file list (that is what lets
 *     the handler keep its count check), and
 *   - the bytes read stay inside the page budget (what makes opening bounded).
 *
 * Skips when there is no sessions directory (CI / a clean machine), like the differential
 * test against pi: a dev-machine oracle, not a fixture.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionPages, type ByteSource } from "../session-pages";
import { PAGE_BUDGET, rawCodec } from "../../shared/session-page";
import { transcriptFromContent, transcriptTailFromSource, TRANSCRIPT_TAIL_MAX_PAGES, TRANSCRIPT_TAIL_MIN_MESSAGES } from "../transcript-from-file";

function sessionsRoot(): string | null {
  const dir = process.env.PI_CODING_AGENT_DIR ? join(process.env.PI_CODING_AGENT_DIR, "sessions") : join(homedir(), ".pi", "agent", "sessions");
  return existsSync(dir) ? dir : null;
}

/** Every `.jsonl` under the sessions root, biggest first (the slow opens are the big ones). */
function biggestSessions(limit: number): string[] {
  const root = sessionsRoot();
  if (!root) return [];
  const out: Array<{ path: string; size: number }> = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(root, dir.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(root, dir.name, f);
      const size = statSync(path).size;
      if (size > 200_000) out.push({ path, size }); // a tail window only matters for real files
    }
  }
  return out.sort((a, b) => b.size - a.size).slice(0, limit).map((x) => x.path);
}

/** A node-fs ByteSource that counts bytes, so "bounded" is measurable on real files. */
function fsSource(): ByteSource & { bytes: number; reads: number; spans: Array<[number, number]> } {
  const src = {
    bytes: 0,
    reads: 0,
    spans: [] as Array<[number, number]>,
    size: async (p: string) => statSync(p).size,
    read: async (p: string, start: number, length: number) => {
      const buf = readFileSync(p);
      const slice = buf.subarray(start, start + length);
      src.reads += 1;
      src.bytes += slice.length;
      if (process.env.SPANS) src.spans.push([start, slice.length]);
      return slice;
    },
    readAll: async (p: string) => readFileSync(p),
  };
  return src;
}

const files = biggestSessions(3);

describe.skipIf(files.length === 0)("transcriptTailFromSource on real sessions", () => {
  for (const path of files) {
    it(`${path.split(/[\\/]/).slice(-1)[0].slice(0, 24)} (${(statSync(path).size / 1048576).toFixed(1)} MB)`, async () => {
      const full = (await transcriptFromContent(readFileSync(path, "utf8"))) ?? [];
      const source = fsSource();
      const pages = createSessionPages(source, { codec: rawCodec, wholeFileUncapped: true });
      const window = await transcriptTailFromSource(pages, path);
      expect(window).not.toBeNull();
      const win = window!;

      // 1. the window is the truth's TAIL. A window holding a compaction whose kept entry is
      //    outside it yields [summary, post-compaction…] (pi hoists the summary), so compare
      //    after dropping a leading summary from both sides.
      expect(full.length).toBeGreaterThan(0);
      const dropSummary = (ms: unknown[]) => (ms[0] && (ms[0] as { role?: string }).role === "compactionSummary" ? ms.slice(1) : ms);
      const winTail = dropSummary(win.messages);
      expect(winTail).toEqual(dropSummary(full).slice(-winTail.length));
      // 2. `complete` may only be claimed when it really is the whole context.
      if (win.complete) expect(win.messages.length).toBe(full.length);
      // 3. the read stayed inside the budget: per page `maxPageBytes + maxBytes`, at most
      //    TRANSCRIPT_TAIL_MAX_PAGES pages, plus the one complete read the escalation may add.
      expect(source.bytes).toBeLessThanOrEqual(TRANSCRIPT_TAIL_MAX_PAGES * (PAGE_BUDGET.maxPageBytes + PAGE_BUDGET.maxBytes) + statSync(path).size);
      const again = await transcriptTailFromSource(pages, path, { minMessages: TRANSCRIPT_TAIL_MIN_MESSAGES });
      expect(again!.messages).toEqual(win.messages.slice(-again!.messages.length));
      if (process.env.SPANS) console.log("    spans=" + JSON.stringify(source.spans));
      // eslint-disable-next-line no-console -- this test doubles as the measurement record
      console.log(
        `  ${path.split(/[\\/]/).slice(-1)[0]}: file=${(statSync(path).size / 1048576).toFixed(2)}MB` +
          ` messages=${full.length} window=${win.entries.length} entries → resolved=${win.messages.length}` +
          ` complete=${win.complete} reads=${source.reads} read=${(source.bytes / 1048576).toFixed(2)}MB` +
          ` (${((source.bytes / statSync(path).size) * 100).toFixed(0)}% of the file)`,
      );
    });
  }
});
