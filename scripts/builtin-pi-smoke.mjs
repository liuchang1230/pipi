// E2E: simulate a broken global pi (shim missing) → auto-local-install must
// restore it silently (no dialog, no notice), and the pty must run the REAL
// pi TUI (not a degraded shell).
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9352;
const profile = ".smoke-builtin-profile";

const app = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1", PI_CODING_AGENT: "" },
});
app.stderr.on("data", (d) => {
  const s = String(d);
  if (/pty|pi-detect|install|error|Error|fail/i.test(s)) process.stdout.write("[main] " + s.slice(0, 200) + "\n");
});
app.stdout.on("data", (d) => {
  const s = String(d);
  if (/pty|pi|shell|exit|error|Error|fail/i.test(s)) process.stdout.write("[out] " + s.slice(0, 200) + "\n");
});
const sleepMs = (ms) => sleep(ms);

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const t = await r.json();
      const p = t.find((x) => x.type === "page");
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleepMs(500);
  }
  return null;
}
let msgId = 0;
const pending = new Map();
const url = await getWsUrl();
const ws = await new Promise((res) => {
  const w = new WebSocket(url);
  w.onopen = () => res(w);
  w.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
});
function send(method, params = {}) { return new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await send("Runtime.evaluate", { expression, returnByValue: true }); return r.result?.result?.value; }
await send("Runtime.enable");

const id = await evaluate(`window.api.tab.create({ cwd: ${JSON.stringify(process.cwd())} })`, /* awaitPromise */ false);
console.log("tab:create fired:", id);
await sleepMs(9000);

// 1. 无安装对话框：检查原生窗口
let nativeDialog = "无";
try {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process | Where-Object { $_.MainWindowTitle -like '*pi agent*' } | Select-Object -ExpandProperty MainWindowTitle"], { encoding: "utf8", timeout: 8000, windowsHide: true });
  if (out.trim()) nativeDialog = out.trim();
} catch {}
console.log("原生安装对话框:", JSON.stringify(nativeDialog));

// 2. notice 对话框（渲染层）——自动修复成功时应为"无"
const notice = await evaluate(`(() => {
  const d = document.querySelector('.pi-install-dialog');
  if (!d) return '无';
  const txt = d.textContent;
  return (txt.includes('未检测到全局') ? 'notice出现: ' + txt.trim().slice(0, 60) : '对话框其他: ' + txt.trim().slice(0, 60));
})()`);
console.log("渲染层对话框:", JSON.stringify(notice));

// 3. pty 终端实际内容（内置 pi TUI 是否跑起来）
let termText = "";
for (let i = 0; i < 15; i++) {
  await sleepMs(1000);
  termText = await evaluate(`(() => {
    const t = document.querySelector('.xterm-helper-textarea') ? document.querySelector('.xterm') : null;
    const rows = t ? t.querySelectorAll('.xterm-rows > div') : [];
    return rows.length ? Array.from(rows).map(r => r.textContent).join(' ').trim().slice(0, 100) : '';
  })()`);
  if (termText) break;
}
console.log("终端内容:", JSON.stringify(termText));

// 4. 内置 pi 子进程存在？
const procs = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: "utf8" }).trim();
console.log("electron 进程数(含内置pi子进程):", procs);

const ok = nativeDialog === "无" && notice === "无" && termText.length > 0 && !termText.includes("PS ") && !termText.includes(">");
console.log(ok ? "PASS" : "FAIL");
app.kill();
process.exit(ok ? 0 : 1);
