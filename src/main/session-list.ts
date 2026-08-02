/**
 * Read-only session list from ~/.pi/agent/sessions/<encoded-cwd>/.
 *
 * Pure filesystem + JSONL parsing — no SDK dependency, so pi updates that
 * keep the JSONL format stable don't affect us. We parse only what the
 * sidebar needs: first user message (preview), message count, display name,
 * mtime, file path.
 *
 * The cwd is encoded by pi as the path with separators replaced by "--".
 * We mirror that encoding to locate the session directory.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionEntry {
  path: string;
  sessionId: string;
  mtime: number;
  size: number;
  messageCount: number;
  firstMessage: string;
  name: string | null;
}

/** Encode a cwd the way pi does (mirrors session-manager.js:245).
 *  1. strip a leading "/" or "\"
 *  2. replace every "/", "\", ":" with "-"
 *  3. wrap with leading/trailing "--"
 *  e.g. "D:/其余文件/项目/agent" -> "--D-其余文件-项目-agent--"
 *       "C:\\Users\\chang"      -> "--C-Users-chang--"
 */
export function encodeCwd(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${stripped}--`;
}

/** The session directory for a given cwd. */
export function sessionDirFor(cwd: string): string {
  return join(homedir(), ".pi", "agent", "sessions", encodeCwd(cwd));
}

export function decodeCwd(encoded: string): string | null {
  if (!encoded.startsWith("--") || !encoded.endsWith("--")) return null;
  const body = encoded.slice(2, -2);
  if (!body) return null;
  const restored = body.replace(/-/g, "/");
  if (/^[A-Za-z]\//.test(restored)) {
    return restored.replace(/^([A-Za-z])\//, "$1:/");
  }
  return `/${restored}`;
}

interface RawEntry {
  type: string;
  name?: string;
  message?: { role: string; content: unknown };
}

export function parseSessionText(content: string, filePath: string, meta?: { mtime?: number; size?: number }): SessionEntry | null {
  try {
    const lines = content.split("\n").filter((l) => l.trim());
    let firstMessage = "";
    let messageCount = 0;
    let name: string | null = null;
    let sessionId = "";
    for (const line of lines) {
      let e: RawEntry;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "session") {
        if (e.name) name = e.name;
        const raw = JSON.parse(line);
        if (raw.id) sessionId = raw.id;
      } else if (e.type === "session_info") {
        if (e.name) name = e.name;
      } else if (e.type === "message") {
        messageCount++;
        if (!firstMessage && e.message?.role === "user") {
          const c = e.message.content;
          if (typeof c === "string") firstMessage = c;
          else if (Array.isArray(c)) {
            const t = c.find((b: any) => b.type === "text")?.text;
            if (t) firstMessage = t;
          }
        }
      }
    }
    if (!sessionId) {
      const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
      const m = base.match(/_([0-9a-f-]+)\.jsonl$/i);
      if (m) sessionId = m[1];
    }
    return {
      path: filePath,
      sessionId,
      mtime: meta?.mtime ?? 0,
      size: meta?.size ?? Buffer.byteLength(content, "utf8"),
      messageCount,
      firstMessage: firstMessage.slice(0, 100),
      name,
    };
  } catch {
    return null;
  }
}

/** Parse one session file's metadata. */
function parseSessionFile(filePath: string): SessionEntry | null {
  try {
    const st = statSync(filePath);
    const content = readFileSync(filePath, "utf8");
    return parseSessionText(content, filePath, { mtime: st.mtimeMs, size: st.size });
  } catch {
    return null;
  }
}

/** List sessions for a cwd, most recent first. */
export function listSessions(cwd: string): SessionEntry[] {
  const dir = sessionDirFor(cwd);
  if (!existsSync(dir)) return [];
  const entries: SessionEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = join(dir, f);
    const e = parseSessionFile(full);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/** The most recently modified session file for a cwd (the "active" one). */
export function mostRecentSession(cwd: string): SessionEntry | null {
  const list = listSessions(cwd);
  return list[0] ?? null;
}

export function listLocalProjects(): string[] {
  const root = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(root)) return [];
  const projects = readdirSync(root)
    .map((name) => decodeCwd(name))
    .filter((v): v is string => !!v)
    .sort((a, b) => a.localeCompare(b));
  return projects;
}
