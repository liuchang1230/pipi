const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const electron = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9378", "--user-data-dir=./.smoke-profileKK"], { cwd: process.cwd(), stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try { const t = await (await fetch("http://127.0.0.1:9378/json")).json(); wsUrl = t.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
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
  const dir = process.env.TEMP.split(String.fromCharCode(92)).join("/") + "/pipi-diag";
  const id = await ev("window.api.tab.create({ cwd: " + JSON.stringify(dir) + " })", true);
  await sleep(5000);
  // edit doc.md twice (auto-follow should open it in the viewer)
  await ev("window.api.tab.rpcSend(" + JSON.stringify(id) + ', { type: "prompt", message: "用 edit 工具把 doc.md 的第2行改为：修改A。" })', true);
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev('!document.querySelector(".chat-btn.stop")')) break; }
  await ev("window.api.tab.rpcSend(" + JSON.stringify(id) + ', { type: "prompt", message: "再用 edit 工具把 doc.md 的第3行改为：修改B。" })', true);
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev('!document.querySelector(".chat-btn.stop")')) break; }
  // what's in the viewer now?
  console.log("viewer path:", await ev('document.querySelector(".viewer-path")?.textContent'));
  console.log("viewer mode btn:", await ev('[...document.querySelectorAll(".viewer-mode")].map(b => b.textContent)'));
  // click 变更 tab
  await clickText(".viewer-mode", "变更");
  await sleep(3000);
  console.log("changes select value:", await ev('document.querySelector(".changes-file-select")?.value'));
  console.log("changes options:", await ev('[...document.querySelectorAll(".changes-file-select option")].map(o => o.textContent)'));
  console.log("version selects:", await ev('document.querySelectorAll(".changes-compare select").length'));
  if (await ev('document.querySelectorAll(".changes-compare select").length') > 0) {
    console.log("version opts:", await ev('[...document.querySelectorAll(".changes-compare select")].map(s => [...s.options].map(o => o.textContent))'));
  }
  console.log("body text sample:", await ev('document.querySelector(".changes-body")?.textContent.replace(/\\s+/g, " ").slice(0, 150)'));
  await ev("window.api.tab.close(" + JSON.stringify(id) + ")", true);
  console.log("DONE");
  process.exit(0);
})();
