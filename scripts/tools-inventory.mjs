// 工具全景审计：把 pi 会话里"真正可用的工具"打出来。
//
// 用法: npm run tools            （内置 + 真实家目录两层都跑）
//       npm run tools -- real    （只跑真实家目录）
//
// 为什么要跑真实 pi 而不是猜：工具来自三层（pi 内置 / app 随包分发的扩展 / 用户自装扩展 + npm 包），
// 只有 pi 自己的 getAllTools() 知道最终答案。真实家目录那一轮会临时放入一个探针扩展（跑完删除），
// 不改任何其它文件。
//
// 为什么要跑真实 pi 而不是猜：工具来自三层（内置 / app 随包分发的扩展 / 用户自己装的扩展），
// 只有 pi 自己的 getAllTools() 知道最终答案。用 PI_CODING_AGENT_DIR 切两种环境：
//   isolated = 干净的临时 agent 家目录（只有 pi 内置工具）
//   real     = 用户真实的家目录（叠加 app 分发 + 用户自装扩展）
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE = `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    const all = pi.getAllTools().map((t) => ({
      name: t.name,
      source: t.sourceInfo?.type ?? t.sourceInfo?.source ?? "builtin",
      origin: String(t.sourceInfo?.path ?? t.sourceInfo?.extensionPath ?? ""),
      desc: (t.description ?? "").split("\\n")[0].slice(0, 100),
    }));
    writeFileSync(process.env.PROBE_OUT, JSON.stringify({ all, active: pi.getActiveTools() }, null, 1));
  });
}
`;

function prepare(kind) {
  const agentDir = mkdtempSync(join(tmpdir(), `tools-${kind}-`));
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const probePath = join(agentDir, "extensions", "probe-tools.ts");
  writeFileSync(probePath, PROBE, "utf8");
  if (kind === "isolated") {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ probe: { type: "api_key", key: "probe" } }));
  }
  return { agentDir, probePath };
}

async function run(kind) {
  const { agentDir, probePath } = prepare(kind);
  const out = join(agentDir, "tools.json");
  const project = mkdtempSync(join(tmpdir(), `tools-proj-${kind}-`));
  const real = kind === "real";
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: real ? process.env.REAL_AGENT_DIR : agentDir,
    PROBE_OUT: out,
    PI_PROVIDER: "probe",
    PI_MODEL: "probe-model",
  };
  if (real) {
    // 用真实家目录跑：探针文件临时放进去，跑完删掉
    const target = join(process.env.REAL_AGENT_DIR, "extensions", "__probe-tools.ts");
    copyFileSync(probePath, target);
    rmSync(probePath);
    try {
      await spawnPi(project, env);
      return read(out);
    } finally {
      rmSync(target, { force: true });
    }
  }
  await spawnPi(project, env);
  return read(out);
}

function read(out) {
  if (!existsSync(out)) return null;
  return JSON.parse(readFileSync(out, "utf8"));
}

function spawnPi(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn("pi", ["--mode", "rpc"], { cwd, env, shell: process.platform === "win32", stdio: ["ignore", "ignore", "ignore"] });
    setTimeout(() => {
      child.kill();
      resolve();
    }, 14_000);
  });
}

const which = process.argv[2] ?? "both";
for (const kind of which === "both" ? ["isolated", "real"] : [which]) {
  const data = await run(kind);
  console.log(`\n### ${kind}`);
  if (!data) {
    console.log("(probe failed — 没有收到 session_start)");
    continue;
  }
  console.log("active:", data.active.join(", "));
  const bySource = new Map();
  for (const t of data.all) {
    const key = t.origin ? `${t.source}: ${t.origin.replace(/\\/g, "/").split("/").slice(-2).join("/")}` : t.source;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(t);
  }
  for (const [key, tools] of bySource) {
    console.log(`\n[${key}]  (${tools.length})`);
    for (const t of tools) console.log(`  - ${t.name.padEnd(14)} ${t.desc}`);
  }
}
