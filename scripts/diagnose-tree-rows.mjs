/**
 * /diagnose — 分支窗口（会话树）里「会话都重叠了」。
 *
 * Phase 1 loop: boot the PACKAGED app over CDP, open the branch dialog on a
 * seeded session, then MEASURE the row geometry:
 *   - measured height of every mounted .tree-row vs the constant the window math
 *     assumes (ROW_H) — a disagreement drifts the window;
 *   - pairwise overlap (next.top < prev.bottom) — the reported symptom;
 *   - blank viewports (no row overlapping the visible band);
 *   - whether a scroll step moves the content at all;
 *   - same-level alignment: rows sharing an indent must put their content at one
 *     x, and rails at one x per level.
 * Run at several scroll positions.
 *
 * (There is one view — 导图/完整 merged 2026-09-28; the dialog is now laid out by
 * conversation level, see conversationLevel in src/shared/tree-layout.ts.)
 *
 * Usage: node scripts/diagnose-tree-rows.mjs   (needs release/win-unpacked/pipi.exe)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
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
// A stale app.asar has fooled this harness before (dist:dir does not always
// refresh it): refuse to measure an older bundle than the one just built.
{
  const asar = join("release", "win-unpacked", "resources", "app.asar");
  const assetsDir = join("out", "renderer", "assets");
  if (existsSync(asar) && existsSync(assetsDir)) {
    const asarTime = statSync(asar).mtimeMs;
    const newestAsset = Math.max(...readdirSync(assetsDir).map((f) => statSync(join(assetsDir, f)).mtimeMs));
    if (newestAsset > asarTime + 1000) {
      console.log(`FAIL: app.asar is STALE (${new Date(asarTime).toISOString()}) vs out/ (${new Date(newestAsset).toISOString()}) — run npm run dist:dir again`);
      process.exit(2);
    }
  }
}

const workDir = mkdtempSync(join(tmpdir(), "pipi-diag-"));
const sessionsDir = join(workDir, "sessions-test");
mkdirSync(sessionsDir, { recursive: true });

// --- synthetic session file (linear tail + TWO forks, so the branch marks and
// the same-level alignment are exercised) ----------------------------------
// `version: 3` is REQUIRED. pi's SessionManager migrates anything without a
// version as v1: migrateV1ToV2 assigns fresh ids and re-chains every entry onto
// the previous one (`entry.parentId = prevId`), which LINEARIZES the session —
// every fork disappears, the tree becomes a chain, and the branch-mark checks
// below go green-on-nothing. (That is exactly what a first version of this
// script did.)
function entry(o) { return JSON.stringify(o); }
const lines = [entry({ type: "session", id: "s0", version: 3, cwd: workDir, timestamp: new Date().toISOString() })];
let parent = null;
let n = 0;
const next = () => `e${n++}`;
const stamp = () => new Date().toISOString();
const push = (id, parentId, role, content, extra = {}) => lines.push(entry({ type: "message", id, parentId, timestamp: stamp(), message: { role, content, ...extra } }));
const ask = (par, text) => { const id = next(); push(id, par, "user", [{ type: "text", text }]); return id; };
const reply = (par, text) => { const id = next(); push(id, par, "assistant", [{ type: "text", text }], { stopReason: "stop" }); return id; };
const tool = (par, i) => {
  const t = next();
  push(t, par, "assistant", [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: { path: "a.ts" } }]);
  const r = next();
  push(r, t, "toolResult", [{ type: "text", text: "ok" }], { toolCallId: `tc${i}` });
  return r;
};
// head + a fork at a PROMPT (3 prompts sharing one parent → level-0 branch rows)
parent = ask(parent, "线性问题 0");
parent = reply(parent, "线性回答 0");
parent = tool(parent, 0);
for (const label of ["分支A-一", "分支A-二", "分支A-三"]) {
  const p = ask(parent, label);
  reply(p, `回答 ${label}`);
}
// a fork at a REPLY (2 replies under one prompt)
const forkRoot = ask(parent, "分支B-提问");
reply(forkRoot, "分支B-旧回答");
const kept = reply(forkRoot, "分支B-新回答");
parent = tool(kept, 99);
// long linear tail: the window math / scroll behaviour under 1000+ rows
for (let i = 0; i < 300; i += 1) {
  parent = ask(parent, `尾部问题 ${i}`);
  parent = reply(parent, `尾部回答 ${i}：\n\n- 要点一\n- 要点二\n\n一些正文内容用于撑起高度。`);
  parent = tool(parent, i + 1);
}
const sessionFile = join(sessionsDir, "diag-session.jsonl");
writeFileSync(sessionFile, lines.join("\n") + "\n");
console.log(`seeded ${lines.length - 1} entries (2 forks) → ${sessionFile}`);

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

  // Entry paging (docs/adr/0011-session-entry-paging.md): the dialog now opens on the
  // NEWEST page of the session file, and its older pages arrive on demand. This harness
  // asserts on the session HEAD (where its two forks are seeded), so load the rest first —
  // exactly what a user does by scrolling up. Without this the head is not even mounted and
  // the branch-mark check below would pass/fail on the wrong rows.
  const loaded = await evaluateNamed(ws, "load-all-pages", `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let clicks = 0;
    // The button is disabled WHILE a page is loading too, so only its absence means "no more
    // pages" — breaking on a disabled one would stop after a single page on a slow target.
    for (let i = 0; i < 25; i += 1) {
      const btn = document.querySelector('.tree-dialog .tree-earlier-btn');
      if (!btn) break;
      if (!btn.disabled) {
        btn.click();
        clicks += 1;
      }
      await wait(1200);
    }
    return { clicks, rows: document.querySelectorAll('.tree-dialog .tree-scroll .tree-row').length, stillLoading: !!document.querySelector('.tree-dialog .tree-earlier-btn') };
  })()`, true);
  console.log("loaded older pages:", JSON.stringify(loaded));
  await sleep(500);

  /** Measure row geometry at the current scroll position. */
  const measure = `(() => {
    const el = document.querySelector('.tree-dialog .tree-scroll');
    if (!el) return { error: 'no tree scroll' };
    const rows = [...el.querySelectorAll('.tree-row')].map((r) => {
      const b = r.getBoundingClientRect();
      // overflow = the row needs more vertical space than its slot gives it,
      // which is what paints a row over its neighbour.
      const content = r.querySelector('.tree-fold') ?? r;
      const overflow = Math.round(r.scrollHeight - b.height);
      // Rail geometry: every rail element's x position, per level. Levels must
      // line up vertically across ALL rows — that is the user's "感觉同一级别没有
      // 完全对齐" turned into a number.
      const railEls = [...r.querySelectorAll('.tree-rail')];
      const rails = railEls.map((el, i) => {
        const rb = el.getBoundingClientRect();
        return { level: i, x: Math.round(rb.left * 10) / 10, w: Math.round(rb.width * 10) / 10 };
      });
      // The glyph must be the one the row's data-marker names (MARKER_GLYPH in
      // TreeDialog.tsx — kept in sync by hand; a mismatch fails loudly below).
      const GLYPHS = { '': '', 'branch-mid': '\u251c', 'branch-last': '\u2514', 'continuation': '\u2502' };
      const marker = r.getAttribute('data-marker') ?? '';
      const glyph = (r.querySelector('.tree-marker')?.textContent ?? '').trim();
      return { id: r.getAttribute('data-row-id'), top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), overflow, indent: Number(r.getAttribute('data-indent') ?? -1), contentLeft: content.getBoundingClientRect().left, marker, glyph, expectedGlyph: GLYPHS[marker] ?? '?', rails, selected: r.getAttribute('data-selected') === '1' };
    });
    let overlaps = 0;
    let worst = 0;
    for (let i = 1; i < rows.length; i += 1) {
      const gap = rows[i].top - rows[i - 1].bottom;
      if (gap < 0) { overlaps += 1; worst = Math.min(worst, gap); }
    }
    const heights = rows.map((r) => r.h);
    // Same-level alignment: every row with the same indent must place its CONTENT
    // at exactly the same x. (Measured: the ASCII gutter was rendered in a
    // proportional font for card rows, so levels drifted.)
    // A missing data-indent would collapse every row into one group and make this
    // check pass vacuously (that is exactly how a stale bundle fooled an earlier
    // run). Refuse to measure instead.
    const missingIndent = rows.filter((r) => r.indent === -1).length;
    if (rows.length > 0 && missingIndent === rows.length) {
      return { error: 'rows carry no data-indent — stale bundle? (alignment unmeasurable)' };
    }
    const byIndent = {};
    for (const r of rows) {
      const key = String(r.indent);
      if (!byIndent[key]) byIndent[key] = new Set();
      byIndent[key].add(Math.round(r.contentLeft * 10) / 10);
    }
    const misaligned = Object.entries(byIndent)
      .filter(([, set]) => set.size > 1)
      .map(([indent, set]) => ({ indent, offsets: [...set] }));
    // Rail x per level across all mounted rows: one distinct value per level means
    // the vertical guides line up exactly.
    const railPositions = {};
    let railCount = 0;
    for (const r of rows) {
      for (const rail of r.rails ?? []) {
        railCount += 1;
        const key = String(rail.level);
        if (!railPositions[key]) railPositions[key] = new Set();
        railPositions[key].add(rail.x);
      }
    }
    const railDrift = Object.entries(railPositions)
      .filter(([, set]) => set.size > 1)
      .map(([level, set]) => ({ level, xs: [...set] }));
    const box = el.getBoundingClientRect();
    const visible = rows.filter((r) => r.bottom > box.top && r.top < box.bottom).length;
    return {
      count: rows.length,
      heights: [...new Set(heights)],
      overlaps,
      worstGap: worst,
      visible,
      maxRowOverflow: rows.reduce((m, r) => Math.max(m, r.overflow || 0), 0),
      misaligned,
      railDrift,
      railCount,
      // Every row must carry exactly one rail element per level: that is the
      // width contract that makes "indent × step" the content column.
      railCountMismatch: rows.filter((r) => r.rails.length !== r.indent).length,
      // …and the step between two levels must equal ONE .tree-rail width
      // (styles.css). Measured rather than assumed: the constant that used to sit
      // in TreeDialog.tsx (RAIL_W) was deleted so the stylesheet is the only
      // source of truth, which means nothing but this number protects the contract.
      railWidths: [...new Set(rows.flatMap((r) => r.rails.map((x) => x.w)))],
      railSteps: (() => {
        const left = {};
        for (const r of rows) if (!(String(r.indent) in left)) left[String(r.indent)] = Math.round(r.contentLeft * 10) / 10;
        const lv = Object.keys(left).map(Number).sort((a, b) => a - b);
        const steps = [];
        for (let i = 1; i < lv.length; i += 1) steps.push(Math.round((left[String(lv[i])] - left[String(lv[i - 1])]) * 10) / 10);
        return steps;
      })(),
      glyphMismatch: rows.filter((r) => r.glyph !== r.expectedGlyph).length,
      markers: rows.reduce((m, r) => { const k = r.marker || 'none'; m[k] = (m[k] || 0) + 1; return m; }, {}),
      // A few rows as the eye sees them: catches "the rows are not the ones I
      // think they are" (wrong session, a filter hiding the branch, …).
      sample: rows.slice(0, 6).map((r) => [r.indent, r.marker || '-', (() => { const t = document.querySelector('.tree-dialog .tree-scroll [data-row-id=\"' + r.id + '\"] .tree-entrytext'); return t ? t.textContent.trim().slice(0, 14) : '?'; })()]),
      indentCounts: rows.reduce((m, r) => { m[r.indent] = (m[r.indent] || 0) + 1; return m; }, {}),
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
    };
  })()`;

  const selfCheck = process.argv.includes("--self-check");
  if (selfCheck) {
    // Reproduce the shipped bug in-place: rows taller than the constant the
    // window math assumes (ROW_H = 24) AND overlapping (negative margin), which
    // is the geometry class this probe exists to catch — plus a per-row indent
    // shift, the 同一层没对齐 class.
    await evaluateNamed(ws, "inject-bad", `(() => {
      const st = document.createElement('style');
      st.id = 'diag-bad-geometry';
      st.textContent = '.tree-dialog .tree-scroll .tree-row{height:40px !important;margin-bottom:-24px !important;overflow:visible !important}'
        + '.tree-dialog .tree-scroll .tree-row:nth-child(2n){padding-left:19px !important}';
      document.head.appendChild(st);
      return 'injected';
    })()`, true);
    await sleep(300);
    console.log("self-check: injected the pre-fix geometry");
  }
  const report = [];
  // Structural failures (the marker API / glyphs / the rail count are wired wrong)
  // are kept apart from GEOMETRY failures: --self-check INJECTS broken geometry on
  // purpose, so it must not be able to mask a structural failure by overwriting the
  // exit code. (The level-step contract is geometry, and the injection perturbs it.)
  let structuralFailure = false;
  // The dialog opens scrolled to the LEAF (the interesting viewport for the row
  // window) — measure that before scrolling away from it.
  const first = await evaluateNamed(ws, "measure-leaf", measure, true);
  console.log("opened at (leaf):", JSON.stringify(first));
  console.log("indents:", JSON.stringify(first.indentCounts ?? "n/a"));
  report.push(first);

  // The seeded forks live in the session HEAD, so the branch marks are only
  // mounted at scrollTop 0.
  await evaluateNamed(ws, "scroll-to-top", `(async () => {
    const el = document.querySelector('.tree-dialog .tree-scroll');
    if (!el) return { error: 'gone' };
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 250));
    return true;
  })()`, true);
  const head = await evaluateNamed(ws, "measure-head", measure, true);
  console.log("at head:", JSON.stringify(head));
  console.log("branch marks:", JSON.stringify(head.markers ?? "n/a"));
  // A seeded session with two forks must show branch glyphs — this is the check
  // that would have caught the elbow the old gutter scheme silently dropped.
  {
    const marks = head.markers ?? {};
    const branches = (marks["branch-mid"] ?? 0) + (marks["branch-last"] ?? 0);
    if (!head.error && (branches === 0 || (marks.continuation ?? 0) === 0)) {
      console.log(`FAIL: the seeded session forks twice but the rows draw no branch marks: ${JSON.stringify(marks)}`);
      console.log("      (if the rows are a plain chain, pi migrated the seed file as v1 — the header needs `version: 3`)");
      structuralFailure = true;
    }
  }
  report.push(head);

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
  // Every mounted row of every snapshot must carry exactly one level column per
  // indent — a row that lost one would put its content in the wrong column.
  const railMismatch = report.reduce((n, r) => n + (r.railCountMismatch ?? 0), 0);
  if (railMismatch > 0) {
    console.log(`FAIL: ${railMismatch} rows carry a different number of level columns than their indent`);
    structuralFailure = true;
  }

  // --- selection highlight: click a row, then A/B the SAME row with its selection
  // stripped. Identical computed styles = the click is invisible (「点击节点没有可见
  // 区别」). The clicked row must NOT be the current leaf: `.current` paints its own
  // colour at the same specificity further down the stylesheet, which would hide a
  // regression of `.selected` from this comparison.
  const selBefore = await evaluateNamed(ws, "select", `(() => {
    const rows = [...document.querySelectorAll('.tree-dialog .tree-scroll .tree-row')];
    const notCurrent = rows.filter((r) => !r.classList.contains('current'));
    const target = notCurrent[Math.floor(notCurrent.length / 2)] ?? rows[Math.floor(rows.length / 2)];
    if (!target) return { error: 'no rows' };
    target.click();
    return { id: target.getAttribute('data-row-id'), cls: target.className };
  })()`, true);
  await sleep(400);
  const selInfo = await evaluateNamed(ws, "selection-style", `(() => {
    const rows = [...document.querySelectorAll('.tree-dialog .tree-scroll .tree-row')];
    const sel = rows.find((r) => r.getAttribute('data-selected') === '1');
    if (!sel) {
      return {
        error: 'nothing marked selected in the DOM',
        byClass: rows.filter((r) => r.className.includes('selected')).length,
        badges: rows.map((r) => (r.getAttribute('data-selected') || r.className.includes('selected') ? 'S' : '.')).join(''),
      };
    }
    // The reference is the SAME row with the selection stripped, not a neighbour:
    // the dialog mounts the rows around the leaf, so every mounted row can be on
    // the active path (a "plain neighbour" is not guaranteed to exist — it was
    // not, at the leaf). Stripping the class is the honest A/B: if .selected
    // paints nothing, the two paints are identical.
    // (indexOf, not a regex: this expression is inside a template literal, where
    // /\s/ silently becomes /s/.)
    const isPlain = (r) => { const c = r.className; return c.indexOf('current') < 0 && c.indexOf('on-active-path') < 0; };
    const other = rows.find((r) => r.getAttribute('data-selected') !== '1' && isPlain(r));
    const paint = (row) => {
      const cs = getComputedStyle(row);
      return [cs.backgroundColor, cs.borderTopColor, cs.borderLeftColor, cs.boxShadow, cs.outlineColor].join('|');
    };
    const selectedPaint = paint(sel);
    const selectedBg = getComputedStyle(sel).backgroundColor;
    const hadClass = sel.classList.contains('selected');
    sel.classList.remove('selected');
    sel.removeAttribute('data-selected');
    void sel.offsetHeight; // force a style recalc before reading again
    const strippedPaint = paint(sel);
    const strippedBg = getComputedStyle(sel).backgroundColor;
    if (hadClass) sel.classList.add('selected');
    sel.setAttribute('data-selected', '1');
    return { selectedId: sel.getAttribute('data-row-id'), selectedPaint, selectedBg, hadClass, strippedPaint, strippedBg, otherId: other ? other.getAttribute('data-row-id') : null, otherClass: other ? other.className : null, otherPaint: other ? paint(other) : null };
  })()`, true);
  console.log("selection:", JSON.stringify(selInfo));
  // The click must change the row's own paint — that is the whole point of
  // clicking a node (「点击节点没有可见区别」 was the bug).
  const selectionVisible = selInfo && !selInfo.error && selInfo.selectedPaint !== selInfo.strippedPaint;
  // `rgba(0, 0, 0, 0)` = the selected row paints nothing at all.
  const selectionPainted = selInfo && !selInfo.error && typeof selInfo.selectedBg === 'string' && selInfo.selectedBg !== 'rgba(0, 0, 0, 0)' && selInfo.selectedBg !== 'transparent';
  if (!selectionVisible || !selectionPainted) {
    console.log("FAIL: clicking a node produces no visible difference");
    process.exitCode = 1;
  }
  console.log("clicked:", JSON.stringify(selBefore));

  // --- folding: a fold must hide the WHOLE subtree, not just the row below.
  // Reported 2026-09-28: 「点折叠只折叠下面一条」. Cause: the hidden set was computed
  // by a left-to-right pass over the FILTERED list, so it lost the folded state at
  // the first row whose own parent was filtered away (tool-call-only replies are
  // dropped by the default filter) and every deeper row survived. The seeded
  // session is a fork + a long tail precisely so this cannot pass vacuously.
  {
    const fold = await evaluateNamed(ws, "fold", `(async () => {
      const scroll = document.querySelector('.tree-dialog .tree-scroll');
      if (!scroll) return { error: 'no tree scroll' };
      const before = Math.round(scroll.scrollHeight / 24);
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      const rows = [...scroll.querySelectorAll('.tree-row')];
      const target = rows.find((r) => (r.querySelector('.tree-fold')?.textContent ?? '').trim() !== '');
      if (!target) return { error: 'no foldable row mounted at the head' };
      const id = target.getAttribute('data-row-id');
      target.querySelector('.tree-fold').click();
      await new Promise((r) => setTimeout(r, 400));
      const after = Math.round(scroll.scrollHeight / 24);
      const glyph = (document.querySelector('.tree-dialog .tree-scroll .tree-row[data-row-id="' + id + '"] .tree-fold')?.textContent ?? '').trim();
      // Unfold again and make sure the list is restored exactly.
      document.querySelector('.tree-dialog .tree-scroll .tree-row[data-row-id="' + id + '"] .tree-fold')?.click();
      await new Promise((r) => setTimeout(r, 400));
      const restored = Math.round(scroll.scrollHeight / 24);
      return { id, before, after, hidden: before - after, glyph, restored };
    })()`, true);
    console.log("fold probe:", JSON.stringify(fold));
    if (fold && !fold.error) {
      if (fold.hidden < 10) {
        console.log(`FAIL: folding the head row hid only ${fold.hidden} row(s) — the whole subtree must collapse`);
        process.exitCode = 1;
      }
      if (fold.glyph !== "\u229e") console.log(`FAIL: the folded row's glyph is ${JSON.stringify(fold.glyph)} after folding (expected ⊞)`);
      if (fold.glyph !== "\u229e") process.exitCode = 1;
      if (fold.restored !== fold.before) {
        console.log(`FAIL: unfolding did not restore the row count (${fold.restored} vs ${fold.before})`);
        process.exitCode = 1;
      }
    } else if (fold?.error) {
      console.log(`FAIL: fold probe could not run: ${fold.error}`);
      structuralFailure = true;
    }
  }

  // --- fold + search: a fold whose own row the search filtered OUT must not hide
  // anything. Otherwise the dialog answers 「（无匹配）」 while matches exist, and the
  // only way out is the 展开全部 chip (the ⊟ is not on screen).
  {
    const probe = await evaluateNamed(ws, "fold+search", `(async () => {
      const scroll = document.querySelector('.tree-dialog .tree-scroll');
      if (!scroll) return { error: 'no tree scroll' };
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      const target = [...scroll.querySelectorAll('.tree-row')].find((r) => (r.querySelector('.tree-fold')?.textContent ?? '').trim() !== '');
      if (!target) return { error: 'no foldable row at the head' };
      const id = target.getAttribute('data-row-id');
      target.querySelector('.tree-fold').click();
      await new Promise((r) => setTimeout(r, 300));
      const folded = Math.round(scroll.scrollHeight / 24);
      const input = document.querySelector('.tree-dialog .tree-search');
      if (!input) return { error: 'no search input', id };
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const type = async (text) => {
        setValue.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
      };
      await type('尾部问题 5');
      const matched = [...scroll.querySelectorAll('.tree-row')].map((r) => (r.querySelector('.tree-entrytext')?.textContent ?? '').slice(0, 12));
      const empty = !!scroll.querySelector('.tree-empty');
      const chip = [...document.querySelectorAll('.tree-dialog .tree-chip')].map((c) => c.textContent.trim()).filter((t) => t.indexOf('展开全部') === 0);
      await type('');
      const unfold = document.querySelector('.tree-dialog .tree-scroll .tree-row[data-row-id="' + id + '"] .tree-fold');
      if (unfold) unfold.click();
      await new Promise((r) => setTimeout(r, 300));
      return { id, folded, matched: matched.length, sample: matched.slice(0, 2), empty, chip, restored: Math.round(scroll.scrollHeight / 24) };
    })()`, true);
    console.log("fold + search:", JSON.stringify(probe));
    if (probe && !probe.error) {
      if (probe.empty || probe.matched === 0) {
        console.log("FAIL: the search matched 尾部问题 5 but the folded (now invisible) head row still hid it — 「（无匹配）」 on a real match");
        process.exitCode = 1;
      }
      if ((probe.chip ?? []).length > 0) {
        console.log(`FAIL: the 展开全部 chip claims a fold while the folded row is filtered out of the list: ${JSON.stringify(probe.chip)}`);
        process.exitCode = 1;
      }
      if (probe.restored !== probe.folded && probe.restored !== 913) {
        console.log(`NOTE: row count after clearing the search + unfolding is ${probe.restored} (folded was ${probe.folded})`);
      }
    } else if (probe?.error) {
      console.log(`FAIL: fold+search probe could not run: ${probe.error}`);
      structuralFailure = true;
    }
  }

  const rowsWithError = report.filter((r) => r.error);
  const overlaps = report.reduce((n, r) => n + (r.overlaps ?? 0), 0);
  const blanks = report.filter((r) => (r.visible ?? 0) === 0).length;
  const heights = [...new Set(report.flatMap((r) => r.heights ?? []))];
  console.log("\nmeasurements: " + report.length + "   total overlapping row pairs: " + overlaps + "   blank viewports: " + blanks);
  console.log("distinct row heights seen:", JSON.stringify(heights));
  console.log("rows assume 24px (ROW_H in TreeDialog.tsx: .tree-dialog .tree-row)");
  // The window math assumes one height; a mismatch is the bug class that made the
  // rows overlap AND drifted the spacers.
  const maxOverflow = report.reduce((m, r) => Math.max(m, r.maxRowOverflow ?? 0), 0);
  const railTotal = report.reduce((n, r) => n + (r.railCount ?? 0), 0);
  const railDrifts = report.reduce((n, r) => n + (r.railDrift?.length ?? 0), 0);
  console.log(`rails measured: ${railTotal}   levels with drift: ${railDrifts}`);
  if (railTotal === 0) {
    console.log("FAIL: no rail elements found — alignment unmeasurable (stale bundle?)");
    structuralFailure = true;
  } else if (railDrifts > 0) {
    console.log(`FAIL: rails at the same level sit at different x: ${JSON.stringify(report.flatMap((r) => r.railDrift ?? []).slice(0, 4))}`);
  }
  // The width contract: one level step === one `.tree-rail` width. Both are read
  // from the DOM, so a stylesheet change that breaks the alignment shows up here
  // even though every per-level check above still passes (they are relative).
  const railWidths = [...new Set(report.flatMap((r) => r.railWidths ?? []))].sort((a, b) => a - b);
  const railSteps = [...new Set(report.flatMap((r) => r.railSteps ?? []))].sort((a, b) => a - b);
  console.log(`rail width: ${JSON.stringify(railWidths)}px   measured step per level: ${JSON.stringify(railSteps)}px`);
  const contractBad = railWidths.length !== 1 || (railWidths.length === 1 && railSteps.some((s) => Math.abs(s - railWidths[0]) > 1.5));
  if (contractBad) {
    console.log(`FAIL: the level step ${JSON.stringify(railSteps)} does not match the .tree-rail width ${JSON.stringify(railWidths)} → indent × step is not the content column`);
  }
  const glyphBad = report.reduce((n, r) => n + (r.glyphMismatch ?? 0), 0);
  if (glyphBad > 0) {
    console.log(`FAIL: ${glyphBad} rows draw a glyph that is not MARKER_GLYPH[data-marker]`);
    structuralFailure = true;
  }
  console.log(`max content overflow past its row: ${maxOverflow}px (≤2 = nothing can paint over a neighbour)`);
  // `scrollHeight` rounds up: a 24px row reads 1px more even though the box is
  // clipped and no neighbour overlaps (heights/overlaps above are the
  // authoritative numbers). A real overflow — content taller than its slot — is
  // the 会话重叠 class of bug and shows up well above that rounding noise.
  if (maxOverflow > 2) {
    console.log("FAIL: row content is taller than its slot → rows paint over each other");
  }
  // 同一层一定要对齐 (the user's actual request): every row of one level must put
  // its content column at exactly one x. The anchor is the FOLD cell (i.e. the
  // start of the content column), not the label: a branch badge or a [label] tag
  // legitimately shifts the label right on some rows of the same level.
  const misalignments = report.flatMap((r) => r.misaligned ?? []);
  if (misalignments.length > 0) {
    console.log(`FAIL: same-level rows sit at different x: ${JSON.stringify(misalignments.slice(0, 4))}`);
  } else {
    console.log("same-level alignment: one content column per level (misaligned: [])");
  }
  const wrongHeights = heights.filter((h) => h !== 24);
  if (wrongHeights.length) console.log(`FAIL: rows measured ${JSON.stringify(heights)} but TreeDialog's ROW_H is 24`);

  const detected = overlaps > 0 || maxOverflow > 2 || wrongHeights.length > 0 || misalignments.length > 0 || railDrifts > 0;
  if (selfCheck) {
    console.log(detected ? "SELF-CHECK PASS: the probe detects the pre-fix geometry" : "SELF-CHECK FAIL: the probe did NOT detect the broken geometry");
    // A structural failure (branch marks / glyphs / rail count wrong) still fails the
    // run: --self-check injects geometry, it must not license a broken marker column.
    // `contractBad` is deliberately NOT part of this: the injection shifts some rows'
    // padding, so the measured level step is expected to be off in self-check mode.
    process.exitCode = detected && !structuralFailure ? 0 : 1;
    if (structuralFailure) console.log("SELF-CHECK: but the marker column itself failed — not a pass");
  } else if (detected || structuralFailure || contractBad || blanks > 0 || rowsWithError.length > 0) {
    console.log("FAIL: the tree list has overlapping rows / blank viewports / a broken marker column");
    process.exitCode = 1;
  } else {
    console.log("PASS: no overlapping rows, no blank viewport, marker column intact");
  }
} catch (e) {
  console.log("FAIL:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  try { app?.kill(); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  // PIPI_KEEP_TMP=1 keeps the seeded session around for post-mortem debugging of
  // a failing run (inspect what the app was actually shown).
  if (!process.env.PIPI_KEEP_TMP) try { rmSync(workDir, { recursive: true, force: true }); } catch { /* locked */ }
}
