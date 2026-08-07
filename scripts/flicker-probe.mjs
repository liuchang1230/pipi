// Flicker root-cause probe: spawn pi in a pty like the app does, capture the
// raw ANSI write log (PI_TUI_WRITE_LOG), send one streaming prompt, then
// analyze how often the bottom block (status/editor/footer) gets rewritten.
import * as pty from "node-pty";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PI = "pi";
const logPath = join(tmpdir(), "pi-flicker-write.log");
const cwd = join(tmpdir(), "pi-flicker-cwd");
if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
try { rmSync(logPath, { force: true }); } catch {}

const proc = pty.spawn("cmd.exe", ["/d", "/c", PI], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PI_TUI_WRITE_LOG: logPath,
    PI_DEBUG_REDRAW: "1",
  },
  useConpty: true,
});

let raw = "";
const t0 = Date.now();
proc.onData((d) => {
  raw += d;
  const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  process.stdout.write(`[${t}s] ${JSON.stringify(d.slice(0, 120))}\n`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = async (label, ms) => {
  await sleep(ms);
  console.log(`=== ${label} ===`);
};

(async () => {
  try {
    await t("wait for TUI boot", 6000);
    proc.write("请写一段大约 200 字的说明文字，介绍什么是深模块。请直接输出，不要用工具。");
    await sleep(300);
    proc.write("\r");
    await t("streaming in progress", 20000);
  } finally {
    proc.kill();
    writeFileSync(join(tmpdir(), "pi-flicker-raw.log"), raw);
    console.log("done. raw log:", join(tmpdir(), "pi-flicker-raw.log"));
  }
})();
