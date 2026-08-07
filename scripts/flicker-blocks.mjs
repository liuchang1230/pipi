// Per-sync-block analysis: for each DEC 2026 block, which rows were erased
// (\x1b[2K) and rewritten. Categorizes what drives the bottom-dock repaints.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = readFileSync(join(tmpdir(), "pi-flicker-write.log"), "utf8");
const ROWS = 40;

let r = 0;
let inSync = false;
let block = null; // { erased: Set, seq: n }
let blocks = [];
let seq = 0;

function curBlock() {
  if (!block) block = { erased: new Set(), seq: seq++ };
  return block;
}

let i = 0;
while (i < log.length) {
  const ch = log[i];
  if (ch === "\x1b") {
    if (log[i + 1] === "[") {
      let j = i + 2;
      let params = "";
      while (j < log.length && !/[A-Za-z@`~]/.test(log[j])) { params += log[j]; j++; }
      const final = log[j] || "";
      const priv = params.startsWith("?");
      const nums = params.replace(/^\?/, "").split(";").map((x) => parseInt(x, 10) || 0);
      switch (final) {
        case "A": r = Math.max(0, r - (nums[0] || 1)); break;
        case "B": r = Math.min(ROWS - 1, r + (nums[0] || 1)); break;
        case "H": case "f": r = Math.max(0, (nums[0] || 1) - 1); break;
        case "K": if (r < ROWS) curBlock().erased.add(r); break;
        case "h": case "l": {
          if (nums[0] === 2026) {
            if (final === "h") { inSync = true; curBlock(); }
            else { inSync = false; if (block) { blocks.push(block); block = null; } }
          }
          break;
        }
      }
      i = j + 1;
    } else { i += 2; }
    continue;
  }
  if (ch === "\r") { i++; continue; }
  if (ch === "\n") { r++; i++; continue; }
  if (ch === "\u001b]") {
    let j = i + 2;
    while (j < log.length && log[j] !== "\u0007" && !(log[j] === "\x1b" && log[j + 1] === "\\")) j++;
    i = j + 1;
    continue;
  }
  i++;
}

// Summarize blocks by which rows they erased
const byRange = new Map();
let bottomOnly = 0, streamingPlusBottom = 0, other = 0;
for (const b of blocks) {
  const rows = [...b.erased].sort((a, z) => a - z);
  if (rows.length === 0) { continue; }
  const min = rows[0], max = rows[rows.length - 1];
  const touchesBottom = max >= 24; // editor/footer zone in this capture
  const touchesStream = min <= 23;
  let key;
  if (touchesBottom && touchesStream) key = `stream+spinner+editor+footer (${min}-${max})`;
  else if (touchesBottom) key = `bottom-only (${min}-${max})`;
  else key = `stream-only (${min}-${max})`;
  byRange.set(key, (byRange.get(key) || 0) + 1);
}

console.log("total sync blocks:", blocks.length);
console.log("--- block categories (rows erased per block) ---");
for (const [k, v] of [...byRange.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(String(v).padStart(5), k);
}
