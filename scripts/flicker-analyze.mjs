// Analyze the captured pi TUI write log: which terminal rows get rewritten
// during streaming, how often, and whether rewrites happen inside DEC 2026
// sync blocks (they should — otherwise xterm paints intermediate clears).
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = readFileSync(join(tmpdir(), "pi-flicker-write.log"), "utf8");
const ROWS = 30;
const COLS = 100;

const rows = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
let r = 0, c = 0;
let syncDepth = 0;
let cursorVisible = true;
// Per-row: { rewrites, inSync, outSync } — counted per EL2/rewrite cycle, not per char
const stats = Array.from({ length: ROWS }, () => ({ rewrites: 0, inSync: 0, outSync: 0 }));
// Track whether a row was "erased" (2K) since the last write, so a full
// clear+rewrite cycle counts as ONE rewrite
const erased = Array(ROWS).fill(false);

function markRewritten(row, forceEraseCount = false) {
  const s = stats[row];
  if (erased[row] || forceEraseCount) {
    s.rewrites++;
    if (syncDepth > 0) s.inSync++; else s.outSync++;
    erased[row] = false;
  }
}

function put(ch) {
  if (r < 0 || r >= ROWS) return;
  if (ch === "\n") { r++; c = 0; return; }
  if (c < COLS) {
    rows[r][c] = ch;
    markRewritten(r);
    c++;
  }
}

// Parse CSI sequences
let i = 0;
while (i < log.length) {
  const ch = log[i];
  if (ch === "\x1b") {
    if (log[i + 1] === "[") {
      // CSI
      let j = i + 2;
      let params = "";
      while (j < log.length && !/[A-Za-z@`~]/.test(log[j])) { params += log[j]; j++; }
      const final = log[j] || "";
      // private-mode params carry a leading '?' (e.g. \x1b[?2026h)
      const priv = params.startsWith("?");
      const cleanParams = params.replace(/^\?/, "");
      const nums = cleanParams.split(";").map((x) => parseInt(x, 10) || 0);
      switch (final) {
        case "A": r = Math.max(0, r - (nums[0] || 1)); break;
        case "B": r = Math.min(ROWS - 1, r + (nums[0] || 1)); break;
        case "C": c = Math.min(COLS - 1, c + (nums[0] || 1)); break;
        case "D": c = Math.max(0, c - (nums[0] || 1)); break;
        case "G": c = Math.max(0, (nums[0] || 1) - 1); break;
        case "H": case "f": r = Math.max(0, (nums[0] || 1) - 1); c = Math.max(0, (nums[1] || 1) - 1); break;
        case "K": // EL — clear line: this is a REAL rewrite cycle start
          if (r >= 0 && r < ROWS) {
            const mode = nums[0] || 0;
            if (mode === 0) { for (let x = c; x < COLS; x++) rows[r][x] = " "; }
            else if (mode === 2) { for (let x = 0; x < COLS; x++) rows[r][x] = " "; }
            erased[r] = true;
          }
          break;
        case "J":
          if (r >= 0 && r < ROWS) {
            const mode = nums[0] || 0;
            if (mode === 0) { for (let x = c; x < COLS; x++) rows[r][x] = " "; for (let rr = r + 1; rr < ROWS; rr++) rows[rr].fill(" "); }
            else if (mode === 2) { for (const rr of rows) rr.fill(" "); }
            for (let rr = r; rr < ROWS; rr++) markRewritten(rr);
          }
          break;
        case "m": break; // SGR — ignore
        case "h": case "l": {
          const m = nums[0];
          if (m === 2026) { if (final === "h") syncDepth++; else syncDepth = Math.max(0, syncDepth - 1); }
          if (m === 25) cursorVisible = final === "h";
          break;
        }
        default: break;
      }
      i = j + 1;
    } else {
      i += 2; // other escapes — skip
    }
    continue;
  }
  if (ch === "\r") { c = 0; i++; continue; }
  if (ch === "\n") { r++; c = 0; i++; continue; }
  // skip OSC (e.g. OSC 133 ; B ST)
  if (ch === "\u001b]") {
    let j = i + 2;
    while (j < log.length && log[j] !== "\u0007" && !(log[j] === "\x1b" && log[j + 1] === "\\")) j++;
    i = j + 1;
    continue;
  }
  put(ch);
  i++;
}

console.log("row | rewrites | in-sync | out-of-sync | last 40 chars");
console.log("----|----------|---------|-------------|------------------------------");
for (let row = 0; row < ROWS; row++) {
  const s = stats[row];
  if (s.rewrites === 0) continue;
  const text = rows[row].join("").trimEnd();
  console.log(
    `${String(row).padStart(3)} | ${String(s.rewrites).padStart(8)} | ${String(s.inSync).padStart(7)} | ${String(s.outSync).padStart(11)} | ${text.slice(0, 60)}`
  );
}
console.log("\nsync depth at EOF:", syncDepth);
