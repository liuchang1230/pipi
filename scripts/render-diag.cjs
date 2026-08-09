const { spawn } = require("child_process");
const electron = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9384", "--user-data-dir=./.smoke-profileQQ"], { cwd: process.cwd(), stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try { const t = await (await fetch("http://127.0.0.1:9384/json")).json(); wsUrl = t.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
    await sleep(500);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let mid = 0;
  const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, ap = false) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: ap, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
  const clickText = async (sel, text) => {
    const rect = await ev('(() => { const el = [...document.querySelectorAll(' + JSON.stringify(sel) + ')].find(b => b.textContent.includes(' + JSON.stringify(text) + ')); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()');
    if (!rect) return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    return true;
  };
  await send("Runtime.enable");
  const dir = "D:/crscu/AI_Empowerment_Center/通小蜂/内部立项";
  const sess = "C:/Users/chang/.pi/agent/sessions/--D--crscu-AI_Empowerment_Center-通小蜂-内部立项--/2026-05-27T06-24-27-528Z_019e681b-1b88-7e43-ac80-36a06ab7c370.jsonl";
  const id = await ev("window.api.tab.create({ cwd: " + JSON.stringify(dir) + ", sessionPath: " + JSON.stringify(sess) + " })", true);
  console.log("tab id:", id);
  await sleep(6000);
  console.log("chat pane:", await ev('!!document.querySelector(".chat-pane")'));
  await sleep(8000);
  console.log("msgs:", await ev('document.querySelectorAll(".chat-msg").length'));
  console.log("tool names:", await ev('[...document.querySelectorAll(".chat-tool-name")].map(n => n.textContent)'));
  if (await ev('[...document.querySelectorAll(".chat-tool-name")].some(n => n.textContent === "apply_patch")')) {
    await clickText(".chat-tool-head", "apply_patch");
    await sleep(800);
    console.log("apply_patch args → diff view:", await ev('!!document.querySelector(".chat-tool-editdiff .diff-view")'));
    console.log("args JSON hidden:", await ev('!document.querySelector(".chat-tool-args")'));
  }
  await ev("window.api.tab.close(" + JSON.stringify(id) + ")", true);
  console.log("DONE");
  process.exit(0);
})();
