// Slash menu verification: boot app, create local SDK tab, type "/", assert
// the popup shows grouped commands with the expected labels/sources.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9335;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-slash-profile"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
const sleepMs = (ms) => sleep(ms);

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* booting */ }
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
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
}

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent" })`, true);
  console.log("tab:", id);
  await sleepMs(6000);

  // Type "/" and wait for the popup.
  const typed = await evaluate(ws, `(() => {
    const ta = document.querySelector('.chat-textarea');
    if (!ta) return 'no textarea';
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('keyup', { bubbles: true }));
    return 'typed';
  })()`);
  await sleepMs(1500);

  const popup = await evaluate(ws, `(() => {
    const menu = document.querySelector('.slash-menu');
    if (!menu) return { open: false };
    const groups = [...menu.querySelectorAll('.slash-menu-group')].map(g => g.textContent);
    const items = [...menu.querySelectorAll('.slash-menu-item')].map(i => ({
      name: i.querySelector('.slash-menu-name')?.textContent,
      src: i.querySelector('.slash-menu-src')?.textContent,
      disabled: i.classList.contains('disabled'),
    }));
    return { open: true, groups, itemCount: items.length, items: items.slice(0, 25) };
  })()`);
  console.log("popup:", JSON.stringify(popup, null, 1).slice(0, 1500));

  const ok = popup.open && popup.groups.includes("Pi 内建") && popup.items.length > 10;
  console.log(ok ? "PASS" : "FAIL");
  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`);
  electron.kill();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("ERROR:", e.message);
  electron.kill();
  process.exit(1);
}
