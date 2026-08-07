// Protocol probe: spawn pi --mode rpc, send a prompt, dump events to verify
// the exact event shapes chatStore relies on (message_start for user? tool
// event fields? agent_settled?). No app code involved.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const proc = spawn("cmd.exe", ["/d", "/c", "pi --mode rpc"], {
  cwd: join(tmpdir(), "pi-flicker-cwd"),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buf = "";
let sawResponse = false;

function send(cmd) {
  proc.stdin.write(JSON.stringify(cmd) + "\n");
}

const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "response") {
        console.log(ts(), "RESPONSE", msg.command, msg.success, msg.error ?? JSON.stringify(msg.data ?? {}).slice(0, 160));
        if (msg.command === "get_messages") {
          const msgs = msg.data?.messages ?? [];
          console.log(ts(), `  get_messages: ${msgs.length} messages`);
          for (const m of msgs) {
            console.log(ts(), `   - ${m.role}: ${JSON.stringify(m.content ?? {}).slice(0, 120)}`);
          }
          send({ type: "prompt", message: "请写一行诗，不要使用工具。" });
        }
      } else if (msg.type === "extension_ui_request") {
        console.log(ts(), "UI_REQUEST", msg.method, msg.title ?? "");
        send({ type: "extension_ui_response", id: msg.id, cancelled: true });
      } else {
        const brief = JSON.stringify(msg).slice(0, 200);
        console.log(ts(), "EVENT", brief);
      }
    } catch {
      console.log(ts(), "RAW?", line.slice(0, 80));
    }
  }
});

send({ type: "get_state" });
setTimeout(() => send({ type: "get_messages" }), 2000);
setTimeout(() => proc.kill(), 40000);
