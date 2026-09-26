// Robustness smoke: boot the PACKAGED app over CDP and assert the invariants
// this batch of work introduced — without needing a model reply (so it passes or
// fails on client behaviour alone).
//
// What it covers that unit tests cannot:
//   - the startup ipcMain.handle patch (every `window.api` invoke goes through it)
//   - the new log level gate end-to-end (renderer → IPC → level check → file)
//   - "an error is not data": a failed file read must not return content
//   - no crash screen, no uncaught renderer errors, no spontaneous failure bar,
//     and no false "应用繁忙" pill on an idle app
//
// Usage: node scripts/robustness-smoke.mjs   (needs release/win-unpacked/pipi.exe)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9342;
const exe = "release/win-unpacked/pipi.exe";
const profile = ".smoke-profile-robustness"; // matches .gitignore’s .smoke-profile*/
const MARKER = `smoke-marker-${Date.now()}`;
const DEBUG_ONLY = `smoke-debug-only-${Date.now()}`;

if (!existsSync(exe)) {
  console.log(`FAIL: ${exe} not found — run \`npm run dist:dir\` first`);
  process.exit(2);
}
rmSync(profile, { recursive: true, force: true });
const workDir = mkdtempSync(join(tmpdir(), "pipi-smoke-"));

const mainLines = [];
let app = null;
function launch(port = PORT) {
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (d) => {
      const s = String(d);
      mainLines.push(s);
      if (/uncaught|unhandled|crash/i.test(s)) process.stdout.write("[main] " + s.slice(0, 300));
    });
  }
  return child;
}
app = launch();

async function getWsUrl(port = PORT) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* booting */
    }
    await sleep(500);
  }
  return null;
}

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
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
      // Renderer-side failures that used to be invisible.
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description ?? "").slice(0, 200));
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        consoleErrors.push((msg.params.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 200));
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
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  }
  return r.result?.result?.value;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

