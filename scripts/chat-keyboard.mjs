// Keyboard-path probe: create an RPC tab, focus the textarea, then dispatch
// REAL keyboard events via CDP Input domain (full input pipeline, not JS
// synthetic events). Reports whether typed chars reach the React value.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9334;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-profile2"], {
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

// Type one ASCII char via the real keyboard pipeline.
async function typeChar(ws, char, code, key) {
  await send(ws, "Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: code === "KeyA" ? 65 : 66, text: char, unmodifiedText: char });
  await send(ws, "Input.dispatchKeyEvent", { type: "char", key, code, text: char, unmodifiedText: char });
  await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: code === "KeyA" ? 65 : 66 });
}

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP target"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent" })`, true);
  console.log("tab:", id);
  await sleepMs(4000);

  const focusResult = await evaluate(ws, `(() => {
    const ta = document.querySelector('.chat-textarea');
    if (!ta) return 'no textarea';
    ta.focus();
    return { focused: document.activeElement === ta, active: document.activeElement?.tagName };
  })()`);
  console.log("focus:", JSON.stringify(focusResult));

  // Real keyboard: type "ab"
  await typeChar(ws, "a", "KeyA", "a");
  await sleepMs(200);
  console.log("after 'a':", JSON.stringify(await evaluate(ws, `({ value: document.querySelector('.chat-textarea')?.value, focused: document.activeElement === document.querySelector('.chat-textarea') })`)));
  await typeChar(ws, "b", "KeyB", "b");
  await sleepMs(200);
  console.log("after 'b':", JSON.stringify(await evaluate(ws, `document.querySelector('.chat-textarea')?.value`)));

  // Focus sits where? If not the textarea, where did the chars go?
  console.log("active element:", await evaluate(ws, `document.activeElement?.tagName + '.' + (document.activeElement?.className || '')`));

  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`, true);
  console.log("DONE");
} finally {
  electron.kill();
  setTimeout(() => process.exit(0), 500);
}
