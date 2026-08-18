// E2E: simulate a machine without pi agent, then verify the full auto-install
// flow — native question dialog → renderer progress dialog (stage text,
// elapsed timer, progress bar) → success state.
//
// Prereqs: global pi binary renamed away (done in bash), app built
// (npm run build), and the smoke profile dir removed between runs.
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9342;
const profile = ".smoke-install-profile";

const app = spawn("node_modules/electron/dist/electron.exe", [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1", PI_CODING_AGENT: "" },
});
app.stderr.on("data", (d) => {
  const s = String(d);
  if (/sdk|worker|install|error|Error|fail/i.test(s)) process.stdout.write("[main] " + s.slice(0, 180) + "\n");
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

// --- native dialog automation (PS 5.1 needs an explicit delegate) ----------
const PS1 = ".smoke-dialog-click.ps1";
function ps1Source() {
  return (
    "\uFEFF" +
    [
      `Add-Type @\"`,
      `using System;`,
      `using System.Text;`,
      `using System.Runtime.InteropServices;`,
      `public class W {`,
      `  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);`,
      `  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);`,
      `  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);`,
      `  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nID);`,
      `  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);`,
      `  public const uint WM_COMMAND = 0x0111;`,
      `}`,
      `\"@`,
      `$target = $args[0]`,
      `$script:found = [IntPtr]::Zero`,
      `$cb = [W+EnumWindowsProc]{ param($h, $lp)`,
      `  $sb = New-Object System.Text.StringBuilder 256`,
      `  [W]::GetWindowText($h, $sb, 256) | Out-Null`,
      `  if ($sb.ToString().Contains($target)) { $script:found = $h; return $false }`,
      `  return $true`,
      `}`,
      `[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null`,
      `if ($script:found -eq [IntPtr]::Zero) { exit 2 }`,
      `# Click the default button (IDOK=1) via PostMessage — no focus needed.`,
      `$btn = [W]::GetDlgItem($script:found, 1)`,
      `[W]::PostMessage($script:found, [W]::WM_COMMAND, [IntPtr]1, $btn) | Out-Null`,
      `exit 0`,
    ].join("\r\n") + "\r\n"
  );
}
writeFileSync(PS1, ps1Source(), "utf8");

/** Press Enter on the native dialog whose title contains $target. Exit 2 = dialog absent. */
function pressEnter(target) {
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, target], { timeout: 8000, windowsHide: true, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

try {
  const wsUrl = await getWsUrl();
  if (!wsUrl) { console.log("FAIL: no CDP target"); process.exit(1); }
  const ws = await connect(wsUrl);
  await send(ws, "Runtime.enable");
  await send(ws, "Log.enable");
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (/pi-install|install|error/i.test(args)) console.log("[renderer]", args.slice(0, 200));
    }
  });
  console.log("cdp connected");
  console.log("piInstall surface:", JSON.stringify(await evaluate(ws, `typeof window.api.piInstall`)));

  // Fire tab:create — it will hit ensurePiReady → native question dialog.
  await evaluate(ws, `window.api.tab.create({ cwd: ${JSON.stringify(process.cwd())} })`);
  console.log("tab:create fired; waiting for native question dialog…");
  await sleepMs(2500);

  // Press Enter (default button = 立即安装) until the dialog is gone.
  let pressed = false;
  for (let i = 0; i < 15; i++) {
    pressed = pressEnter("未检测到 pi agent");
    if (pressed) break;
    await sleepMs(1500);
  }
  console.log("dialog enter pressed:", pressed);

  function npmProcs() {
    try {
      return execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Process node -ErrorAction SilentlyContinue).Count"], { encoding: "utf8", timeout: 8000, windowsHide: true }).trim();
    } catch {
      return "?";
    }
  }
  await sleepMs(3000);
  console.log("node procs after enter:", npmProcs());
  console.log("dialog in DOM:", JSON.stringify(await evaluate(ws, `!!document.querySelector('.pi-install-dialog')`)));

  // Poll for the renderer progress dialog.
  let sawDialog = false;
  let lastStage = "";
  let sawDone = false;
  for (let i = 0; i < 180; i++) {
    await sleepMs(1000);
    const state = await evaluate(ws, `(() => {
      const d = document.querySelector('.pi-install-dialog');
      if (!d) return { visible: false };
      const stage = document.querySelector('.pi-install-stage')?.textContent?.trim() ?? '';
      const elapsed = document.querySelector('.pi-install-elapsed')?.textContent?.trim() ?? '';
      const result = document.querySelector('.pi-install-result')?.textContent?.trim() ?? '';
      const bar = !!document.querySelector('.pi-install-bar');
      return { visible: true, stage, elapsed, result, bar };
    })()`);
    if (state.visible) {
      sawDialog = true;
      if (state.stage) lastStage = state.stage;
      if (i % 5 === 0) console.log(`  dialog: stage="${state.stage || state.result}" elapsed=${state.elapsed} bar=${state.bar}`);
      if (state.result.includes("已安装完成")) { sawDone = true; console.log("  SUCCESS STATE REACHED:", state.result); break; }
      if (state.result.includes("失败")) { console.log("  FAILURE STATE:", state.result); break; }
    }
  }

  console.log("saw progress dialog:", sawDialog);
  console.log("last stage:", lastStage || "(none)");
  const ok = sawDialog && sawDone;
  console.log(ok ? "PASS" : "FAIL");
  app.kill();
  try { unlinkSync(PS1); } catch { /* */ }
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("SMOKE ERROR:", e.message);
  app.kill();
  try { unlinkSync(PS1); } catch { /* */ }
  process.exit(1);
}
