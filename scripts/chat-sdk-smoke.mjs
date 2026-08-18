// SDK-backed end-to-end smoke: boot the built app, create a local tab (SDK
// backend), send a real prompt through the chat textarea, wait for the agent
// to settle, and assert the reply rendered in the chat pane.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9334;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-sdk-profile"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
electron.stderr.on("data", (d) => {
  const s = String(d);
  if (/sdk|worker|error|Error/i.test(s)) process.stdout.write("[main] " + s.slice(0, 200) + "\n");
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
  if (!wsUrl) { console.log("FAIL: no CDP target"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  // Create a local tab (SDK backend).
  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent" })`, true);
  console.log("tab id:", id);
  await sleepMs(6000);

  console.log("placeholder:", await evaluate(ws, `(() => { const t = document.querySelector('.chat-textarea'); return t ? t.placeholder : 'NO TEXTAREA' })()`));

  // Send a real prompt.
  const sent = await evaluate(ws, `(() => {
    const ta = document.querySelector('.chat-textarea');
    if (!ta) return 'no textarea';
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用一句话介绍你自己');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);
  console.log("prompt sent:", sent);

  // Poll for the agent's text to appear in the chat pane.
  let reply = "";
  for (let i = 0; i < 60; i++) {
    await sleepMs(1000);
    reply = await evaluate(ws, `(() => {
      const msgs = [...document.querySelectorAll('.chat-msg.assistant')];
      const last = msgs[msgs.length - 1];
      if (!last) return '';
      return last.textContent.trim().slice(0, 120);
    })()`);
    if (reply) break;
  }
  console.log("assistant reply:", reply ? JSON.stringify(reply) : "NO REPLY (timeout)");
  const ok = reply.length > 0;
  console.log(ok ? "PASS" : "FAIL");
  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`);
  electron.kill();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("SMOKE ERROR:", e.message);
  electron.kill();
  process.exit(1);
}
