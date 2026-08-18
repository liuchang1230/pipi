/**
 * Session command discovery: wraps RPC `get_commands` (pi rpc.md) with a
 * per-tab cache and merges a local copy of pi's built-in slash commands so
 * the chat view can surface something much closer to native pi.
 */

export type SessionCommandSource = "extension" | "prompt" | "skill" | "builtin";

export interface SessionCommand {
  name: string;
  description?: string;
  source: SessionCommandSource;
  location?: string;
  path?: string;
  argumentHint?: string;
  supportedInChat?: boolean;
  sortIndex?: number;
}

export interface CommandsResult {
  commands: SessionCommand[];
  error?: string;
}

const cache = new Map<string, { at: number; commands: SessionCommand[] }>();
const CACHE_TTL_MS = 60_000;
const inflight = new Map<string, Promise<SessionCommand[]>>();

// Mirrored from pi dist/core/slash-commands.js. RPC get_commands intentionally
// excludes these because they are interactive-mode built-ins, but users expect
// to see them in slash completion.
const BUILTIN_COMMANDS: SessionCommand[] = [
  { name: "settings", description: "Open settings menu", source: "builtin", supportedInChat: true, sortIndex: 0 },
  { name: "model", description: "Select model", source: "builtin", argumentHint: "<provider/model>", supportedInChat: true, sortIndex: 1 },
  { name: "scoped-models", description: "Enable/disable scoped model cycling", source: "builtin", supportedInChat: false, sortIndex: 2 },
  { name: "export", description: "Export session (HTML)", source: "builtin", argumentHint: "<路径>", supportedInChat: true, sortIndex: 3 },
  { name: "import", description: "Import and resume a session", source: "builtin", supportedInChat: false, sortIndex: 4 },
  { name: "share", description: "Share session as a gist", source: "builtin", supportedInChat: false, sortIndex: 5 },
  { name: "copy", description: "Copy last agent message", source: "builtin", supportedInChat: true, sortIndex: 6 },
  { name: "name", description: "Set session display name", source: "builtin", argumentHint: "<会话名>", supportedInChat: true, sortIndex: 7 },
  { name: "session", description: "Show session info and stats", source: "builtin", supportedInChat: true, sortIndex: 8 },
  { name: "changelog", description: "Show changelog entries", source: "builtin", supportedInChat: false, sortIndex: 9 },
  { name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin", supportedInChat: false, sortIndex: 10 },
  { name: "fork", description: "Create a new fork from a previous user message", source: "builtin", supportedInChat: true, sortIndex: 11 },
  { name: "clone", description: "Duplicate the current session at the current position", source: "builtin", supportedInChat: true, sortIndex: 12 },
  { name: "tree", description: "Navigate session tree", source: "builtin", supportedInChat: true, sortIndex: 13 },
  { name: "trust", description: "Save project trust decision", source: "builtin", supportedInChat: false, sortIndex: 14 },
  { name: "login", description: "Configure provider authentication", source: "builtin", argumentHint: "<provider>", supportedInChat: false, sortIndex: 15 },
  { name: "logout", description: "Remove provider authentication", source: "builtin", supportedInChat: false, sortIndex: 16 },
  { name: "new", description: "Start a new session", source: "builtin", supportedInChat: true, sortIndex: 17 },
  { name: "compact", description: "Manually compact the session context", source: "builtin", supportedInChat: true, sortIndex: 18 },
  { name: "resume", description: "Resume a different session", source: "builtin", supportedInChat: true, sortIndex: 19 },
  // RPC/remote sessions cannot expose the SDK-only reload operation. It is
  // still listed so users can discover it, but the menu marks it as TUI-only
  // for those transports (ChatPane performs the final backend check). The
  // generic metadata stays conservative because the same command is valid in
  // local SDK chat.
  { name: "reload", description: "Reload extensions, skills, prompts and themes", source: "builtin", supportedInChat: true, sortIndex: 20 },
  { name: "quit", description: "Quit pi", source: "builtin", supportedInChat: false, sortIndex: 21 },
];

/** Fetch (cached) the session's commands. Empty array on failure. */
export function fetchCommands(tabId: string, force = false): Promise<CommandsResult> {
  const hit = cache.get(tabId);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Promise.resolve({ commands: hit.commands });
  }
  let pending = inflight.get(tabId);
  if (!pending) {
    pending = window.api.tab
      .rpcRequest(tabId, { type: "get_commands" }, 20000)
      .then((res) => {
        const raw = res.data as { commands?: unknown[] } | undefined;
        const commands = mergeCommands(parseCommands(raw?.commands));
        if (res.success) {
          cache.set(tabId, { at: Date.now(), commands });
          pruneCache();
        }
        return commands;
      })
      .finally(() => inflight.delete(tabId));
    inflight.set(tabId, pending);
  }
  return pending.then((commands) => ({ commands }));
}

