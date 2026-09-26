/**
 * /diagnose — 分支窗口（会话树）里「会话都重叠了」。
 *
 * Phase 1 loop: boot the PACKAGED app over CDP, open the branch dialog on a
 * seeded session, then MEASURE the row geometry:
 *   - measured height of every mounted .tree-row vs the constant the window math
 *     assumes (ROW_H / MIND_ROW_H) — a disagreement drifts the window;
 *   - pairwise overlap (next.top < prev.bottom) — the reported symptom;
 *   - blank viewports (no row overlapping the visible band);
 *   - whether a scroll step moves the content at all.
 * Run at several scroll positions and in both views (导图 / 完整).
 *
 * Usage: node scripts/diagnose-tree-rows.mjs   (needs release/win-unpacked/pipi.exe)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9346;
const exe = "release/win-unpacked/pipi.exe";
const profile = ".smoke-profile-tree-diag";
if (!existsSync(exe)) {
  console.log(`FAIL: ${exe} not found — run \`npm run dist:dir\` first`);
  process.exit(2);
}
rmSync(profile, { recursive: true, force: true });
const workDir = mkdtempSync(join(tmpdir(), "pipi-diag-"));
const sessionsDir = join(workDir, "sessions-test");
mkdirSync(sessionsDir, { recursive: true });

// --- synthetic session file (300 turns with tool noise) ---------------------
function entry(o) { return JSON.stringify(o); }
const lines = [entry({ type: "session", id: "s0", cwd: workDir, timestamp: new Date().toISOString() })];
let parent = null;
let n = 0;
const next = () => `e${n++}`;
for (let i = 0; i < 300; i += 1) {
  const u = next();
  lines.push(entry({ type: "message", id: u, parentId: parent, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: `问题 ${i}` }] } }));
  parent = u;
  const t1 = next();
  lines.push(entry({ type: "message", id: t1, parentId: parent, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: { path: "a.ts" } }] } }));
  parent = t1;
  const r1 = next();
  lines.push(entry({ type: "message", id: r1, parentId: parent, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: `tc${i}`, content: [{ type: "text", text: "ok" }] } }));
  parent = r1;
  const a = next();
  lines.push(entry({ type: "message", id: a, parentId: parent, timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `回答 ${i}：\n\n- 要点一\n- 要点二\n\n一些正文内容用于撑起高度。` }] } }));
  parent = a;
}
const sessionFile = join(sessionsDir, "diag-session.jsonl");
writeFileSync(sessionFile, lines.join("\n") + "\n");
console.log(`seeded ${lines.length - 1} entries → ${sessionFile}`);

let app = null;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];

function launch() {
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  return child;
}

async function getWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* booting */ }
    await sleep(500);
  }
  return null;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description ?? "").slice(0, 200));
      }
    };
  });
}

