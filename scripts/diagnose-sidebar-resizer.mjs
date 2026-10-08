/**
 * /diagnose — dragging the sidebar's vertical resizer (the 项目 / 会话 ↔
 * 当前项目文件 divider) scrolls the session list upward and paints a text
 * selection while the pointer moves.
 *
 * Loop: boot the app over CDP with a sidebar whose session list really
 * overflows, then dispatch REAL mouse drags (Input.dispatchMouseEvent, i.e.
 * through the browser's own input pipeline — a JS-synthesised MouseEvent does
 * NOT start a selection) along the divider, and measure:
 *   - window.getSelection().length    — the "还带有选中文字" half of the report
 *   - .session-scroll.scrollTop       — the "会话向上滚动" half
 *   - .tree-scroll.scrollTop          — the neighbouring container (must not move)
 *   - resizer top vs pointer y        — does the handle stay under the cursor?
 *   - getComputedStyle(resizer).userSelect — the suspected cause
 *
 * Four drag cases, because the defect is geometry-dependent: both directions
 * (the divider is dragged up to shrink 项目/会话 and down to shrink
 * 当前项目文件) at two starting splits. Every case starts from a split written
 * to localStorage + a page reload, so a drag never inherits the previous case's
 * layout. The baseline is taken before each drag, and the fixture refuses to
 * judge when `.session-scroll` is not scrollable (a green run on a list that
 * cannot scroll proves nothing — the trap scripts/diagnose-tree-rows.mjs
 * documents).
 *
 * The horizontal `.pane-resizer` gets the same pressure, because it is the same
 * class of defect (drag handle with no selection guard).
 *
 * Usage: npm run build && node scripts/diagnose-sidebar-resizer.mjs
 *        (needs node_modules/electron — no packaging required)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9351;
const profile = ".smoke-profile-sidebar"; // matches .gitignore's .smoke-profile*/
const electronExe = join("node_modules", "electron", "dist", "electron.exe");

if (!existsSync(electronExe)) {
  console.log(`FAIL: ${electronExe} not found — run npm install`);
  process.exit(2);
}
if (!existsSync(join("out", "main", "index.js"))) {
  console.log("FAIL: out/ not built — run npm run build first");
  process.exit(2);
}
// Refuse to measure a stale bundle: out/ must be newer than every renderer source.
{
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const srcFiles = [...walk(join("src", "renderer", "src")), ...walk(join("src", "preload")), ...walk(join("src", "main"))].filter((f) => /\.(ts|tsx|css)$/.test(f));
  const newestSrc = Math.max(...srcFiles.map((f) => statSync(f).mtimeMs));
  const buildTime = statSync(join("out", "main", "index.js")).mtimeMs;
  if (newestSrc > buildTime + 1000) {
    console.log(`FAIL: out/ is STALE (${new Date(buildTime).toISOString()}) vs src/ (${new Date(newestSrc).toISOString()}) — run npm run build`);
    process.exit(2);
  }
}

rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

// --- fixture: a sidebar whose session list overflows -------------------------
// One local project per row; 30 rows dwarf the ~430px the top pane gets at the
// app's 1280x820 default, so `.session-scroll` is a real scroll container.
const workDir = mkdtempSync(join(tmpdir(), "pipi-resize-"));
const agentDir = join(workDir, "agent");
const SUBDIRS = 12;
for (let i = 0; i < SUBDIRS; i += 1) mkdirSync(join(workDir, `sub-${String(i).padStart(2, "0")}`), { recursive: true });

const PROJECTS = 30;
const projects = [];
for (let i = 0; i < PROJECTS; i += 1) {
  const cwd = i === 0 ? workDir : join(workDir, `sub-${String(i - 1).padStart(2, "0")}`);
  mkdirSync(cwd, { recursive: true });
  projects.push({ id: `local-${1000 + i}`, type: "local", name: `resize-fixture-${i}`, cwd, createdAt: Date.now(), updatedAt: Date.now() });
}
writeFileSync(join(profile, "projects.json"), JSON.stringify(projects, null, 2));

