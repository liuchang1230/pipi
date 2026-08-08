const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const electron = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9373", "--user-data-dir=./.smoke-profileFF"], { cwd: process.cwd(), stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try { const t = await (await fetch("http://127.0.0.1:9373/json")).json(); wsUrl = t.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
    await sleep(500);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let mid = 0;
  const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, ap = false) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: ap, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
  await send("Runtime.enable");
  const dir = process.env.TEMP.replace(/\\/g, "/") + "/pipi-smoke-x";
  const id = await ev("window.api.tab.create({ cwd: " + JSON.stringify(dir) + " })", true);
  await sleep(5000);
  const r1 = await ev("window.api.diff.list(" + JSON.stringify(id) + ")", true);
  console.log("1. auto-init (fresh dir):", JSON.stringify(r1).slice(0, 220));
  fs.appendFileSync(path.join(process.env.TEMP, "pipi-smoke-x", "readme.md"), "修改追加行。\n");
  const r2 = await ev("window.api.diff.list(" + JSON.stringify(id) + ")", true);
  console.log("2. after edit:", JSON.stringify(r2.files));
  const d = await ev("window.api.diff.get(" + JSON.stringify(id) + ', "readme.md")', true);
  console.log("3. diff head:", d.diff.split("\n").slice(0, 4).join(" | "));
  // subdir-in-repo scope test: cwd = agent/.smoke-scope inside this repo
  const scopeDir = "D:/其余文件/项目/agent/.smoke-scope";
  const id2 = await ev("window.api.tab.create({ cwd: " + JSON.stringify(scopeDir) + " })", true);
  await sleep(5000);
  const r3 = await ev("window.api.diff.list(" + JSON.stringify(id2) + ")", true);
  console.log("4. subdir scope files (should be .smoke-scope only):", JSON.stringify(r3.files.map((f) => f.path)));
  await ev("window.api.tab.close(" + JSON.stringify(id2) + ")", true);
  await ev("window.api.tab.close(" + JSON.stringify(id) + ")", true);
  console.log("DONE");
  process.exit(0);
})();
