/**
 * /diagnose — 分支窗口（会话树）弹「界面渲染出错，已阻止白屏 / RangeError: Maximum call
 * stack size exceeded」。
 *
 * Phase 1 loop: boot the app over CDP with a SEEDED session, open the branch dialog
 * the way a user does, and look for the crash screen + the renderer exception.
 *
 * Two seed shapes, because two mechanisms explain the same symptom:
 *   --shape=chain    a LINEAR session (pi chains every entry onto the previous one,
 *                    so a long session is a deep chain → recursion depth = entries)
 *   --shape=dup-ring duplicate entry ids whose NON-LAST occurrence points back into
 *                    its own descendants (buildTreeFromEntries' cycle detection reads
 *                    the LAST parentId per id, so this ring slips through and the
 *                    tree it returns contains a cycle)
 *
 * RED = the dialog shows the crash screen (or the renderer throws RangeError).
 *
 * Usage: node scripts/diagnose-tree-crash.mjs [--entries=20000] [--shape=chain|dup-ring] [--keep]
 *        (needs out/ built: npm run build — the loop runs `npx electron .`, no packaging)
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
const PORT = 9353;
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const SHAPE = arg("shape", "chain");
const ENTRIES = Number(arg("entries", "20000"));
const KEEP = argv.includes("--keep");
const profile = `.smoke-profile-tree-crash-${SHAPE}-${process.pid}`;

if (!existsSync(join("out", "main", "index.js"))) {
  console.log("FAIL: out/main/index.js not found — run `npm run build` first");
  process.exit(2);
}
rmSync(profile, { recursive: true, force: true });

// --- seeded session ---------------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), "pipi-crash-"));
const sessionsDir = join(workDir, "sessions-test");
mkdirSync(sessionsDir, { recursive: true });
const lines = [JSON.stringify({ type: "session", id: "s0", version: 3, cwd: workDir, timestamp: new Date().toISOString() })];
let n = 0;
const next = () => `e${n++}`;
const push = (id, parentId, role, text) =>
  lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }] } }));

//   --shape=bush     the same NUMBER of entries arranged with a shallow depth
//                    (all children of one root). Discriminates "depth" from
//                    "entry count": if the bush crashes too, depth is not the cause.
if (SHAPE === "chain") {
  // pi's real shape: every entry chained onto the previous one.
  let parent = null;
  for (let i = 0; i < ENTRIES; i += 1) {
    const id = next();
    push(id, parent, i % 2 === 0 ? "user" : "assistant", `链 ${i}`);
    parent = id;
  }
} else if (SHAPE === "bush") {
  const root = next();
  push(root, null, "user", "根");
  for (let i = 0; i < ENTRIES; i += 1) push(next(), root, i % 2 === 0 ? "user" : "assistant", `枝叶 ${i}`);
} else if (SHAPE === "dup-ring") {
  // A short sane chain, then a duplicate-id ring:
  //   X#1 → B          (edge N_B.children += N_X)
  //   B   → X          (edge N_X.children += N_B)
  //   X#2 → null       (last occurrence: cycle detection sees parentOf(X)=null)
  // Result: the old build produced X.children=[B] AND B.children=[X] — a cycle in
  // the BUILT tree (unreachable from the roots, so only the tree walk sees it).
  let parent = null;
  const chainIds = [];
  for (let i = 0; i < 40; i += 1) {
    const id = next();
    push(id, parent, i % 2 === 0 ? "user" : "assistant", `链 ${i}`);
    chainIds.push(id);
    parent = id;
  }
  void chainIds;
  push("dupX", "dupB", "assistant", "X#1 → B");
  push("dupB", "dupX", "user", "B → X");
  push("dupX", null, "assistant", "X#2 → null (last wins)");
} else {
  console.log(`FAIL: unknown --shape=${SHAPE}`);
  process.exit(2);
}
const sessionFile = join(sessionsDir, "crash-session.jsonl");
writeFileSync(sessionFile, lines.join("\n") + "\n");
const seededCount = lines.length - 1;
console.log(`seeded ${seededCount} entries (shape=${SHAPE}) → ${sessionFile}`);

// --- app over CDP -----------------------------------------------------------
const electronPath = require("electron");
let app = null;
let msgId = 0;
const pending = new Map();
const exceptions = [];
let pausedFrames = [];

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
        const d = msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? "";
        exceptions.push(String(d).slice(0, 300));
      }
      if (msg.method === "Runtime.consoleAPICalled" && /RangeError|Maximum call stack/.test(JSON.stringify(msg.params?.args ?? []))) {
        exceptions.push(String(msg.params.args.map((a) => a.description ?? a.value ?? "").join(" ")).slice(0, 300));
      }
      if (msg.method === "Debugger.paused") {
        // Where the renderer is stuck when it stops answering (a busy loop still
        // hits V8 interrupt checks, so Debugger.pause lands inside it).
        pausedFrames = (msg.params?.callFrames ?? []).map(
          (f) => `${f.functionName || "(anon)"} @ ${String(f.url).replace(/^.*\//, "")}:${f.location.lineNumber + 1}`,
        );
      }
    };
  });
}
function send(ws, method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const id = ++msgId;
    // A dead/replaced CDP target never answers; report that instead of hanging the
    // loop forever (an unsettled await looks exactly like "the app hung").
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ result: { exceptionDetails: { exception: { description: `NO CDP RESPONSE to ${method} after ${timeoutMs}ms (target gone?)` } } } });
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(ws, expression, awaitPromise = false) {
  const r = await send(ws, "Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  return r.result?.result?.value;
}
async function getWsUrl() {
  for (let i = 0; i < 80; i += 1) {
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

app = spawn(electronPath, [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});

let exitCode = 0;
let wsRef = null;
try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) throw new Error("no CDP target");
  const ws = await connect(wsUrl);
  wsRef = ws;
  await send(ws, "Runtime.enable");
  await send(ws, "Debugger.enable");
  await sleep(2500);

  const tabId = await evaluate(ws, `window.api.tab.create({ cwd: ${JSON.stringify(workDir)}, sessionPath: ${JSON.stringify(sessionFile)} })`, true);
  console.log("tab:", tabId);
  await sleep(5000);

  const opened = await evaluate(ws, `(() => {
    const b = [...document.querySelectorAll('.chat-header-btn')].find((x) => /会话分支/.test(x.title || x.textContent || ''));
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  })()`, true);
  console.log("open dialog:", opened);

  // The dialog mounts, the file snapshot lands, the walk runs. Watch for the crash.
  let crash = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    crash = await evaluate(ws, `(() => {
      const el = document.querySelector('.crash-screen');
      if (!el) return null;
      return { text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
    })()`, true);
    if (crash) break;
  }
  const rows = crash ? null : await evaluate(ws, `document.querySelectorAll('.tree-dialog .tree-scroll .tree-row').length`, true);
  console.log(crash ? `CRASH SCREEN: ${JSON.stringify(crash)}` : `no crash screen (tree rows mounted: ${rows})`);

  // The crash must not merely move to the NEXT thing that touches the tree: scroll
  // through the whole list, fold the head row, search, unfold — and re-check the
  // crash screen after each (flattenTree / foldedAwayIds / the window math all run
  // on the same deep structure).
  if (!crash) {
    const probe = await evaluate(ws, `(async () => {
      const scroll = document.querySelector('.tree-dialog .tree-scroll');
      if (!scroll) return { error: 'no tree scroll', state: {
        dialog: !!document.querySelector('.tree-dialog'),
        crash: !!document.querySelector('.crash-screen'),
        panes: document.querySelectorAll('.chat-header-btn').length,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
      } };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const crashed = () => { const el = document.querySelector('.crash-screen'); return el ? (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : null; };
      const out = { crashes: [], scrollHeight: Math.round(scroll.scrollHeight), rows: {} };
      for (const frac of [0, 0.35, 0.7, 1]) {
        scroll.scrollTop = scroll.scrollHeight * frac;
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(400);
        const c = crashed();
        if (c) out.crashes.push('scroll ' + frac + ': ' + c);
        out.rows[frac] = scroll.querySelectorAll('.tree-row').length;
      }
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(400);
      const fold = [...scroll.querySelectorAll('.tree-row')].find((r) => (r.querySelector('.tree-fold')?.textContent ?? '').trim() !== '');
      if (fold) {
        fold.querySelector('.tree-fold').click();
        await wait(500);
        const c = crashed();
        if (c) out.crashes.push('fold: ' + c);
      }
      out.folded = !!fold;
      const input = document.querySelector('.tree-dialog .tree-search');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      if (input) {
        setValue.call(input, '0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(600);
        out.matched = scroll.querySelectorAll('.tree-row').length;
        const c = crashed();
        if (c) out.crashes.push('search: ' + c);
        if (out.matched === 0) out.crashes.push('search matched nothing (probe is vacuous)');
      }
      if (input) {
        setValue.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(400);
      }
      return out;
    })()`, true);
    console.log("probe (scroll/fold/search at depth):", JSON.stringify(probe));
    if (probe && (probe.error || (probe.crashes ?? []).length > 0)) {
      console.log("FAIL: the tree crashed on something other than the first render");
      exitCode = 1;
    }
    // A renderer that stopped answering is FROZEN (not crashed): ask V8 where.
    if (JSON.stringify(probe ?? {}).includes("NO CDP RESPONSE")) {
      await send(ws, "Debugger.pause", {}, 15000);
      await sleep(1500);
      console.log("FROZEN renderer stack:", JSON.stringify(pausedFrames.slice(0, 14)));
      exitCode = 1;
    }
  }
  if (exceptions.length) console.log("renderer exceptions:", JSON.stringify(exceptions.slice(0, 3), null, 1));

  console.log(`[step ${new Date().toISOString().slice(11, 23)}] verdict`);
  // --- paging (the point of Step 1): open on the TAIL, load older pages on demand -----
  // A 20000-entry session must NOT be read whole: the tail page is bounded (<=400 entries),
  // the button loads the page before it, and scrolling to the top does the same.
  if (!crash) {
    const paging = await evaluate(ws, `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Measure a FRESH open: the earlier probes left a search token and a fold behind, and
      // both hide rows — "did the first paint land on the newest entry" would be a lie.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(600);
      const reopened = [...document.querySelectorAll('.chat-header-btn')].find((x) => /会话分支/.test(x.title || x.textContent || ''));
      if (!reopened) return { error: 'no 会话分支 button to reopen the dialog' };
      reopened.click();
      await wait(3000);
      const status = () => document.querySelector('.tree-dialog .tree-status')?.textContent ?? '';
      const total = () => { const t = status(); const a = t.indexOf('/'); const b = t.indexOf(')', a); return a < 0 || b < 0 ? -1 : Number(t.slice(a + 1, b)); };
      const bar = () => document.querySelector('.tree-dialog .tree-earlier-btn');
      const leaf = document.querySelector('.tree-dialog .tree-scroll .tree-row.current');
      const out = {
        firstPaintRows: total(),
        selectedText: (document.querySelector('.tree-dialog .tree-detail-text')?.textContent ?? '').slice(0, 40),
        statusText: status().trim().slice(0, 60),
        currentLeafId: leaf?.getAttribute('data-row-id') ?? null,
        mountedIds: [...document.querySelectorAll('.tree-dialog .tree-scroll .tree-row')].map((r) => r.getAttribute('data-row-id')).slice(0, 3),
        hasButton: !!bar(),
      };
      const topRow = () => {
        const scroll = document.querySelector('.tree-dialog .tree-scroll');
        if (!scroll) return null;
        const box = scroll.getBoundingClientRect();
        const hit = [...scroll.querySelectorAll('.tree-row')].find((r) => r.getBoundingClientRect().bottom > box.top + 1);
        return hit?.getAttribute('data-row-id') ?? null;
      };
      const start = total();
      out.topBefore = topRow();
      if (bar()) {
        bar().click();
        await wait(2500);
        out.afterButton = total();
        // Prepending a page must not move what the user is looking at.
        out.topAfter = topRow();
        out.anchored = out.topBefore === out.topAfter;
      }
      const scroll = document.querySelector('.tree-dialog .tree-scroll');
      if (scroll) {
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait(2500);
        out.afterScrollTop = total();
      }
      out.crash = document.querySelector('.crash-screen') ? 'crash screen after paging' : null;
      return out;
    })()`, true);
    console.log("paging probe:", JSON.stringify(paging));
    // The newest data the seed writes (the first paint must land here; the leaf itself may
    // be a pi-appended settings entry the default filter hides, so the selection falls back
    // to the nearest visible row).
    const newest = SHAPE === "bush" ? `枝叶 ${ENTRIES - 1}` : SHAPE === "chain" ? `链 ${ENTRIES - 1}` : "X#1";
    if (!paging || paging.crash) {
      console.log("FAIL: the dialog crashed while paging");
      exitCode = 1;
    }
    if (paging && !(paging.selectedText ?? "").includes(newest)) {
      console.log(`FAIL: the first paint did not land on the newest entry (expected ${JSON.stringify(newest)}, got ${JSON.stringify(paging.selectedText)})`);
      exitCode = 1;
    }
    if (paging && paging.firstPaintRows <= 0) {
      console.log("FAIL: the first paint rendered no rows");
      exitCode = 1;
    }
    // A session small enough to fit one page has nothing older: no button is correct.
    if (paging && (paging.hasButton || paging.afterButton !== undefined)) {
      const grew = paging.afterButton > paging.firstPaintRows && paging.afterScrollTop > paging.afterButton;
      if (!grew || paging.anchored === false) {
        console.log("FAIL: the dialog did not page the way Step 1 promises (bounded read, older pages on demand, viewport anchored)");
        exitCode = 1;
      }
    }
  }

  await sleep(1500); // the app's debug log is batched — let the tail land
  const logPath = join(profile, "pipi-debug.log");
  if (existsSync(logPath)) {
    const all = readFileSync(logPath, "utf8").split("\n");
    const crashLines = all.filter((l) => l.includes("REACT-CRASH") || l.includes("renderer-ERROR"));
    if (crashLines.length) console.log("app log:", crashLines.slice(-3).join("\n"));
    const pageLines = all.filter((l) => l.includes("from-file tail") || l.includes("from-file before"));
    for (const l of pageLines) console.log("page:", l.replace(/^.*\[tree\] /, ""));
    // The whole point: one bounded page, not the session.
    const tailEntries = pageLines.map((l) => Number(/from-file tail entries=(\d+)/.exec(l)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
    if (tailEntries.length > 0 && Math.max(...tailEntries) > 400) {
      console.log(`FAIL: the open page was not bounded (entries=${Math.max(...tailEntries)})`);
      exitCode = 1;
    }
  }

  const red = Boolean(crash) || exceptions.some((e) => /Maximum call stack/.test(e));
  if (red) {
    console.log(`\nRED: the branch dialog reproduced the reported crash (shape=${SHAPE}, entries=${seededCount})`);
    exitCode = 1;
  } else {
    console.log(`\nGREEN: no crash (shape=${SHAPE}, entries=${seededCount})`);
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`FAIL: loop error — ${msg}`);
  if (msg.includes("NO CDP RESPONSE")) {
    // The renderer stopped answering = frozen in a busy loop (not crashed: no
    // crash screen, no render-process-gone). A busy loop still hits V8 interrupt
    // checks, so Debugger.pause lands inside it and hands us the stack.
    try {
      await send(wsRef, "Debugger.pause", {}, 15000);
      await sleep(1500);
      console.log("FROZEN renderer stack:", JSON.stringify(pausedFrames.slice(0, 14)));
    } catch {
      console.log("FROZEN renderer stack: could not pause the target");
    }
  }
  exitCode = 2;
}
app.kill();
await sleep(500);
if (!KEEP) {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the session file — the temp dir is disposable */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the app may still hold the profile — at worst a stale dir remains */
  }
}
process.exit(exitCode);