// Sessions for the FIRST project (the tree/session list the app shows once a
// tab is open on it): enough rows to fill the pane even after the drag.
const encodeCwd = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessionDir = join(agentDir, "sessions", encodeCwd(workDir));
mkdirSync(sessionDir, { recursive: true });
const SESSIONS = 8;
for (let i = 0; i < SESSIONS; i += 1) {
  const lines = [JSON.stringify({ type: "session", id: `rf-${i}`, version: 3, cwd: workDir, timestamp: new Date(Date.now() - i * 60_000).toISOString() })];
  lines.push(JSON.stringify({ type: "message", id: `rf-${i}-u`, parentId: null, timestamp: new Date(Date.now() - i * 60_000).toISOString(), message: { role: "user", content: [{ type: "text", text: `分界拖拽复现用会话 ${i}` }] } }));
  lines.push(JSON.stringify({ type: "message", id: `rf-${i}-a`, parentId: `rf-${i}-u`, timestamp: new Date(Date.now() - i * 60_000).toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "回答" }] } }));
  writeFileSync(join(sessionDir, `resize-${i}.jsonl`), lines.join("\n") + "\n");
}
console.log(`fixture: ${PROJECTS} projects, ${SESSIONS} sessions in ${sessionDir}`);

// --- CDP plumbing (same shape as scripts/diagnose-tree-rows.mjs) -------------
let app = null;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];

