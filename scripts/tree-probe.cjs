const { spawn } = require("child_process");
const electron = spawn("node_modules/electron/dist/electron.exe", [".", "--remote-debugging-port=9377", "--user-data-dir=./.smoke-profileJJ"], { cwd: process.cwd(), stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try { const t = await (await fetch("http://127.0.0.1:9377/json")).json(); wsUrl = t.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
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
  const dir = process.env.TEMP.split(String.fromCharCode(92)).join("/") + "/pipi-treeprobe";
  const id = await ev("window.api.tab.create({ cwd: " + JSON.stringify(dir) + " })", true);
  await sleep(5000);
  await ev("window.api.tab.rpcSend(" + JSON.stringify(id) + ', { type: "prompt", message: "用 edit 工具把 f.txt 的 a 改为：AAA。" })', true);
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev('!document.querySelector(".chat-btn.stop")')) break; }
  // Register listener + request tree, then dump the interesting part.
  await ev("window.__treeDump = null; window.api.onRpcEvent(" + JSON.stringify(id) + ", (e) => { if (e.type === \"response\" && e.command === \"get_tree\") window.__treeDump = e.data; })");
  await ev("window.api.tab.rpcSend(" + JSON.stringify(id) + ', { type: "get_tree" })');
  await sleep(1500);
  const t = await ev("window.__treeDump");
  const json = JSON.stringify(t);
  console.log("dump keys:", JSON.stringify(Object.keys(t || {})));
  // Find assistant message contents with toolCall blocks
  const sample = await ev("(() => { const d = window.__treeDump; if (!d || !d.tree) return null; const walk = (ns, out) => { for (const n of ns) { const e = n.entry; if (e.type === 'message' && e.message?.role === 'assistant') { const c = e.message.content; if (Array.isArray(c) && c.some(b => typeof b === 'object' && b !== null && String(b.type).toLowerCase().includes('tool'))) { out.push(c.map(b => ({ type: b.type, id: b.id, name: b.name, hasArgs: !!(b.arguments) }))); } } if (n.children) walk(n.children, out); } return out; }; const r = []; walk(d.tree, r); return r.slice(0, 2); })()");
  console.log("assistant tool blocks:", JSON.stringify(sample));
  const tr = await ev("(() => { const d = window.__treeDump; if (!d || !d.tree) return null; const walk = (ns, out) => { for (const n of ns) { const e = n.entry; if (e.type === 'message' && e.message?.role === 'toolResult') { out.push(e); } if (n.children) walk(n.children, out); } return out; }; const r = []; walk(d.tree, r); return r; })()");
  console.log("toolResult nodes:", JSON.stringify(tr));
  await ev("window.api.tab.close(" + JSON.stringify(id) + ")", true);
  console.log("DONE");
  process.exit(0);
})();
