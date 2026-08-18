// Reproduce "Cannot read properties of undefined (reading 'fg')" when opening
// an existing session (sessionPath) via the SDK backend.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9336;
const electron = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-open-profile"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
electron.stderr.on("data", (d) => {
  const s = String(d);
  if (/sdk|worker|error|Error|Cannot/i.test(s)) process.stdout.write("[main] " + s.slice(0, 300) + "\n");
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
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails).slice(0, 400) };
  return r.result?.result?.value;
}

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");
  // Also capture console errors from the renderer (append, don't replace the
  // response handler installed by connect()).
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled" || msg.method === "Runtime.exceptionThrown") {
      const desc = msg.method === "Runtime.exceptionThrown"
        ? (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "")
        : (msg.params.args?.[0]?.value ?? "");
      if (/Cannot|Error|fg|undefined/i.test(String(desc))) console.log("[renderer]", String(desc).slice(0, 300));
    }
  });

  // Open an existing session (same path the sidebar uses).
  const sessionPath = "C:/Users/chang/.pi/agent/sessions/--D--其余文件-项目-agent--/2026-08-10T12-05-44-373Z_019feb90-8335-7e15-b400-3e618f0de930.jsonl";
  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent", sessionPath: ${JSON.stringify(sessionPath)} })`, true);
  console.log("tab id:", id);

  // Wait 6s (past the 5s the user reported).
  await sleepMs(6000);

  const state = await evaluate(ws, `(() => {
    const ta = document.querySelector('.chat-textarea');
    const placeholder = ta ? ta.placeholder : 'NO TEXTAREA';
    const errBanner = document.querySelector('.chat-error-banner');
    const msgs = [...document.querySelectorAll('.chat-msg')].length;
    return { placeholder, errBanner: errBanner ? errBanner.textContent.slice(0, 120) : null, msgs };
  })()`);
  console.log("chat state:", JSON.stringify(state));

  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`);
  electron.kill();
  process.exit(0);
} catch (e) {
  console.error("SMOKE ERROR:", e.message);
  electron.kill();
  process.exit(1);
}