export function invalidateCommands(tabId: string): void {
  cache.delete(tabId);
}

/** Evict stale per-tab entries so closed tabs don't accumulate forever. */
function pruneCache(): void {
  const now = Date.now();
  for (const [tabId, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS * 2) cache.delete(tabId);
  }
}

function parseCommands(raw: unknown): SessionCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionCommand[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as { name?: unknown; source?: unknown; description?: unknown; location?: unknown; path?: unknown };
    if (typeof o.name !== "string" || !o.name) continue;
    const source = o.source === "skill" || o.source === "prompt" || o.source === "extension" ? o.source : "extension";
    out.push({
      name: o.name,
      source,
      description: typeof o.description === "string" ? o.description : undefined,
      location: typeof o.location === "string" ? o.location : undefined,
      path: typeof o.path === "string" ? o.path : undefined,
      supportedInChat: true,
    });
  }
  return out;
}

function mergeCommands(dynamic: SessionCommand[]): SessionCommand[] {
  const byName = new Map<string, SessionCommand>();
  for (const c of BUILTIN_COMMANDS) byName.set(c.name, c);
  for (const c of dynamic) byName.set(c.name, c);
  return sortCommands(Array.from(byName.values()));
}

const SOURCE_LABEL: Record<SessionCommandSource, string> = {
  builtin: "内建",
  extension: "扩展",
  prompt: "模板",
  skill: "技能",
};

const SOURCE_ICON: Record<SessionCommandSource, string> = {
  builtin: "⚙",
  extension: "🧩",
  prompt: "📄",
  skill: "📘",
};

export function sourceLabel(source: SessionCommandSource): string {
  return SOURCE_LABEL[source];
}

export function sourceIcon(source: SessionCommandSource): string {
  return SOURCE_ICON[source];
}

/** Filter commands for the slash popup: prefix matches first, then contains. */
export function filterCommands(commands: SessionCommand[], query: string): SessionCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const prefix: SessionCommand[] = [];
  const rest: SessionCommand[] = [];
  for (const c of commands) {
    if (c.name.toLowerCase().startsWith(q)) prefix.push(c);
    else if (
      c.name.toLowerCase().includes(q) ||
      (c.description ?? "").toLowerCase().includes(q) ||
      (c.argumentHint ?? "").toLowerCase().includes(q)
    ) rest.push(c);
  }
  return sortCommands([...prefix, ...rest]);
}

function sortCommands(commands: SessionCommand[]): SessionCommand[] {
  const sourceRank: Record<SessionCommandSource, number> = {
    builtin: 0,
    skill: 1,
    prompt: 2,
    extension: 3,
  };
  return [...commands].sort((a, b) => {
    if (a.source === "builtin" && b.source === "builtin") {
      return (a.sortIndex ?? Number.MAX_SAFE_INTEGER) - (b.sortIndex ?? Number.MAX_SAFE_INTEGER);
    }
    const sourceDelta = sourceRank[a.source] - sourceRank[b.source];
    if (sourceDelta !== 0) return sourceDelta;
    return a.name.localeCompare(b.name);
  });
}

export function commandGroupLabel(source: SessionCommandSource): string {
  switch (source) {
    case "builtin":
      return "Pi 内建";
    case "skill":
      return "Skills";
    case "prompt":
      return "Prompt Templates";
    case "extension":
      return "Extensions";
  }
}

export function commandTokenAt(input: string, caret: number): { start: number; query: string } | null {
  const before = input.slice(0, caret);
  const m = before.match(/(?:^|\s)(\/[^\s]*)$/);
  if (!m) return null;
  const token = m[1]!;
  if (token === "/") return { start: caret - 1, query: "" };
  return { start: caret - token.length, query: token.slice(1) };
}

export function replaceCommandToken(input: string, tokenStart: number, queryLen: number, name: string, argumentHint?: string): string {
  const suffix = argumentHint ? ` ${argumentHint} ` : " ";
  return input.slice(0, tokenStart) + "/" + name + suffix + input.slice(tokenStart + 1 + queryLen);
}
