const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const electron = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9374", "--user-data-dir=./.smoke-profileGG"], { cwd: process.cwd(), stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try { const t = await (await fetch("http://127.0.0.1:9374/json")).json(); wsUrl = t.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
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
  const dir = process.env.TEMP.split(String.fromCharCode(92)).join("/") + "/pipi-rollback";
  const id = await ev("window.api.tab.create({ cwd: " + JSON.stringify(dir) + " })", true);
  await sleep(5000);
  // edit twice
  await ev("window.api.tab.rpcSend(" + JSON.stringify(id) + ', { type: "prompt", message: "用 edit 工具把 f.txt 的第2行改为：修改A。" })', true);
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev('!document.querySelector(".chat-btn.stop")')) break; }
  await ev("window.api.tab.rpcSend(" + JSON.stringify(id) + ', { type: "prompt", message: "再用 edit 工具把 f.txt 的第3行改为：修改B。" })', true);
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev('!document.querySelector(".chat-btn.stop")')) break; }
  // open branch dialog
  await clickText(".chat-header-btn", "分支");
  await sleep(2500);
  console.log("tree rows:", await ev('document.querySelectorAll(".tree-row").length'));
  console.log("tree text sample:", await ev('[...document.querySelectorAll(".tree-row")].map(r => r.textContent.replace(/s+/g, " ").trim()).slice(0, 6)'));
  console.log("cp tags:", await ev('[...document.querySelectorAll(".tree-cp-tag")].map(t => t.textContent)'));
  // click the FIRST edit tool row (回退点 #1)
  const clicked = await clickText(".tree-row", "编辑预览") || await ev('(() => { const rows = [...document.querySelectorAll(".tree-row")]; const t = rows.find(r => r.querySelector(".tree-cp-tag")); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()');
  if (clicked && typeof clicked === "object") {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: clicked.x, y: clicked.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: clicked.x, y: clicked.y, button: "left", clickCount: 1 });
  }
  await sleep(1000);
  console.log("rollback btn:", await ev('[...document.querySelectorAll(".tree-detail-actions button")].map(b => b.textContent)'));
  await clickText(".tree-detail-actions button", "回退文件到此状态");
  await sleep(3000);
  const content = fs.readFileSync(path.join(process.env.TEMP, "pipi-rollback", "f.txt"), "utf8");
  console.log("file after rollback:", JSON.stringify(content));
  await ev("window.api.tab.close(" + JSON.stringify(id) + ")", true);
  console.log("DONE");
  process.exit(0);
})();
