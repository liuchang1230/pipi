// M3 smoke: WSL RPC tab end-to-end (create → boot → prompt → settle).
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9338;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-profile6"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});
electron.stderr.on("data", (d) => {
  const s = String(d);
  if (/rpc|error/i.test(s)) process.stdout.write("[main] " + s.slice(0, 200));
});
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

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP target"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  const id = await evaluate(ws, `window.api.tab.create({ cwd: ".", wsl: { distro: "Ubuntu-22.04", path: "~" } })`, true);
  console.log("wsl tab:", id);
  await sleepMs(5000);

  console.log("chat-pane:", await evaluate(ws, "!!document.querySelector('.chat-pane')"));
  console.log("booted placeholder gone:", await evaluate(ws, `!document.querySelector('.chat-placeholder')`));
  console.log("model shown:", await evaluate(ws, `document.querySelector('.chat-header-model')?.textContent`));
  console.log("tab summary:", JSON.stringify(await evaluate(ws, `window.api.tab.list().then(ts => ts.find(t => t.id === ${JSON.stringify(id)}))`, true)));

  // Send a prompt, wait for settle.
  await evaluate(ws, `window.api.tab.rpcSend(${JSON.stringify(id)}, { type: "prompt", message: "只回复两个字：收到" })`, true);
  let settled = false;
  let text = "";
  for (let i = 0; i < 60; i++) {
    await sleepMs(1000);
    const st = await evaluate(ws, `(() => { const m = document.querySelectorAll('.chat-msg.assistant .chat-msg-md'); const last = m[m.length - 1]; return { settled: !document.querySelector('.chat-btn.stop'), text: last?.textContent ?? '' }; })()`);
    if (st?.settled && st.text) { settled = true; text = st.text; break; }
  }
  console.log("settled:", settled, "| reply:", JSON.stringify(text.slice(0, 60)));
  console.log("model after settle:", await evaluate(ws, `document.querySelector('.chat-header-model')?.textContent`));
  console.log("booted after settle:", await evaluate(ws, `!document.querySelector('.chat-placeholder')`));

  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`, true);
  console.log("DONE");
} finally {
  electron.kill();
  setTimeout(() => process.exit(0), 500);
}
