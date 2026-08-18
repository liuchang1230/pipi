// Integration probe: load the BUILT sdk-worker.js (out/main) as a worker,
// drive it with the SdkHost message protocol, and verify the command surface.
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-host-probe-"));
const worker = new Worker(new URL("../out/main/sdk-worker.js", import.meta.url), { workerData: {} });

const t0 = Date.now();
let ready = false;
const pending = new Map();
let opened = false;

worker.on("message", (m) => {
  if (m.kind === "ready") {
    console.log("worker ready, opening tab...");
    worker.postMessage({ kind: "open", tabId: "tab1", cwd, agentDir: join(cwd, ".pi"), continueRecent: false });
    return;
  }
  if (m.kind === "opened") {
    if (m.tabId === "tab2") {
      const t2 = pending.get("tab2open");
      console.log(`tab2 (hot) opened after ${((Date.now() - t2) / 1000).toFixed(3)}s`);
      send({ type: "get_state", id: "s2" });
      return;
    }
    opened = true;
    console.log(`tab1 opened after ${((Date.now() - t0) / 1000).toFixed(2)}s`, m.error ? `ERROR: ${m.error}` : "");
    if (m.error) { process.exit(1); }
    send({ type: "get_state", id: "s1" });
    // Second tab: hot path — should be far under 1s (shared infra).
    worker.postMessage({ kind: "open", tabId: "tab2", cwd, agentDir: join(cwd, ".pi"), continueRecent: false });
    pending.set("tab2open", Date.now());
    setTimeout(() => worker.terminate().then(() => process.exit(0)), 8000);
    return;
  }
  if (m.kind === "resp") {
    if (m.resp.command === "get_state") console.log("RESP", m.resp.command, m.resp.success);
    return;
  }
  if (m.kind === "evt") {
    console.log("EVT", JSON.stringify(m.event).slice(0, 100));
    return;
  }
});

worker.on("error", (e) => {
  console.error("WORKER ERROR:", e);
  process.exit(1);
});

function send(cmd) {
  worker.postMessage({ kind: "cmd", tabId: "tab1", cmd });
}
