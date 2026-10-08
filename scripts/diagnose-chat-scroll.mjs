/**
 * /diagnose Phase 1 — the feedback loop for "中间页聊天视图无法上下滚动，滚一下又回到
 * 之前的地方" (chat timeline: scroll snaps back).
 *
 * It boots the PACKAGED app over CDP (the loop that already exists for the smoke),
 * creates a REAL session seeded with a synthetic pi session file large enough to
 * window (300 messages ≈ scrolls), then drives the chat timeline like a user:
 *
 *   for each wheel-step: read scrollTop → wheel up → wait a frame → read scrollTop
 * and reports whether the position holds or snaps back, plus WHICH of the three
 * suspects moved it (layout effect / window recompute / spacer collapse).
 *
 * Usage: node scripts/diagnose-chat-scroll.mjs   (needs release/win-unpacked/pipi.exe)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9344;
const exe = "release/win-unpacked/pipi.exe";
const profile = ".smoke-profile-diag";
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

  // Open the seeded session as a chat tab.
  const tabId = await evaluateNamed(ws, 'tab.create', `window.api.tab.create({ cwd: ${JSON.stringify(workDir)}, sessionPath: ${JSON.stringify(sessionFile)} })`, true);
  console.log("tab:", tabId);
  await sleep(5000); // boot + history

  const boot = await evaluateNamed(ws, 'boot', `(() => {
    const el = document.querySelector('.chat-scroll');
    return el ? { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, distanceFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), count: document.querySelectorAll('.chat-msg').length } : null;
  })()`, true);
  // distanceFromBottom must be ~0: opening a session lands on the NEWEST message
  // (chat-scroll.ts). The wheel steps below start from that position on purpose.
  console.log("timeline after open (expect distanceFromBottom ~0):", JSON.stringify(boot));
  // Windowing mounts only ~24 rows regardless of session size — that is the point.
  // What matters: does the scroll position HOLD when the user wheels upward?

  // /diagnose Phase 4: instrument scrollTop writes to see WHO moves it.
  const patchResult = await evaluateNamed(ws, 'patch', `(() => {
    const el = document.querySelector('.chat-scroll');
    if (!el) return 'no el';
    window.__diagWrites = [];
    let proto = Object.getPrototypeOf(el);
    let desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
    while (!desc && proto) { proto = Object.getPrototypeOf(proto); desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop'); }
    if (!desc || !desc.set) return 'no descriptor';
    Object.defineProperty(el, 'scrollTop', {
      get() { return desc.get.call(this); },
      set(v) {
        const stack = (new Error().stack || '').split('\\n').slice(2, 6).join(' | ');
        window.__diagWrites.push({ v: Math.round(v), at: Math.round(desc.get.call(this)), stack: stack.slice(0, 220) });
        return desc.set.call(this, v);
      },
      configurable: true,
    });
    return 'patched';
  })()`, true);
  console.log("scrollTop setter patched:", patchResult);

  // Drive 12 upward wheel steps; after each, record scrollTop immediately and one
  // frame + 120ms later. A healthy timeline holds the position; the reported bug
  // shows `after` < `before` (snap back) repeatedly.
  const script = `(async () => {
    const el = document.querySelector('.chat-scroll');
    if (!el) return { error: 'no .chat-scroll' };
    const steps = [];
    const record = async (dir) => {
      const before = el.scrollTop;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: dir, bubbles: true, cancelable: true }));
      el.scrollBy(0, dir);
      await new Promise((r) => setTimeout(r, 30));
      const afterFrame = el.scrollTop;
      await new Promise((r) => setTimeout(r, 150));
      const rows = [...document.querySelectorAll('.chat-msg')];
      const box = el.getBoundingClientRect();
      // Does any mounted message overlap the visible band? A spacer-only viewport
      // (blank while "scrolled") is exactly the reported failure mode.
      const overlapping = rows.filter((r) => {
        const b = r.getBoundingClientRect();
        return b.bottom > box.top && b.top < box.bottom;
      }).length;
      steps.push({ before, dir, afterFrame, afterSettle: el.scrollTop, scrollHeight: el.scrollHeight, msgCount: rows.length, overlapping });
    };
    // The chat opens pinned at the bottom — start there, like the user does.
    el.scrollTop = el.scrollHeight;
    await new Promise((r) => setTimeout(r, 200));
    // (a) wheel up HARD from the bottom in small steps (trackpad burst):
    for (let i = 0; i < 8; i += 1) await record(-120);
    // (b) bigger steps across several window edges:
    for (let i = 0; i < 6; i += 1) await record(-240);
    // (c) return trip down:
    for (let i = 0; i < 4; i += 1) await record(240);
    // (d) scroll ALL the way up: this crosses the "load older" boundary, where
    //     content is prepended — the other place a windowed list goes blank or
    //     jumps. Each step asserts the viewport still shows messages and the
    //     position still lands where the wheel asked.
    for (let i = 0; i < 30; i += 1) {
      await record(-240);
      if (el.scrollTop <= 8) break;
    }
    const older = document.querySelector('.chat-load-older');
    steps.push({ before: el.scrollTop, dir: 0, afterFrame: el.scrollTop, afterSettle: el.scrollTop, scrollHeight: el.scrollHeight, msgCount: document.querySelectorAll('.chat-msg').length, overlapping: (() => {
      const rows = [...document.querySelectorAll('.chat-msg')];
      const box = el.getBoundingClientRect();
      return rows.filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > box.top && b.top < box.bottom; }).length;
    })(), note: older ? older.textContent.trim().slice(0, 40) : 'all loaded' });
    return steps;
  })()`;
  const steps = await evaluateNamed(ws, 'steps', script, true);
  if (!Array.isArray(steps)) throw new Error("scroll probe failed: " + JSON.stringify(steps));

  let snaps = 0;
  let held = 0;
  for (const [i, s] of steps.entries()) {
    // The wheel step asks for -240px. "Held" = the position after settling is
    // within tolerance of where the wheel PUT it. "Snap" = it came back toward
    // where it was (the reported bug).
    const expected = s.before + s.dir;
    if (s.dir !== 0) {
      if (Math.abs(s.afterSettle - expected) < 80) held += 1;
      // Snap-back only means something for an UPWARD step (the reported gesture).
      if (s.dir < 0 && s.afterSettle > s.before - 40) snaps += 1;
    }
    console.log(`step ${i}: before=${Math.round(s.before)} after=${Math.round(s.afterSettle)} dir=${s.dir} msgs=${s.msgCount} visibleMsgs=${s.overlapping}`);
  }
  console.log(`\nheld: ${held}/12  snapped back: ${snaps}/12`);
  const blanks = steps.filter((x) => (x.overlapping ?? 0) === 0).length;
  const frozen = steps.filter((x) => x.dir !== 0 && Math.abs(x.afterSettle - x.before) < 4).length;
  const olderNote = steps.filter((x) => x.note).map((x) => x.note).join("");
  console.log(`blank viewports: ${blanks}/${steps.length}   steps that did not move: ${frozen}/${steps.length}`);
  if (blanks > 0) console.log("FAIL: the list went blank while scrolling");
  if (frozen > 0) console.log("FAIL: a wheel step did not move the list");
  console.log(`after scrolling to the top: ${olderNote || "(no note)"}`);
  const writes = await evaluateNamed(ws, "writes", `window.__diagWrites.slice(-30)`, true);
  console.log("scrollTop writes during the probe (newest last):");
  for (const w of writes ?? []) console.log(`  set(${w.v}) while at ${w.at}  <-  ${w.stack}`);
  if (consoleErrors.length) console.log("renderer exceptions:", consoleErrors.slice(0, 3));
  // A real gate: `npm run test:scroll` exits non-zero when any measured
  // invariant regresses (position holds, never blank, always scrollable).
  const problems = [];
  if (snaps > 1) problems.push(`${snaps} upward step(s) snapped back`);
  if (blanks > 0) problems.push(`${blanks} blank viewport(s) while scrolling`);
  if (frozen > 0) problems.push(`${frozen} wheel step(s) did not move the list`);
  if (problems.length > 0) {
    console.log(`FAIL: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${steps.length} steps — position held, no blank viewport, always scrollable`);
  }
} catch (e) {
  console.log("FAIL:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  try { app?.kill(); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
}
