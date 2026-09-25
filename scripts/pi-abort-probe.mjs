/**
 * Real-pi contract probe: WHEN may a prompt be sent after an abort?
 *
 * It answers that question against a live `pi --mode rpc` process instead of
 * guessing from the bundle:
 *
 *   1. a fake OpenAI-compatible provider (a local SSE server that streams one
 *      delta and then never finishes) keeps a turn running;
 *   2. we `abort` that turn;
 *   3. we write a plain prompt at the moment pi reports the cancelled message —
 *      this is the app's old flush trigger;
 *   4. we write the same prompt again on `agent_settled` — the app's new trigger.
 *
 * The verdicts come from pi itself (`{"type":"response","command":"prompt",…}`),
 * and NO real model is ever called. The probe uses a throwaway agent dir via
 * PI_CODING_AGENT_DIR, so the user's own ~/.pi is untouched.
 *
 * Measured result (2026-09-25, pi 0.85.1, local):
 *   message_start(assistant) .551 → (abort) → message_end .775 → turn_end .775
 *   → agent_end .775 → agent_settled .776
 * i.e. the aborted message_end is emitted from INSIDE the run, 1ms before pi is
 * idle, and a prompt written at that instant is a race. Locally pi still accepted
 * it; on the user's remote tab the same trigger was refused 6.7s after the abort
 * ("Agent is already processing…", app log 05:23:21.824 → 05:23:28.504). A prompt
 * written on agent_settled was ACCEPTED in every run.
 *
 * Run: node scripts/pi-abort-probe.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 8791;
const events = [];
const verdicts = { onCancelledMessage: null, onSettled: null };
let child;
let agentDir;
let sawCancelledMessage = false;
let updates = 0;
let abortSent = false;
let settleSent = false;

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
}

/** A provider that starts answering and never stops: an abortable turn. */
const server = createServer((req, res) => {
  if (!req.url.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log("provider got a request (turn is now running)");
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (delta) =>
      res.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta }] })}\n\n`);
    send({ role: "assistant", content: "thinking about it" });
    // Keep the stream open forever: the only way this turn ends is an abort.
    const heartbeat = setInterval(() => send({ content: "." }), 1000);
    req.on("close", () => clearInterval(heartbeat));
  });
});

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function finish(code = 0) {
  clearTimeout(globalTimer);
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  server.close();
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  console.log("\n=== verdicts ===");
  console.log("prompt sent on the cancelled message_end :", verdicts.onCancelledMessage);
  console.log("prompt sent on agent_settled             :", verdicts.onSettled);
  process.exit(code);
}

const globalTimer = setTimeout(() => {
  console.error("probe timed out");
  finish(1);
}, 60_000);

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

agentDir = mkdtempSync(path.join(tmpdir(), "pi-abort-probe-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "pi-abort-probe-cwd-"));
mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      probe: {
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        api: "openai-completions",
        apiKey: "probe",
        models: [{ id: "probe-model" }],
      },
    },
  }),
  "utf8",
);
writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ probe: { type: "api_key", key: "probe" } }), "utf8");

log("agent dir:", agentDir);

child = spawn("pi", ["--mode", "rpc"], {
  cwd: projectDir,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_PROVIDER: "probe",
    PI_MODEL: "probe-model",
  },
  shell: process.platform === "win32",
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      log("non-JSON stdout:", line.slice(0, 200));
      continue;
    }
    handle(event);
  }
});
child.stderr.on("data", (c) => log("stderr:", c.toString().trim().slice(0, 300)));

function handle(event) {
  events.push(event.type);
  const type = event.type;
  if (type === "response" && event.command === "prompt") {
    if (event.id === "probe-cancelled") verdicts.onCancelledMessage = event.success === false ? `REFUSED: ${event.error}` : "ACCEPTED";
    if (event.id === "probe-settled") verdicts.onSettled = event.success === false ? `REFUSED: ${event.error}` : "ACCEPTED";
    if (verdicts.onCancelledMessage && verdicts.onSettled) setTimeout(() => finish(0), 300);
    return;
  }
  if (type === "message_start") {
    log(`message_start role=${event.message?.role}`);
    if (event.message?.role === "assistant" && !abortSent) {
      abortSent = true;
      // Let the turn produce a little output first, then abort it.
      setTimeout(() => {
        log("aborting a streaming assistant turn");
        send({ type: "abort", id: "probe-abort" });
      }, 1200);
    }
    return;
  }
  if (type === "message_update") return;
  if (type === "turn_end") { log("turn_end"); return; }
  log(`event: ${type}`);
  const stopReason = event.message?.stopReason;
  if (type === "message_end" && (stopReason === "error" || stopReason === "aborted")) {
    // The cancelled/aborted message. MEASURED: pi emits this from INSIDE the run
    // (this turn: message_end + turn_end + agent_end at .775, agent_settled at
    // .776), so `activeRun` is still set and a prompt written here can be refused
    // — the app log shows exactly that on a remote tab: abort 05:23:21.824,
    // prompt 05:23:28.504, refused with "Agent is already processing".
    if (!sawCancelledMessage) {
      sawCancelledMessage = true;
      log(`aborted message_end (stopReason=${stopReason}, errorMessage=${JSON.stringify(event.message?.errorMessage)})`);
      log("cancelled message_end — sending a plain prompt NOW (old trigger)");
      send({ type: "prompt", message: "太慢了吧", id: "probe-cancelled" });
    }
    return;
  }
  if (type === "agent_settled") {
    if (settleSent) return; // one probe prompt per abort
    settleSent = true;
    log("agent_settled — sending the same prompt again (new trigger)");
    if (!sawCancelledMessage) log("(no aborted message_end was emitted for this abort)");
    send({ type: "prompt", message: "太慢了吧", id: "probe-settled" });
    return;
  }
}

log("starting a turn so there is something to abort…");
send({ type: "prompt", message: "hello", id: "probe-1" });

// Once the turn is visibly streaming (so the aborted message has content, exactly
// like the user's turn that had already produced output), abort it.
const abortTimer = setInterval(() => {}, 50);
setTimeout(() => {
  clearInterval(abortTimer);
  if (!events.includes("message_start")) {
    console.error("the probe turn never started; events:", events.join(","));
    finish(1);
  }
}, 20_000);
