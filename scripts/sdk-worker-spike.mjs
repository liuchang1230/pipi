// P2-0 spike: SDK in a worker_thread — load, create ModelRuntime, loader,
// session; measure cold/hot timings. Mirrors what sdk-worker.ts will do.
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const PI_PKG = "file:///C:/Users/chang/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-spike-"));

const workerSrc = `
import { parentPort, workerData } from "node:worker_threads";
import { ModelRuntime, DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from ${JSON.stringify(PI_PKG + "/dist/index.js")};

const t0 = performance.now();
// 1. ModelRuntime
const runtime = await ModelRuntime.create();
const t1 = performance.now();
// 2. Resource loader
const settings = SettingsManager.create(workerData.cwd, workerData.agentDir);
const loader = new DefaultResourceLoader({
  cwd: workerData.cwd,
  agentDir: workerData.agentDir,
  modelRegistry: runtime.modelRegistry,
  settingsManager: settings,
});
const loadRes = loader.getSkills();
const loadPrompts = loader.getPrompts();
const t2 = performance.now();
// 3. Session manager + session (cold, shared runtime/loader/settings)
const sessionManager = SessionManager.create(workerData.cwd);
const t3 = performance.now();
const result = await createAgentSession({
  cwd: workerData.cwd,
  agentDir: workerData.agentDir,
  modelRuntime: runtime,
  resourceLoader: loader,
  settingsManager: settings,
  sessionManager,
});
const t4 = performance.now();
const session = result.session;
const events = [];
session.subscribe((ev) => { events.push(ev); });
// 4. Second session (hot path — same runtime/loader/settings)
const sessionManager2 = SessionManager.create(workerData.cwd);
const result2 = await createAgentSession({
  cwd: workerData.cwd,
  agentDir: workerData.agentDir,
  modelRuntime: runtime,
  resourceLoader: loader,
  settingsManager: settings,
  sessionManager: sessionManager2,
});
const t5 = performance.now();
parentPort.postMessage({
  steps: {
    runtime: t1 - t0,
    settings: t3 - t2,
    loaderReload: t2 - t1,
    sessionCold: t4 - t3,
    sessionHot: t5 - t4,
    totalCold: t4 - t0,
  },
  loader: { prompts: loadPrompts.prompts?.length ?? 0, skills: loadRes.skills?.length ?? 0 },
  sessionId: session.id,
  eventsWhileIdle: events.length,
  extensions: result.extensionsResult?.extensions?.length ?? 0,
  runtimeOk: !!runtime,
  sessionOk: !!session,
});
`;

const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(workerSrc).toString("base64")}`), {
  workerData: { cwd, agentDir: join(cwd, ".pi") },
  eval: false,
});

worker.on("message", (m) => {
  console.log("WORKER RESULT:");
  console.log(JSON.stringify(m, null, 2));
  worker.terminate();
});
worker.on("error", (e) => {
  console.error("WORKER ERROR:", e);
  process.exit(1);
});
worker.on("exit", (code) => {
  console.log("worker exit:", code);
});
