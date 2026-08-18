// Full-surface probe: real agent dir (~/.pi/agent), verify get_commands picks
// up extensions + skills, and a prompt streams real events.
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-real-"));
const agentDir = "C:/Users/chang/.pi/agent";
const worker = new Worker(new URL("../out/main/sdk-worker.js", import.meta.url), { workerData: {} });

const t0 = Date.now();
worker.on("message", (m) => {
  if (m.kind === "ready") {
    worker.postMessage({ kind: "open", tabId: "t1", cwd, agentDir, continueRecent: false });
    return;
  }
  if (m.kind === "opened") {
    console.log(`opened after ${((Date.now() - t0) / 1000).toFixed(2)}s`, m.error ?? "");
    if (m.error) process.exit(1);
    send({ type: "get_commands", id: "c1" });
    return;
  }
  if (m.kind === "resp" && m.resp.command === "get_commands") {
    const cmds = m.resp.data?.commands ?? [];
    const ext = cmds.filter((c) => c.source === "extension").map((c) => c.name);
    const skill = cmds.filter((c) => c.source === "skill").map((c) => c.name);
    const prompt = cmds.filter((c) => c.source === "prompt").map((c) => c.name);
    console.log(`commands: ${cmds.length} total | ext[${ext.length}]:`, ext.slice(0, 8).join(", "));
    console.log(`skill[${skill.length}]:`, skill.slice(0, 6).join(", "));
    console.log(`prompt[${prompt.length}]:`, prompt.slice(0, 4).join(", "));
    // Fire a trivial prompt to verify the event stream.
    send({ type: "prompt", message: "回复一个字：好", id: "p1" });
    return;
  }
  if (m.kind === "resp" && m.resp.command === "prompt") {
    console.log("PROMPT ACCEPTED:", m.resp.success);
    return;
  }
  if (m.kind === "resp") {
    console.log("RESP", m.resp.command, m.resp.success, m.resp.error ?? "");
    return;
  }
  if (m.kind === "evt") {
    const t = m.event?.type ?? "";
    console.log("EVT", t.slice(0, 40), m.event?.assistantMessageEvent?.type === "text" ? JSON.stringify(m.event.assistantMessageEvent).slice(0, 60) : "");
    if (t === "agent_settled") {
      console.log("AGENT SETTLED — done");
      process.exit(0);
    }
  }
});
worker.on("error", (e) => { console.error("ERR", e); process.exit(1); });
function send(cmd) { worker.postMessage({ kind: "cmd", tabId: "t1", cmd }); }
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 30000);
