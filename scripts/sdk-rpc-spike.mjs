// P2-0 spike 2: reuse runRpcMode() inside a worker_thread by faking stdin and
// capturing stdout. If this works, the SDK backend gets the ENTIRE command/
// event/UI-bridge surface from upstream with zero protocol drift.
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const PI_PKG = "file:///C:/Users/chang/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-rpc-spike-"));

const workerSrc = `
import { parentPort, workerData } from "node:worker_threads";
import { PassThrough } from "node:stream";

// --- 1. Fake stdin BEFORE runRpcMode reads it ---
const fakeStdin = new PassThrough();
Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

// --- 2. Capture stdout/stderr BEFORE runRpcMode's takeOverStdout binds ---
// NOTE: writeRawStdoutChunk calls write(text, callback) — callback lands in
// the SECOND parameter. Accept both call styles or the tail promise never
// resolves and every later response queues forever.
process.stdout.write = ((chunk, encOrCb, maybeCb) => {
  const cb = typeof encOrCb === "function" ? encOrCb : maybeCb;
  parentPort.postMessage({ kind: "line", text: String(chunk) });
  if (typeof cb === "function") cb();
  return true;
}) ;
process.stderr.write = ((chunk, encOrCb, maybeCb) => {
  const cb = typeof encOrCb === "function" ? encOrCb : maybeCb;
  parentPort.postMessage({ kind: "err", text: String(chunk) });
  if (typeof cb === "function") cb();
  return true;
}) ;

import { runRpcMode } from ${JSON.stringify(PI_PKG + "/dist/modes/rpc/rpc-mode.js")};
import { createAgentSessionRuntime } from ${JSON.stringify(PI_PKG + "/dist/core/agent-session-runtime.js")};
import { createAgentSessionServices, createAgentSessionFromServices } from ${JSON.stringify(PI_PKG + "/dist/core/agent-session-services.js")};
import { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager } from ${JSON.stringify(PI_PKG + "/dist/index.js")};

const t0 = performance.now();
const modelRuntime = await ModelRuntime.create();
const settingsManager = SettingsManager.create(workerData.cwd, workerData.agentDir);
const resourceLoader = new DefaultResourceLoader({
  cwd: workerData.cwd,
  agentDir: workerData.agentDir,
  modelRegistry: modelRuntime.modelRegistry,
  settingsManager,
});
await resourceLoader.reload();
const sessionManager = SessionManager.create(workerData.cwd);

const createRuntime = async ({ cwd: c, agentDir: a, sessionManager: sm }) => {
  const services = await createAgentSessionServices({ cwd: c, agentDir: a, modelRuntime, resourceLoader, settingsManager });
  const created = await createAgentSessionFromServices({ services, sessionManager: sm });
  return { ...created, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: workerData.cwd,
  agentDir: workerData.agentDir,
  sessionManager,
});
const t1 = performance.now();
parentPort.postMessage({ kind: "ready", coldMs: t1 - t0, hasSession: !!runtime.session });

parentPort.on("message", (msg) => {
  if (msg.kind === "cmd") {
    console.log("[worker] got cmd", msg.cmd.type);
    fakeStdin.write(JSON.stringify(msg.cmd) + "\\n");
  }
  if (msg.kind === "ui") fakeStdin.write(JSON.stringify({ type: "extension_ui_response", ...msg.resp }) + "\\n");
});

await runRpcMode(runtime);
parentPort.postMessage({ kind: "exit" });
`;

const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(workerSrc).toString("base64")}`), {
  workerData: { cwd, agentDir: join(cwd, ".pi") },
});

const t0 = Date.now();
worker.on("message", (m) => {
  if (m.kind === "ready") {
    console.log("READY after", ((Date.now() - t0) / 1000).toFixed(2), "s:", JSON.stringify(m));
    send({ type: "get_state", id: "s1" });
    send({ type: "get_commands", id: "c1" });
    setTimeout(() => send({ type: "get_available_models", id: "m1" }), 800);
    setTimeout(() => send({ type: "get_session_stats", id: "st1" }), 1500);
    setTimeout(() => worker.terminate().then(() => process.exit(0)), 9000);
  } else if (m.kind === "err") {
    console.log("WORKER STDERR:", m.text.trimEnd().slice(0, 240));
  } else if (m.kind === "line") {
    try {
      const obj = JSON.parse(m.text.trim());
      if (obj.type === "response") {
        console.log("RESPONSE", obj.command, obj.success, obj.data ? JSON.stringify(obj.data).slice(0, 220) : obj.error ?? "");
      }
    } catch {
      /* non-json */
    }
  }
});
worker.on("error", (e) => {
  console.error("WORKER ERROR:", e);
  process.exit(1);
});
function send(cmd) {
  worker.postMessage({ kind: "cmd", cmd });
}
