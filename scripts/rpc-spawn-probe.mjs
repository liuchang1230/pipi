// Reproduce the app's exact RPC spawn path (node.exe + cli.js direct spawn)
// and report whether pi emits JSONL or exits immediately.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

function findNodeBin() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, "node.exe");
    if (existsSync(cand)) return cand;
  }
  for (const c of [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs\\nodejs\\node.exe"),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveCliJs() {
  const piBin = process.env.PI_BIN;
  if (!piBin) return null;
  if (/\.cmd$/i.test(piBin)) {
    try {
      const content = readFileSync(piBin, "utf8");
      const m = content.match(/"([^"]*cli\.js)"/i);
      if (m && existsSync(m[1])) return m[1];
      console.log("  shim content:", JSON.stringify(content.slice(0, 200)));
    } catch (e) {
      console.log("  read shim failed:", e.message);
    }
    const cand = join(dirname(piBin), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (existsSync(cand)) return cand;
  }
  return null;
}

const piBin = process.env.PI_BIN;
console.log("PI_BIN:", piBin, "exists:", piBin ? existsSync(piBin) : false);
const nodeBin = findNodeBin();
const cliJs = resolveCliJs();
console.log("node:", nodeBin, "| cli.js:", cliJs);

if (!nodeBin || !cliJs) {
  console.log("RESOLUTION FAILED");
  process.exit(1);
}

const proc = spawn(nodeBin, [cliJs, "--mode", "rpc"], {
  cwd: join(tmpdir(), "pi-flicker-cwd"),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buf = "";
let got = 0;
const t0 = Date.now();
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    got++;
    if (got <= 3) console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] LINE:`, line.slice(0, 160));
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] STDERR:`, c.trimEnd().slice(0, 300)));
proc.on("error", (e) => console.log("SPAWN ERROR:", e.message));
proc.on("exit", (code) => console.log(`EXIT code=${code} after ${((Date.now() - t0) / 1000).toFixed(1)}s, lines=${got}`));

setTimeout(() => {
  console.log(`after 5s: lines=${got} alive=${proc.exitCode === null}`);
  proc.kill();
  process.exit(0);
}, 5000);
