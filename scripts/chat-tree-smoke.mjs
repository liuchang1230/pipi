// Session-tree dialog smoke: open a tab with history, click 分支, verify the
// tree renders, select a user node, fork from it.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9340;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-profile8"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});
electron.stderr.on("data", () => {});
const sleepMs = (ms) => sleep(ms);

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleepMs(500);
  }
  return null;
}
let msgId = 0;
const pending = new Map();
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
  const r = await send(ws, "Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function clickSel(ws, selector, index = 0) {
  const rect = await evaluate(ws, `(() => { const els = document.querySelectorAll(${JSON.stringify(selector)}); const el = els[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) return false;
  await send(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await send(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  return true;
}

const SESSION = "C:/Users/chang/.pi/agent/sessions/--C--Users-chang-AppData-Local-Temp-pi-flicker-cwd--/2026-08-07T13-18-56-134Z_019fdc60-7286-7bb2-89ad-ebc4ec6ea827.jsonl";

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP target"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent", sessionPath: ${JSON.stringify(SESSION)} })`, true);
  console.log("tab:", id);
  await sleepMs(5000);

  console.log("history messages:", await evaluate(ws, `document.querySelectorAll('.chat-msg').length`));

  // Open the tree dialog
  await clickSel(ws, "button[title='会话分支（fork）']");
  await sleepMs(1000);
  console.log("tree dialog:", await evaluate(ws, "!!document.querySelector('.tree-dialog')"));
  console.log("tree rows:", await evaluate(ws, `document.querySelectorAll('.tree-row').length`));
  console.log("leaf tag:", await evaluate(ws, `document.querySelector('.tree-leaf-tag')?.textContent`));
  const previews = await evaluate(ws, `[...document.querySelectorAll('.tree-preview')].map(e => e.textContent.slice(0, 30))`);
  console.log("previews:", JSON.stringify(previews));

  // Select the first user message node (2nd row typically: model, thinking, user, assistant)
  const userIdx = await evaluate(ws, `[...document.querySelectorAll('.tree-row')].findIndex(r => r.textContent.includes('你'))`);
  console.log("user row index:", userIdx);
  await clickSel(ws, ".tree-row", userIdx);
  await sleepMs(400);
  console.log("detail shown:", await evaluate(ws, `!!document.querySelector('.tree-detail')`));
  console.log("fork btn:", await evaluate(ws, `document.querySelector('.tree-detail-actions .btn-primary')?.textContent ?? null`));

  // Fork from it
  await clickSel(ws, ".tree-detail-actions .btn-primary");
  await sleepMs(1500);
  console.log("dialog closed:", await evaluate(ws, `!document.querySelector('.tree-dialog')`));
  console.log("messages reloaded:", await evaluate(ws, `document.querySelectorAll('.chat-msg').length`));
  console.log("toast:", await evaluate(ws, `document.querySelector('.toast')?.textContent ?? null`));

  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`, true);
  console.log("DONE");
} finally {
  electron.kill();
  setTimeout(() => process.exit(0), 500);
}
