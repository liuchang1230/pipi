// M2 smoke: model-switch menu opens & lists models; extension UI dialog
// (select via ask_user_question tool) renders and answers.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9337;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-profile5"], {
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
async function clickAt(ws, x, y) {
  await send(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function clickSel(ws, selector) {
  const rect = await evaluate(ws, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) return false;
  await clickAt(ws, rect.x, rect.y);
  return true;
}

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP target"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent" })`, true);
  console.log("tab:", id);
  await sleepMs(4000);

  // 1. Model menu
  const opened = await clickSel(ws, ".chat-model-btn");
  await sleepMs(600);
  console.log("model menu opened:", opened);
  console.log("menu items:", await evaluate(ws, `document.querySelectorAll('.chat-model-item').length`));
  console.log("first model:", await evaluate(ws, `document.querySelector('.chat-model-item')?.textContent`));
  await clickSel(ws, ".chat-model-btn"); // close

  // 2. Extension UI dialog via ask_user_question tool
  await evaluate(ws, `window.api.tab.rpcSend(${JSON.stringify(id)}, { type: "prompt", message: "请调用 ask_user_question 工具问我：午餐吃什么？选项：面条、米饭、饺子。只问这一个问题，不要做其他事。" })`, true);
  console.log("prompt sent, waiting for dialog…");
  let dialogSeen = false;
  for (let i = 0; i < 40; i++) {
    await sleepMs(1000);
    const n = await evaluate(ws, `document.querySelectorAll('.ui-dialog').length`);
    if (n > 0) { dialogSeen = true; break; }
  }
  console.log("ui-dialog appeared:", dialogSeen);
  console.log("dialog title:", await evaluate(ws, `document.querySelector('.ui-dialog .dialog-title')?.textContent`));
  console.log("select items:", await evaluate(ws, `document.querySelectorAll('.ui-select-item').length`));
  const items = await evaluate(ws, `[...document.querySelectorAll('.ui-select-item')].map(e => e.textContent)`);
  console.log("options:", JSON.stringify(items));

  if (dialogSeen && items?.length) {
    await clickSel(ws, ".ui-select-item");
    await sleepMs(800);
    console.log("dialog closed after answer:", await evaluate(ws, `document.querySelectorAll('.ui-dialog').length === 0`));
  }

  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`, true);
  console.log("DONE");
} finally {
  electron.kill();
  setTimeout(() => process.exit(0), 500);
}
