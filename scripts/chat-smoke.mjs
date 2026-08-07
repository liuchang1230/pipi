// End-to-end smoke test: boot the built app with a CDP port, create an RPC
// tab programmatically, then drive the chat textarea from the page context
// (focus + native input event) and report what happens.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9333;
const electronBin = "node_modules/electron/dist/electron.exe";
const electron = spawn(electronBin, [".", `--remote-debugging-port=${PORT}`, "--user-data-dir=./.smoke-profile"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  detached: false,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});

let stderrBuf = "";
electron.stderr.on("data", (d) => {
  stderrBuf += d;
  const s = String(d);
  if (/error|Error|rpc|chat/i.test(s)) process.stdout.write("[main] " + s.slice(0, 200));
});

const sleepMs = (ms) => sleep(ms);

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
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
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  }
  return r.result?.result?.value;
}

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) {
    console.log("FAIL: no CDP page target (app did not boot?)");
    process.exit(1);
  }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");

  // 1. No tab yet → no chat pane.
  console.log("chat-pane before tab:", await evaluate(ws, "!!document.querySelector('.chat-pane')"));

  // 2. Create an RPC tab from the page context (same call the + button makes).
  const id = await evaluate(ws, `window.api.tab.create({ cwd: "D:/其余文件/项目/agent" })`, true);
  console.log("tab id:", id);

  await sleepMs(4000); // boot pi --mode rpc + tabs:update

  // 3. Chat pane mounted? textarea present?
  console.log("chat-pane after tab:", await evaluate(ws, "!!document.querySelector('.chat-pane')"));
  console.log("textarea count:", await evaluate(ws, "document.querySelectorAll('.chat-textarea').length"));
  console.log(
    "textarea disabled/placeholder:",
    await evaluate(ws, `(() => { const t = document.querySelector('.chat-textarea'); return t ? { disabled: t.disabled, placeholder: t.placeholder } : null })()`)
  );
  console.log("input-wrap visible:", await evaluate(ws, `(() => { const w = document.querySelector('.chat-input-wrap'); if (!w) return 'no wrap'; const r = w.getBoundingClientRect(); return { h: r.height, top: r.top, w: r.width } })()`));

  // 4. Drive typing through the native path (React-compatible input event).
  const typeResult = await evaluate(ws, `(() => {
    const ta = document.querySelector('.chat-textarea');
    if (!ta) return 'no textarea';
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '测试输入');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { focused: document.activeElement === ta, valueAfterEvent: ta.value };
  })()`);
  console.log("type result:", JSON.stringify(typeResult));

  await sleepMs(300);
  console.log("value after React re-render:", await evaluate(ws, "document.querySelector('.chat-textarea')?.value"));

  // 5. Cleanup: close the tab.
  await evaluate(ws, `window.api.tab.close(${JSON.stringify(id)})`, true);
  await sleepMs(500);
  console.log("chat-pane after close:", await evaluate(ws, "!!document.querySelector('.chat-pane')"));
  console.log("DONE");
} finally {
  electron.kill();
  setTimeout(() => process.exit(0), 500);
}