let ws;
try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) throw new Error("no CDP target (packaged app never came up)");
  ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");
  await sleep(2500); // let the renderer paint

  check("boot: #root has children", await evaluate(ws, `!!document.querySelector('#root')?.children.length`));
  check("no crash screen on boot", await evaluate(ws, `!document.querySelector('.crash-screen')`));
  check("no false '应用繁忙' pill while idle", await evaluate(ws, `!document.querySelector('.busy-pill')`));
  check("no failure bar on a clean boot", await evaluate(ws, `!document.querySelector('.failure-bar')`));

  check(
    "api surface: new/changed bridges exist",
    await evaluate(
      ws,
      `['onAppBusy','debug','onTabsUpdate','onActiveTab'].every((k) => k in window.api) &&
       typeof window.api.file.read === 'function' && typeof window.api.tab.create === 'function'`,
    ),
  );

  // IPC round-trip through the startup-patched ipcMain.handle.
  const tabCount = await evaluate(ws, `window.api.tab.list().then((t) => Array.isArray(t) ? t.length : -1)`, true);
  check("ipc round-trip (patched handler): tab.list() answers", typeof tabCount === "number" && tabCount >= 0, `count=${tabCount}`);

  // Log level gate, end to end: info must land, debug must not (PIPI_LOG unset).
  await evaluate(ws, `window.api.debug.log(${JSON.stringify(MARKER)})`);
  await evaluate(ws, `window.api.debug.log(${JSON.stringify(DEBUG_ONLY)}, "debug")`);
  await sleep(600); // batched writes flush every 200ms

  // File ops on a real temp dir (local channel, explicit preview root).
  const fileWrite = await evaluate(
    ws,
    `window.api.file.write(undefined, "smoke.txt", "hello", ${JSON.stringify(workDir)})`,
    true,
  );
  check("file.write → {ok:true}", fileWrite?.ok === true, JSON.stringify(fileWrite));

  const fileRead = await evaluate(ws, `window.api.file.read(undefined, "smoke.txt", ${JSON.stringify(workDir)})`, true);
  check("file.read returns the content", fileRead?.content === "hello", `content=${JSON.stringify(fileRead?.content)}`);

  const missing = await evaluate(ws, `window.api.file.read(undefined, "nope.txt", ${JSON.stringify(workDir)})`, true);
  check(
    "error is NOT data: a failed read has error AND empty content",
    !!missing?.error && missing?.content === "",
    `error=${JSON.stringify(String(missing?.error).slice(0, 80))} content=${JSON.stringify(missing?.content)}`,
  );

  const listing = await evaluate(ws, `window.api.file.list(undefined, undefined, ${JSON.stringify(workDir)})`, true);
  check("file.list returns the written file", Array.isArray(listing) && listing.some((n) => n.name === "smoke.txt"), `${Array.isArray(listing) ? listing.length : "?"} entries`);

  const removed = await evaluate(ws, `window.api.file.delete(undefined, "smoke.txt", ${JSON.stringify(workDir)})`, true);
  check("file.delete → {ok:true}", removed?.ok === true, JSON.stringify(removed));

  // Tab lifecycle (pty + the tab registry the sidebar follows).
  const tabId = await evaluate(ws, `window.api.tab.create({ cwd: ${JSON.stringify(workDir)} })`, true);
  check("tab.create returns an id", typeof tabId === "string" && tabId.length > 0, String(tabId));
  await sleep(4000);
  const alive = await evaluate(ws, `window.api.tab.alive(${JSON.stringify(tabId)})`, true);
  check("tab.alive after creation (no crash on spawn)", alive === true, String(alive));
  // Branch-tree dialog: opening it must work on a real session and must keep the
  // virtualized list self-consistent — the row window is mounted between two
  // spacers whose heights must add up to the full list height, otherwise the
  // scrollbar range changes while scrolling (the reported "滑动卡顿"). A fresh
  // session has no entries, so this also covers the empty-state path after the
  // row-rendering refactor (rows are now a memoized component).
  await evaluate(
    ws,
    `(() => { const b = [...document.querySelectorAll('.chat-header-btn')].find((x) => /会话分支/.test(x.title || x.textContent || '')); if (b) { b.click(); return true; } return false; })()`,
    true,
  );
  await sleep(1200);
  const treeOpen = await evaluate(ws, `!!document.querySelector('.tree-dialog')`);
  check("tree dialog opens on a live tab", treeOpen === true, String(treeOpen));
  if (treeOpen) {
    const rowsInfo = await evaluate(
      ws,
      `(() => {
         // Scoped to the DIALOG: the sidebar file tree uses .tree-scroll too.
         const scroll = document.querySelector('.tree-dialog .tree-scroll');
         if (!scroll) return { error: 'no .tree-scroll' };
         const rows = scroll.querySelectorAll('.tree-row').length;
         return { rows, hasEmpty: !!scroll.querySelector('.tree-empty'), scrollTop: scroll.scrollTop };
       })()`,
      true,
    );
    check("tree dialog renders without a crash", await evaluate(ws, `!document.querySelector('.crash-screen')`));
    check("tree dialog body is coherent (rows or an empty-state note)", rowsInfo?.hasEmpty === true || (rowsInfo?.rows ?? 0) > 0, JSON.stringify(rowsInfo));
    // 思维导图视图 is the default: only your messages and the AI's replies, so a
    // rendered row must never be a tool call / bookkeeping entry.
    const mindInfo = await evaluate(
      ws,
      `(() => {
         const dialog = document.querySelector('.tree-dialog');
         const chips = [...dialog.querySelectorAll('.tree-chip')].map((c) => c.textContent.trim());
         const active = [...dialog.querySelectorAll('.tree-chip.active')].map((c) => c.textContent.trim());
         const rows = [...dialog.querySelectorAll('.tree-scroll .tree-row')];
         const roles = [...new Set(rows.map((r) => r.getAttribute('data-role')))];
         return { chips, active, rows: rows.length, roles };
       })()`,
      true,
    );
    check(
      "mind-map view is the default (导图 active, 完整 offered)",
      mindInfo?.active?.includes("导图") === true && mindInfo?.chips?.includes("完整") === true,
      JSON.stringify(mindInfo?.active),
    );
    check(
      "mind-map rows are only user/assistant (no tool-call rows)",
      (mindInfo?.rows ?? 0) === 0 || (mindInfo?.roles ?? []).every((r) => r === "user" || r === "assistant"),
      JSON.stringify(mindInfo?.roles),
    );
    // The card layout: a speaker line + a text line per row, and the 完整 view must
    // switch the same dialog to the flat log rows (both are one dialog, one state).
    const cardInfo = await evaluate(
      ws,
      `(() => {
         const rows = [...document.querySelectorAll('.tree-dialog .tree-scroll .tree-row')];
         const cards = rows.filter((r) => r.querySelector('.tree-card')).length;
         const heads = rows.filter((r) => r.querySelector('.tree-card-head')).length;
         const texts = rows.filter((r) => r.querySelector('.tree-card-text')).length;
         return { rows: rows.length, cards, heads, texts };
       })()`,
      true,
    );
    check(
      "mind-map rows use the card layout (speaker line + text line)",
      (cardInfo?.rows ?? 0) === (cardInfo?.cards ?? 0) && (cardInfo?.rows ?? 0) === (cardInfo?.heads ?? 0) && (cardInfo?.rows ?? 0) === (cardInfo?.texts ?? 0),
      JSON.stringify(cardInfo),
    );
    const fullSwitch = await evaluate(
      ws,
      `(() => {
         const btn = [...document.querySelectorAll('.tree-dialog .tree-chip')].find((c) => c.textContent.trim() === '完整');
         if (!btn) return { switched: false };
         btn.click();
         return { switched: true };
       })()`,
      true,
    );
    await sleep(200);
    const afterSwitch = await evaluate(
      ws,
      `(() => {
         const active = [...document.querySelectorAll('.tree-dialog .tree-chip.active')].map((c) => c.textContent.trim());
         const cards = document.querySelectorAll('.tree-dialog .tree-card').length;
         return { active, cards };
       })()`,
      true,
    );
    check(
      "完整 view switches the same dialog off the card layout",
      fullSwitch?.switched === true && afterSwitch?.active?.includes("完整") === true && (afterSwitch?.cards ?? 1) === 0,
      JSON.stringify(afterSwitch),
    );
  }
  // Close it the way a user would: the 关闭 button, else the overlay.
  await evaluate(
    ws,
    `(() => {
       const b = [...document.querySelectorAll('.tree-dialog .btn')].find((x) => /关闭/.test(x.textContent || ''));
       if (b) { b.click(); return 'button'; }
       const ov = document.querySelector('.dialog-overlay');
       if (ov) { ov.click(); return 'overlay'; }
       return 'none';
     })()`,
    true,
  );
  await sleep(600);
  check("tree dialog closes", (await evaluate(ws, `!document.querySelector('.tree-dialog')`)) === true);

  await evaluate(ws, `window.api.tab.close(${JSON.stringify(tabId)})`, true);
  await sleep(800);
  const aliveAfter = await evaluate(ws, `window.api.tab.alive(${JSON.stringify(tabId)})`, true);
  check("tab.close removes it", aliveAfter === false, String(aliveAfter));

  check("no crash screen after all actions", await evaluate(ws, `!document.querySelector('.crash-screen')`));

  const noise = consoleErrors.filter((e) => !/ResizeObserver/.test(e));
  check("no uncaught renderer errors/unhandled rejections", noise.length === 0, noise.join(" | "));

  await evaluate(ws, `window.api.debug.log("smoke-finished")`);
} catch (e) {
  check("smoke run completed", false, e instanceof Error ? e.message : String(e));
} finally {
  try {
    app?.kill();
  } catch {
    /* already gone */
  }
  await sleep(1500);

  // ---- phase 2: a damaged config file is surfaced to the user --------------
  // (verified end-to-end: verifyConfigFiles at startup → config:problems pull →
  // failure center bar, plus the damaged bytes preserved as .corrupt-*)
  try {
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "projects.json"), '[{"id":"p1","type":"local"');
    // A fresh port: the phase-1 endpoint can outlive its process for a moment
    // (TIME_WAIT), and reusing it makes the second boot unreachable.
    const phase2Port = PORT + 1;
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json`);
        await sleep(250); // still answering → the old endpoint is alive
      } catch {
        break;
      }
    }
    app = launch(phase2Port);
    const wsUrl2 = await getWsUrl(phase2Port);
    if (!wsUrl2) throw new Error("phase 2: no CDP target (second boot did not come up)");
    ws = await connect(wsUrl2);
    await send(ws, "Runtime.enable");
    await sleep(4000);

    check("corrupt config: failure bar shown to the user", await evaluate(ws, `!!document.querySelector('.failure-bar')`));
    check(
      "corrupt config: the bar names the file (not a generic error)",
      await evaluate(ws, `(document.querySelector('.failure-bar')?.textContent ?? '').includes('配置文件损坏')`),
      await evaluate(ws, `(document.querySelector('.failure-bar')?.textContent ?? '').slice(0, 120)`),
    );
    check("corrupt config: no crash screen", await evaluate(ws, `!document.querySelector('.crash-screen')`));
    const corrupted = readdirSync(profile).filter((f) => f.includes("projects.json.corrupt-"));
    check("corrupt config: damaged bytes preserved as .corrupt-*", corrupted.length === 1, corrupted.join(","));
    check(
      "corrupt config: damaged bytes kept verbatim",
      corrupted[0] ? readFileSync(join(profile, corrupted[0]), "utf8") === '[{"id":"p1","type":"local"' : false,
    );
  } catch (e) {
    check("corrupt-config phase completed", false, e instanceof Error ? e.message : String(e));
  } finally {
    try {
      app?.kill();
    } catch {
      /* already gone */
    }
    await sleep(1200);
  }

  // Log-file assertions: the file must exist, carry the info line, and NOT
  // carry the debug line (that is the whole point of the level gate).
  const logPath = join(profile, "pipi-debug.log");
  let log = "";
  try {
    log = readFileSync(logPath, "utf8");
  } catch {
    /* missing log is itself a failure, reported below */
  }
  check("log file written", log.length > 0, `${logPath} (${log.length} bytes)`);
  check("log keeps info lines (renderer → IPC → file)", log.includes(MARKER));
  check("log drops debug lines by default (PIPI_LOG gate)", !log.includes(DEBUG_ONLY));
  check("log carries no per-message RPC frames at default level", !/\[rpc\][^\n]*SEND /.test(log), "no '[rpc] SEND' lines");
  check("main-process startup is recorded ([mem] startup)", /\[mem\] startup/.test(log));

  writeFileSync(join(profile, "smoke-console-errors.txt"), consoleErrors.join("\n"));
  rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failed.length})`}  ${results.length - failed.length}/${results.length} checks`);
  if (mainLines.length) console.log("main-process output captured:", mainLines.join("").slice(0, 400));
  process.exit(failed.length === 0 ? 0 : 1);
}