function launch() {
  return spawn(electronExe, [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
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

async function evaluate(ws, expression, awaitPromise = false) {
  const r = await send(ws, "Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  return r.result?.result?.value;
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined || ok ? "" : `\n      → ${detail}`}`);
  if (!ok) failures.push(name);
}

/** Box of a selector, or null. */
const boxExpr = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
})()`;

/** Everything the verdict needs, read in one shot. */
const measureExpr = `(() => {
  const sel = window.getSelection();
  const sessionScroll = document.querySelector('.session-scroll');
  const treeScroll = document.querySelector('.tree-scroll');
  const resizer = document.querySelector('.sidebar-resizer');
  return {
    selection: (sel ? sel.toString() : '').slice(0, 60),
    selectionLength: sel ? sel.toString().length : 0,
    sessionScrollTop: sessionScroll ? Math.round(sessionScroll.scrollTop) : null,
    sessionScrollHeight: sessionScroll ? sessionScroll.scrollHeight : null,
    sessionClientHeight: sessionScroll ? sessionScroll.clientHeight : null,
    treeScrollTop: treeScroll ? Math.round(treeScroll.scrollTop) : null,
    treeScrollHeight: treeScroll ? treeScroll.scrollHeight : null,
    treeClientHeight: treeScroll ? treeScroll.clientHeight : null,
    resizerUserSelect: resizer ? getComputedStyle(resizer).userSelect : null,
    resizerTop: resizer ? resizer.getBoundingClientRect().top : null,
    splitPct: (() => {
      const t = document.querySelector('.sidebar-top');
      const b = document.querySelector('.sidebar-bottom');
      if (!t || !b) return null;
      const th = t.getBoundingClientRect().height;
      const bh = b.getBoundingClientRect().height;
      return th + bh > 0 ? Math.round((th / (th + bh)) * 100) : null;
    })(),
    sessionRows: document.querySelectorAll('.session-scroll .project-row, .session-scroll .session-row').length,
  };
})()`;

/** Split % is persisted + written on drag end, so rewrite it and reload: every
 *  case then starts from the same geometry instead of the previous one's. */
async function resetSplit(ws, pct) {
  await evaluate(ws, `(() => { try { localStorage.setItem('pipi-sidebar-split', '${pct}'); } catch {} return true; })()`);
  await send(ws, "Page.reload", {});
  await sleep(2600);
}

/** Local projects fold on click; click until the session list is really scrollable. */
async function ensureScrollableSessionList(ws) {
  let m = await evaluate(ws, measureExpr);
  for (let i = 0; i < 3 && !((m.sessionScrollHeight ?? 0) > (m.sessionClientHeight ?? 0) + 36); i += 1) {
    await evaluate(ws, `(() => { const r = document.querySelector('.session-scroll .project-row'); if (r) r.click(); return !!r; })()`);
    await sleep(1400);
    m = await evaluate(ws, measureExpr);
  }
  return m;
}

/** Put the session list at a mid offset so a scroll in EITHER direction is detectable. */
const primeScroll = (ws, v) => evaluate(ws, `(() => {
  const el = document.querySelector('.session-scroll');
  if (!el) return null;
  el.scrollTop = ${v};
  return Math.round(el.scrollTop);
})()`);

/** A real drag: press on `sel`'s centre, then N moves of (dx, dy) each. */
async function drag(ws, sel, dx, dy, steps = 20) {
  const box = await evaluate(ws, boxExpr(sel));
  if (!box) throw new Error(`no element for ${sel}`);
  const y0 = box.y;
  await send(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: y0, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    await send(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + (dx * i) / steps, y: y0 + (dy * i) / steps, button: "left", buttons: 1 });
    await sleep(30);
  }
  return { box, x: box.x + dx, y: y0 + dy };
}

async function release(ws, x, y) {
  await send(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
}

app = launch();
try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) throw new Error("no CDP target");
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");
  await send(ws, "Page.enable");
  await sleep(4000);

  // A tab on the fixture dir: gives the file tree its content and marks the
  // project active, exactly the state the user was in.
  await evaluate(ws, `window.api.tab.create({ cwd: ${JSON.stringify(workDir)} })`, true).catch(() => null);
  await sleep(3500);

  // The profile is deleted at the start of every run, so this is the
  // fresh-install path: no `pipi-sidebar-split` key yet. It used to open at the
  // 20% floor (Number(null) === 0 is finite), which is also the state where a
  // divider drag first lands the cursor inside a session row.
  const fresh = await evaluate(ws, measureExpr);
  check("a fresh profile opens at the 55% default, not the 20% floor", fresh.splitPct === 55, `splitPct=${fresh.splitPct}`);

  // --- the reported gesture, both directions, at two starting splits --------
  // (start%, dy, expectation): +dy = drag the divider down = shrink 当前项目文件
  // (the reported gesture); -dy = the opposite direction, which is where the
  // autoscroll showed up. The last case is meant to run past the 80% band, so it
  // asserts the clamp rather than cursor tracking — a large downward drag is the
  // normal way to hit it, and it is also the case that parks the cursor deepest
  // inside the session list (offset ≈ −43px, i.e. how this bug is felt).
  const cases = [
    { start: 20, dy: 220, expect: "track", label: "split 20% → drag DOWN 220" },
    { start: 55, dy: 150, expect: "track", label: "split 55% → drag DOWN 150" },
    { start: 55, dy: -150, expect: "track", label: "split 55% → drag UP 150" },
    { start: 45, dy: -150, expect: "track", label: "split 45% → drag UP 150" },
    { start: 55, dy: 400, expect: "clamp-max", label: "split 55% → drag DOWN 400 (past the 80% band)" },
  ];
  for (const c of cases) {
    await resetSplit(ws, c.start);
    const base = await ensureScrollableSessionList(ws);
    if (base.sessionRows === 0 || !((base.sessionScrollHeight ?? 0) > (base.sessionClientHeight ?? 0) + 36)) {
      check(`${c.label}: fixture usable`, false, `sessionRows=${base.sessionRows} scrollHeight=${base.sessionScrollHeight} clientHeight=${base.sessionClientHeight} — a green verdict would be vacuous`);
      continue;
    }
    await primeScroll(ws, 300);
    await sleep(150);
    const before = await evaluate(ws, measureExpr);
    const end = await drag(ws, ".sidebar-resizer", 2, c.dy, 20);
    const during = await evaluate(ws, measureExpr);
    await release(ws, end.x, end.y);
    const after = await evaluate(ws, measureExpr);
    const offset = during.resizerTop - end.y;
    console.log(`${c.label}\n  selection ${before.selectionLength} → ${during.selectionLength} → ${after.selectionLength}${during.selectionLength ? ` ${JSON.stringify(during.selection)}` : ""}\n  sessionScrollTop ${before.sessionScrollTop} → ${during.sessionScrollTop} → ${after.sessionScrollTop}\n  treeScrollTop ${before.treeScrollTop} → ${during.treeScrollTop} → ${after.treeScrollTop}\n  clientHeight ${before.sessionClientHeight} → ${during.sessionClientHeight}\n  split ${before.splitPct}% → ${during.splitPct}%\n  handle offset ${offset.toFixed(1)}px (resizer top − pointer y)`);

    check(`${c.label}: no text selection while dragging`, during.selectionLength === 0 && after.selectionLength === 0, `selectionLength ${during.selectionLength}/${after.selectionLength} text=${JSON.stringify(during.selection || after.selection)}`);
    check(`${c.label}: 项目 / 会话 does not scroll`, during.sessionScrollTop === before.sessionScrollTop && after.sessionScrollTop === before.sessionScrollTop, `sessionScrollTop ${before.sessionScrollTop} → ${during.sessionScrollTop} → ${after.sessionScrollTop}`);
    check(`${c.label}: 当前项目文件 does not scroll`, during.treeScrollTop === before.treeScrollTop, `treeScrollTop ${before.treeScrollTop} → ${during.treeScrollTop}`);
    if (c.expect === "track") {
      check(`${c.label}: divider stays under the cursor`, Math.abs(offset) <= 3.5, `handle offset ${offset.toFixed(1)}px`);
    } else {
      check(`${c.label}: split stops at the 80% band`, during.splitPct === 80 && offset < -5, `splitPct=${during.splitPct} handle offset=${offset.toFixed(1)}px`);
    }
    check(`${c.label}: the drag actually moved the split`, during.sessionClientHeight !== before.sessionClientHeight, `clientHeight ${before.sessionClientHeight} → ${during.sessionClientHeight} (drag did nothing — the case proves nothing)`);
  }

  // --- the collapse affordance (same gesture surface, new button) -----------
  const topPaneHeight = () => evaluate(ws, `Math.round(document.querySelector('.sidebar-top').getBoundingClientRect().height)`);
  const topBefore = await topPaneHeight();
  const clicked = await evaluate(ws, `(() => { const b = document.querySelector('.panel-toggle-btn'); if (!b) return false; b.click(); return true; })()`);
  await sleep(500);
  const collapsed = await evaluate(ws, `(() => {
    const bottom = document.querySelector('.sidebar-bottom');
    const tree = document.querySelector('.tree-scroll');
    return {
      bottomHeight: bottom ? Math.round(bottom.getBoundingClientRect().height) : null,
      labelVisible: !!document.querySelector('.sidebar-bottom .panel-label'),
      treeRendered: tree ? getComputedStyle(tree).display !== 'none' : null,
      resizerGone: !document.querySelector('.sidebar-resizer'),
    };
  })()`);
  check("collapse button exists in the 当前项目文件 label", clicked === true);
  check("collapsing leaves only the label row", collapsed.bottomHeight !== null && collapsed.bottomHeight < 60 && collapsed.labelVisible === true && collapsed.treeRendered === false, JSON.stringify(collapsed));
  check("the divider is gone while collapsed", collapsed.resizerGone === true, JSON.stringify(collapsed));
  check("collapsing hands the space to 项目 / 会话", (await topPaneHeight()) > topBefore, `top pane ${topBefore} → ${await topPaneHeight()}`);
  const reopened = await evaluate(ws, `(() => { const b = document.querySelector('.panel-toggle-btn'); if (!b) return null; b.click(); return true; })()`);
  await sleep(500);
  const expanded = await evaluate(ws, `(() => {
    const tree = document.querySelector('.tree-scroll');
    return { treeRendered: tree ? getComputedStyle(tree).display !== 'none' : false, resizerBack: !!document.querySelector('.sidebar-resizer') };
  })()`);
  check("clicking again restores the tree", reopened === true && expanded.treeRendered === true && expanded.resizerBack === true, JSON.stringify(expanded));

  // --- same defect class on the horizontal divider -------------------------
  const hBefore = await evaluate(ws, measureExpr);
  const hEnd = await drag(ws, ".pane-resizer", 120, 0, 20);
  const hDuring = await evaluate(ws, measureExpr);
  await release(ws, hEnd.x, hEnd.y);
  const hAfter = await evaluate(ws, measureExpr);
  const hBox = await evaluate(ws, boxExpr(".pane-resizer"));
  console.log(`horizontal divider\n  selection ${hBefore.selectionLength} → ${hDuring.selectionLength} → ${hAfter.selectionLength}${hDuring.selectionLength ? ` ${JSON.stringify(hDuring.selection)}` : ""}\n  sessionScrollTop ${hBefore.sessionScrollTop} → ${hDuring.sessionScrollTop}\n  resizer left ${Math.round(hBox.left)} vs pointer x ${Math.round(hEnd.x)}`);
  check("horizontal divider: no text selection", hDuring.selectionLength === 0 && hAfter.selectionLength === 0, `selectionLength ${hDuring.selectionLength}/${hAfter.selectionLength} text=${JSON.stringify(hDuring.selection || hAfter.selection)}`);
  check("horizontal divider: 项目 / 会话 does not scroll", hDuring.sessionScrollTop === hBefore.sessionScrollTop, `sessionScrollTop ${hBefore.sessionScrollTop} → ${hDuring.sessionScrollTop}`);
  check("horizontal divider: pane width follows the cursor", Math.abs(hBox.left - hEnd.x) <= 3, `left ${Math.round(hBox.left)} vs pointer x ${Math.round(hEnd.x)}`);

  check("no renderer exceptions during the run", consoleErrors.length === 0, consoleErrors.join(" | "));
} catch (e) {
  check("sidebar-resizer diagnosis completed", false, e instanceof Error ? e.message : String(e));
} finally {
  try { app?.kill(); } catch { /* already gone */ }
  await sleep(1000);
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nALL CHECKS PASS" : `\n${failures.length} CHECK(S) FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