function send(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluateNamed(ws, name, expression, awaitPromise = false) {
  try {
    return await evaluate(ws, expression, awaitPromise);
  } catch (e) {
    throw new Error(`evaluate[${name}] failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function evaluate(ws, expression, awaitPromise = false) {
  const r = await send(ws, "Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  return r.result?.result?.value;
}

app = launch();
try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) throw new Error("no CDP target");
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");
  await sleep(2500);

  const tabId = await evaluateNamed(ws, "tab.create", `window.api.tab.create({ cwd: ${JSON.stringify(workDir)}, sessionPath: ${JSON.stringify(sessionFile)} })`, true);
  console.log("tab:", tabId);
  await sleep(5000);

  // Open the branch dialog the way a user does.
  const opened = await evaluateNamed(ws, "openTree", `(() => {
    const b = [...document.querySelectorAll('.chat-header-btn')].find((x) => /会话分支/.test(x.title || x.textContent || ''));
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  })()`, true);
  console.log("open dialog:", opened);
  await sleep(3000);

  /** Measure row geometry at the current scroll position. */
  const measure = `(() => {
    const el = document.querySelector('.tree-dialog .tree-scroll');
    if (!el) return { error: 'no tree scroll' };
    const rows = [...el.querySelectorAll('.tree-row')].map((r) => {
      const b = r.getBoundingClientRect();
      const card = r.querySelector('.tree-card');
      // overflow = the card needs more vertical space than its row gives it,
      // which is what paints the next row's card over its neighbour.
      const overflow = card ? Math.round(card.scrollHeight - b.height) : 0;
      return { id: r.getAttribute('data-row-id'), top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), mind: r.className.includes('tree-row-mind'), overflow };
    });
    let overlaps = 0;
    let worst = 0;
    for (let i = 1; i < rows.length; i += 1) {
      const gap = rows[i].top - rows[i - 1].bottom;
      if (gap < 0) { overlaps += 1; worst = Math.min(worst, gap); }
    }
    const heights = rows.map((r) => r.h);
    const box = el.getBoundingClientRect();
    const visible = rows.filter((r) => r.bottom > box.top && r.top < box.bottom).length;
    return {
      count: rows.length,
      heights: [...new Set(heights)],
      overlaps,
      worstGap: worst,
      visible,
      maxCardOverflow: rows.reduce((m, r) => Math.max(m, r.overflow || 0), 0),
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
      mind: rows.length ? rows[0].mind : null,
    };
  })()`;

  const selfCheck = process.argv.includes("--self-check");
  if (selfCheck) {
    // Reproduce the shipped bug in-place: rows pinned to 24px with clipping off
    // (that is what made 44px cards paint over their neighbours).
    await evaluateNamed(ws, "inject-bad", `(() => {
      const st = document.createElement('style');
      st.id = 'diag-bad-geometry';
      st.textContent = '.tree-dialog .tree-scroll .tree-row-mind{height:24px !important;min-height:24px !important;max-height:24px !important}.tree-dialog .tree-row{overflow:visible !important}';
      document.head.appendChild(st);
      return 'injected';
    })()`, true);
    await sleep(300);
    console.log("self-check: injected the pre-fix geometry");
  }
  const report = [];
  const first = await evaluateNamed(ws, "measure-top", measure, true);
  console.log("at top:", JSON.stringify(first));
  report.push(first);

  // Scroll through the list and re-measure at each position.
  for (const frac of [0.15, 0.3, 0.5, 0.75, 0.95]) {
    const r = await evaluateNamed(ws, "scroll+measure", `(async () => {
      const el = document.querySelector('.tree-dialog .tree-scroll');
      if (!el) return { error: 'gone' };
      el.scrollTop = el.scrollHeight * ${frac};
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((res) => setTimeout(res, 250));
      return true;
    })()`, true);
    void r;
    const m = await evaluateNamed(ws, "measure", measure, true);
    console.log(`at ${frac}:`, JSON.stringify(m));
    report.push(m);
  }

  // Also check the 完整 view (fixed 24px log rows).
  const toFull = await evaluateNamed(ws, "full-view", `(() => {
    const b = [...document.querySelectorAll('.tree-dialog .tree-chip')].find((c) => c.textContent.trim() === '完整');
    if (!b) return 'no chip';
    b.click();
    return 'clicked';
  })()`, true);
  await sleep(800);
  const full = await evaluateNamed(ws, "measure-full", measure, true);
  console.log("完整 view:", JSON.stringify(full), "chip:", toFull);
  report.push(full);

  const rowsWithError = report.filter((r) => r.error);
  const overlaps = report.reduce((n, r) => n + (r.overlaps ?? 0), 0);
  const blanks = report.filter((r) => (r.visible ?? 0) === 0).length;
  const heights = [...new Set(report.flatMap((r) => r.heights ?? []))];
  console.log(`
measurements: ${report.length}   total overlapping row pairs: ${overlaps}   blank viewports: ${blanks}`);
  console.log("distinct row heights seen:", JSON.stringify(heights));
  console.log("mind-map rows assume 46px; full-view rows assume 24px (MIND_ROW_H / ROW_H in TreeDialog.tsx)");
  // The window math assumes these heights; a mismatch is the bug class that made
  // the cards overlap AND drifted the spacers.
  const mindHeights = [...new Set(report.filter((r) => r.mind === true).flatMap((r) => r.heights ?? []))];
  const fullHeights = [...new Set(report.filter((r) => r.mind === false).flatMap((r) => r.heights ?? []))];
  const maxOverflow = report.reduce((m, r) => Math.max(m, r.maxCardOverflow ?? 0), 0);
  console.log(`max card content overflow past its row: ${maxOverflow}px (0 = nothing can paint over a neighbour)`);
  if (maxOverflow > 0) {
    console.log("FAIL: card content is taller than its row slot → rows paint over each other");
    process.exitCode = 1;
  }
  const wrongMind = mindHeights.filter((h) => h !== 46);
  const wrongFull = fullHeights.filter((h) => h !== 24);
  if (wrongMind.length) console.log(`FAIL: 导图 rows measured ${JSON.stringify(mindHeights)} but TreeDialog's MIND_ROW_H is 46`);
  if (wrongFull.length) console.log(`FAIL: 完整 rows measured ${JSON.stringify(fullHeights)} but TreeDialog's ROW_H is 24`);
  if (wrongMind.length || wrongFull.length) process.exitCode = 1;

  const detected = overlaps > 0 || maxOverflow > 0 || wrongMind.length > 0 || wrongFull.length > 0;
  if (selfCheck) {
    console.log(detected ? "SELF-CHECK PASS: the probe detects the pre-fix geometry" : "SELF-CHECK FAIL: the probe did NOT detect the broken geometry");
    process.exitCode = detected ? 0 : 1;
  } else if (detected || blanks > 0 || rowsWithError.length > 0) {
    console.log("FAIL: the tree list has overlapping rows / blank viewports");
    process.exitCode = 1;
  } else {
    console.log("PASS: no overlapping rows, no blank viewport");
  }
} catch (e) {
  console.log("FAIL:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  try { app?.kill(); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* locked */ }
}
