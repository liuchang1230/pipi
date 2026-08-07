// Click-focus probe: create an RPC tab, click the textarea with a REAL mouse
// event, then check where focus went and whether typing still lands.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9336;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-profile4"], {
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
async function typeChar(ws, char, code) {
  const vk = char.charCodeAt(0);
  await send(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: char, code, windowsVirtualKeyCode: vk, text: char, unmodifiedText: char });
  await send(ws, "Input.dispatchKeyEvent", { type: "char", key: char, code, text: char, unmodifiedText: char });
  await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: char, code, windowsVirtualKeyCode: vk });
}

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP target"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent" })`, true);
  console.log("tab:", id);
  await sleepMs(4000);

  // Where is the textarea on screen?
  const rect = await evaluate(ws, `(() => { const r = document.querySelector('.chat-textarea').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  console.log("textarea rect:", JSON.stringify(rect));

  // 1. After auto-focus, check focus state
  console.log("after boot focus:", await evaluate(ws, `({ active: document.activeElement?.className, caretVisible: !!document.querySelector('.chat-textarea')?.value })`));

  // 2. REAL mouse click on the textarea center
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  await clickAt(ws, cx, cy);
  await sleepMs(300);
  console.log("after click focus:", await evaluate(ws, `({ active: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''), taValue: document.querySelector('.chat-textarea')?.value })`));

  // 3. Type after click
  await typeChar(ws, "x", "KeyX");
  await sleepMs(200);
  console.log("value after typing post-click:", JSON.stringify(await evaluate(ws, `document.querySelector('.chat-textarea')?.value`)));

  // 4. What element is at the click point (hit test)?
  console.log("elementFromPoint:", await evaluate(ws, `(() => { const el = document.elementFromPoint(${cx}, ${cy}); return el ? el.tagName + '.' + (el.className || '') : 'none' })()`));

  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`, true);
  console.log("DONE");
} finally {
  electron.kill();
  setTimeout(() => process.exit(0), 500);
}
