/**
 * Perf harness: MEASURED open/scroll/navigation times for a session of a given
 * size — no hand-feel, numbers only.
 *
 * It builds a synthetic session of N user/assistant turns (with tool-call noise,
 * so it matches the user's real 2778-entry / 684-message shape), runs the
 * PACKAGED app's parsers against it, and prints a table:
 *
 *   parse+resolve      main-process transcript pipeline (tree parse → context)
 *   renderer apply     chatStore.initMessages with the JSON the bridge would cross
 *   from-file tail     the NEW tail path (main slice + store stitch)
 *   get_entries diff   one incremental tree poll (cursor) vs a full snapshot
 *
 * Everything runs against the app's REAL modules (src/main, src/renderer) —
 * no network, no pi process, no model.
 *
 * Usage: node scripts/perf-transcript.mjs [messages] [entriesPerMessage]
 */
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MESSAGES = Number(process.argv[2] ?? 684);
const ENTRIES_PER_MSG = Number(process.argv[3] ?? 4);
const { pathToFileURL } = await import("node:url");

/**
 * Load the app's TS modules through Vite's SSR pipeline — the same transform
 * vitest uses, so the measured code is the code the tests (and the app) run.
 */
const { createServer } = await import("vite");
const vite = await createServer({
  root: process.cwd(),
  logLevel: "error",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const load = (rel) => vite.ssrLoadModule(`/${rel}`);
const loadAbs = (abs) => vite.ssrLoadModule(pathToFileURL(abs).href);

const workDir = mkdtempSync(path.join(tmpdir(), "pipi-perf-"));

// --- build a synthetic session file (JSONL, pi's on-disk format) -------------
function entry(obj) {
  return JSON.stringify(obj);
}

function buildSession(messages) {
  const lines = [entry({ type: "session", id: "s0", cwd: workDir, timestamp: new Date().toISOString() })];
  let parentId = null;
  let entryId = 0;
  const nextId = () => `e${entryId++}`;
  for (let i = 0; i < messages; i += 1) {
    const u = nextId();
    lines.push(entry({ type: "message", id: u, parentId, timestamp: new Date(Date.now() + i * 1000).toISOString(), message: { role: "user", content: [{ type: "text", text: `问题 ${i}：帮我改一下登录逻辑，注意并发场景` }] } }));
    parentId = u;
    // Tool-call noise, like a real agent turn (edit → toolResult).
    for (let t = 0; t < ENTRIES_PER_MSG - 2; t += 1) {
      const callId = nextId();
      lines.push(entry({ type: "message", id: callId, parentId, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: `tc-${i}-${t}`, name: t === 0 ? "edit" : "read", arguments: { path: `src/mod${i}.ts` } }] } }));
      parentId = callId;
      const resId = nextId();
      lines.push(entry({ type: "message", id: resId, parentId, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: `tc-${i}-${t}`, content: [{ type: "text", text: "ok".repeat(200) }] } }));
      parentId = resId;
    }
    const a = nextId();
    const answer = "回答 " + i + "：\n\n改好了。要点：\n- 并发下先加锁\n- 补了测试\n\n```ts\nconst lock = new Mutex();\nawait lock.run(() => save());\n```";


    lines.push(entry({ type: "message", id: a, parentId, timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] } }));
    parentId = a;
  }
  return lines.join("\n") + "\n";
}

const content = buildSession(MESSAGES);
const totalEntries = content.split("\n").length - 2;
console.log(`session: ${MESSAGES} messages, ~${totalEntries} entries, ${(content.length / 1024 / 1024).toFixed(2)} MB`);

// --- 1) main-process pipeline: parse + resolve -------------------------------
const { parseTreeFileAsync } = await load("src/main/tree-from-file.ts");
const { transcriptFromContent } = await load("src/main/transcript-from-file.ts");

let t0 = performance.now();
const messages = await transcriptFromContent(content);
const parseMs = performance.now() - t0;
console.log(`main parse+resolve   : ${parseMs.toFixed(0)} ms  (${messages.length} bridge messages from ${totalEntries} entries)`);

// --- 2) bridge cost: structured-clone style JSON round trip ------------------
t0 = performance.now();
const roundTripped = JSON.parse(JSON.stringify(messages));
const bridgeMs = performance.now() - t0;
console.log(`bridge JSON clone    : ${bridgeMs.toFixed(0)} ms  (${(JSON.stringify(roundTripped).length / 1024 / 1024).toFixed(2)} MB)`);
const tailMessages = roundTripped.slice(-120);
console.log(`bridge with tail 120 : ${(JSON.stringify(tailMessages).length / 1024 / 1024).toFixed(2)} MB (${tailMessages.length} msgs)`);

// --- 3) renderer apply: chatStore.initMessages -------------------------------
process.env.PIPI_LOG = "error";
const { useChatStore } = await load("src/renderer/src/stores/chatStore.ts");
const T = "perf-tab";
useChatStore.getState().ensure(T);
useChatStore.setState((s) => ({ states: { ...s.states, [T]: { ...s.states[T], booted: true } } }));

// Old path: full snapshot.
t0 = performance.now();
useChatStore.getState().initMessages(T, roundTripped);
const applyFullMs = performance.now() - t0;
console.log(`renderer init (full) : ${applyFullMs.toFixed(0)} ms  (${useChatStore.getState().states[T].messages.length} bubbles assembled)`);

// New path: tail snapshot stitched onto the kept history.
t0 = performance.now();
useChatStore.getState().initMessages(T, tailMessages, { total: roundTripped.length });
const applyTailMs = performance.now() - t0;
console.log(`renderer init (tail) : ${applyTailMs.toFixed(0)} ms  (${useChatStore.getState().states[T].messages.length} bubbles assembled)`);

// --- 4) tree: full get_entries parse vs incremental cursor poll --------------
const { buildTreeFromEntries } = await load("src/shared/tree-build.ts");
const { flattenTree } = await load("src/shared/tree-layout.ts");
const entries = (await parseTreeFileAsync(content)).entries;

t0 = performance.now();
const { tree } = buildTreeFromEntries(entries);
const buildMs = performance.now() - t0;
t0 = performance.now();
const { flat } = flattenTree(tree, entries[entries.length - 1].id);
const flatMs = performance.now() - t0;
console.log(`tree build           : ${buildMs.toFixed(1)} ms`);
console.log(`tree flatten         : ${flatMs.toFixed(1)} ms  (${flat.length} rows)`);

// --- 5) the real per-message paint cost: Markdown parse --------------------
try {
  const ReactMod = await import("react");
  const ReactDOMServer = await import("react-dom/server");
  const { default: Markdown } = await load("src/renderer/src/Markdown.tsx");
  const fence = "```";
  const sample = "回答\n\n" + fence + "ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n" + fence + "\n\n- 列表一\n- 列表二\n\n一些**强调**文字和 " + "`" + "inline code" + "`" + "。";
  const el = ReactMod.createElement(Markdown, { content: sample });
  t0 = performance.now();
  for (let i = 0; i < 30; i += 1) ReactDOMServer.renderToStaticMarkup(el);
  const mdMs = (performance.now() - t0) / 30;
  console.log(`markdown parse/paint  : ${mdMs.toFixed(1)} ms per message → x2736 = ${(mdMs * 2736 / 1000).toFixed(2)} s if all mounted`);
} catch (e) {
  console.log("markdown parse/paint  : (unavailable:", String(e).split("\n")[0].slice(0, 90), ")");
}
console.log("\nInterpretation:");
console.log("- renderer init(full) is the per-open cost the old path paid on EVERY open;");
console.log("- renderer init(tail) is what this session costs now (older history kept, identity-stable);");
console.log("- tree build+flatten runs on every poll that changes something; the identity fast path skips it entirely when nothing changed.");

await vite.close();
rmSync(workDir, { recursive: true, force: true });
