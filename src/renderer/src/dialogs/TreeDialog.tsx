/**
 * Session tree dialog — aligned with pi's TUI /tree (TreeSelectorComponent):
 *  - connector gutter (│/├/└), fold markers (⊞/⊟ inside the gutter, like the
 *    TUI), active-path dots, branch labels, per-row timestamps (HH:MM today,
 *    M/D otherwise)
 *  - per-type entry labels (user:/assistant:/[tool]/[model]/[compaction]/…)
 *  - default view hides bookkeeping entries (label/model_change/…) and
 *    tool-call-only assistant rows — same visibility rules as the TUI's
 *    applyFilter; quick filter chips (标准/用户/无工具/全部) + multi-token search
 *  - folding hides descendants (a child whose parent is folded collapses
 *    into it, like the TUI's fold handling; gutter shapes are computed on
 *    the full tree, so a folded tail row keeps its elbow — cosmetic only)
 *  - windowed rendering: only the rows around the viewport mount, so a
 *    thousand-entry session renders ~30 rows regardless of size
 *  - keyboard: ↑/↓ move, Home/End jump, Enter navigates, Shift+Enter offers
 *    the summary choice, Ctrl+F focuses search, Esc backs out / closes
 *  - active-branch-first ordering, single-child chains rendered flat
 *  - current leaf pre-selected, fold/unfold
 *  - navigate to a point (SDK tabs: native `navigate_tree` RPC — a silent
 *    session operation, nothing enters the prompt channel; RPC-backed
 *    remote/WSL tabs: pipi-tree-nav extension command bridge, since
 *    upstream pi has no native command), with the same "Summarize branch?"
 *    choice as /tree; fork kept as the "start new branch" action
 *    (equivalent to /fork).
 *
 * Self-healing fetch: the tree is re-asked every 3s while the dialog is
 * open (paused during navigation), so a remote/WSL pi still booting, a
 * dropped first request, or a worker hiccup fills in instead of leaving a
 * stale empty tree; explicit failures show an error + retry, and a truly
 * blank session gets its own empty-state copy instead of a misleading
 * "（无匹配）". Identical snapshots (same entries + leaf) are dropped
 * instead of re-rendering — the poll costs nothing while nothing changes.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../stores/uiStore";
import { useTabsStore } from "../stores/tabsStore";
import { useChatStore } from "../stores/chatStore";
import { buildTreeFromEntries, type TreeEntry, type TreeNode } from "../../../shared/tree-build";
import { flattenTree, isAlreadyAtTarget, isNavigationSettled, type TreeFlatRow } from "../../../shared/tree-layout";
import { compactForMindMap } from "../../../shared/tree-mindmap";
import { applyVisibility, formatEntryTime, type TreeFilterMode } from "../../../shared/tree-view";
import { createEntriesSlot, ENTRIES_STALL_MS } from "./tree-poll-guard";
import { parseEditArgs } from "../components/DiffView";
import { fetchCommands } from "../commands";

interface TreeResponse {
  tree?: TreeNode[];
  leafId?: string | null;
}

// --- text/content helpers ---------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }
  return "";
}

function normalize(s: string): string {
  return s.replace(/[\n\t]/g, " ").trim();
}

/** Turn raw get_entries failures into user-facing copy. */
function friendlyTreeError(raw: string): string {
  if (/unknown command/i.test(raw)) {
    return "pi 版本过低：会话树需要 get_entries/get_tree 命令（pi ≥ 0.80.3）";
  }
  return raw;
}

function formatToolCall(name: string, args: unknown): string {
  const a = args as Record<string, unknown> | undefined;
  if (!a) return name;
  const parts: string[] = [];
  for (const key of ["command", "path", "filePath", "pattern", "query", "dirPath", "tool"]) {
    const v = a[key];
    if (typeof v === "string") {
      parts.push(`${key}=${normalize(v).slice(0, 60)}`);
      break;
    }
  }
  if (parts.length === 0) {
    const first = Object.entries(a)[0];
    if (first) parts.push(`${first[0]}=${String(first[1]).slice(0, 60)}`);
  }
  return parts.length ? `${name} ${parts.join(" ")}` : name;
}

// --- flattening (mirrors TreeSelectorComponent.flattenTree) -----------------

// --- entry display (mirrors getEntryDisplayText) ----------------------------

/** Tools that mutate files — their nodes are rollback checkpoints. */
const EDIT_TOOLS = new Set(["edit", "apply_patch", "write_file", "write"]);

function isEditToolCall(tc: { name: string; args: unknown } | undefined): { path?: string } | null {
  if (!tc || !EDIT_TOOLS.has(tc.name)) return null;
  const args = (tc.args ?? {}) as { path?: unknown; filePath?: unknown };
  if (typeof args.path === "string") return { path: args.path };
  if (typeof args.filePath === "string") return { path: args.filePath };
  return {};
}

function entryDisplay(node: TreeNode, toolCalls: Map<string, { name: string; args: unknown }>, mind = false): { label: string; cls: string; text: string } {
  const e = node.entry;
  switch (e.type) {
    case "message": {
      const role = e.message?.role;
      const text = normalize(textOf(e.message?.content));
      // In the mind map the label is the speaker, not the wire role: 「你」/「AI」.
      const you = mind ? "你" : "user:";
      const ai = mind ? "AI" : "assistant:";
      if (role === "user") return { label: you, cls: "user", text };
      if (role === "assistant") {
        if (text) return { label: ai, cls: "assistant", text };
        if (e.message?.stopReason === "aborted") return { label: ai, cls: "assistant", text: "(aborted)" };
        if (e.message?.errorMessage) return { label: ai, cls: "assistant error", text: normalize(e.message.errorMessage).slice(0, 80) };
        return { label: ai, cls: "assistant", text: "(no content)" };
      }
      if (role === "toolResult") {
        const m = e.message as { toolCallId?: string; toolName?: string } | undefined;
        const tc = m?.toolCallId ? toolCalls.get(m.toolCallId) : undefined;
        if (tc) return { label: "", cls: "muted", text: formatToolCall(tc.name, tc.args) };
        return { label: "", cls: "muted", text: `[${m?.toolName ?? "tool"}]` };
      }
      if (role === "bashExecution") return { label: "", cls: "muted", text: `[bash]: ${normalize(e.command ?? "")}` };
      return { label: "", cls: "muted", text: `[${role}]` };
    }
    case "custom_message": {
      const content = typeof e.content === "string" ? e.content : textOf(e.content);
      return { label: "", cls: "custom", text: `[${e.customType ?? "custom"}]: ${normalize(content)}` };
    }
    case "compaction":
      return { label: "", cls: "compaction", text: `[compaction: ${Math.round((e.tokensBefore ?? 0) / 1000)}k tokens]` };
    case "branch_summary":
      return { label: "", cls: "summary", text: `[branch summary]: ${normalize(e.summary ?? "")}` };
    case "model_change":
      return { label: "", cls: "muted", text: `[model: ${e.modelId ?? ""}]` };
    case "thinking_level_change":
      return { label: "", cls: "muted", text: `[thinking: ${e.thinkingLevel ?? ""}]` };
    case "label":
      return { label: "", cls: "muted", text: `[label: ${e.label ?? "(cleared)"}]` };
    case "session_info":
      return { label: "", cls: "muted", text: e.name ? `[title: ${e.name}]` : "[title: empty]" };
    case "custom":
      return { label: "", cls: "muted", text: `[custom: ${e.customType ?? ""}]` };
    default:
      return { label: "", cls: "muted", text: "" };
  }
}

// --- component --------------------------------------------------------------

type SummaryChoice = "none" | "auto" | "custom";

const FILTER_LABELS: Record<TreeFilterMode, string> = {
  default: "标准",
  "user-only": "用户",
  "no-tools": "无工具",
  "labeled-only": "标签",
  all: "全部",
};

/** Row window around the viewport — long sessions mount ~2×40 rows, not all. */
const WINDOW_MARGIN = 20;
/** `.tree-row` height from styles.css. One definition, because the window math
 *  and the spacer heights must agree or the scrollbar jitters. */
const ROW_H = 24;
/** Height of a 导图 card row: speaker line + one line of text (styles.css). */
const MIND_ROW_H = 46;

/**
 * One tree row.
 *
 * Extracted + memoized because the windowed list re-renders on EVERY scroll
 * event: without memo each wheel tick reconciled all ~80 rows (each rebuilding
 * its gutter prefix and re-normalizing its entry text — `entryDisplay` walks the
 * message content), which is what made scrolling feel sticky on long sessions.
 * With memo, a scroll only mounts/unmounts the rows entering and leaving the
 * window; the ~70 rows that stay are skipped entirely.
 *
 * All per-row derived values (gutter prefix, display label/text) are computed
 * HERE, from props that are stable between renders, so the parent does not have
 * to hand down freshly-allocated objects (which would defeat the memo).
 */
const TreeRow = memo(function TreeRow({
  row,
  toolCalls,
  selectedId,
  folded,
  leafId,
  editPoint,
  multipleRoots,
  mind,
  onSelect,
  onToggleFold,
}: {
  row: TreeFlatRow;
  toolCalls: Map<string, { name: string; args: unknown }>;
  selectedId: string | null;
  folded: Set<string>;
  leafId: string | null;
  editPoint: { path?: string } | undefined;
  /** Tree has several roots (offset the whole gutter by one column). */
  multipleRoots: boolean;
  /** Mind-map view: 「你」/「AI」 labels (see compactForMindMap). */
  mind: boolean;
  onSelect: (id: string) => void;
  onToggleFold: (id: string) => void;
}) {
  const e = row.node.entry;
  const d = useMemo(() => entryDisplay(row.node, toolCalls, mind), [row.node, toolCalls, mind]);
  const prefix = useMemo(() => {
    const displayIndent = multipleRoots ? Math.max(0, row.indent - 1) : row.indent;
    const connectorPosition = row.showConnector && !row.isVirtualRootChild ? displayIndent - 1 : -1;
    let out = "";
    for (let level = 0; level < displayIndent; level++) {
      const g = row.gutters.find((x) => x.position === level);
      if (g) out += g.show ? "│  " : "   ";
      else if (level === connectorPosition) out += (row.isLast ? "└" : "├") + "─ ";
      else out += "   ";
    }
    return out;
  }, [row, multipleRoots]);

  const isSelected = e.id === selectedId;
  const hasChildren = row.node.children.length > 0;
  const branchCount = row.node.children.length;
  const isFolded = folded.has(e.id);
  const ts = formatEntryTime(e.timestamp);

  return (
    <div
      data-row-id={e.id}
      data-role={mind ? (e.message?.role ?? "other") : undefined}
      className={`tree-row${mind ? " tree-row-mind" : ""}${isSelected ? " selected" : ""}${row.onActivePath ? " on-active-path" : ""}${row.isCurrent ? " current" : ""}${leafId && !row.onActivePath ? " off-path" : ""}`}
      onClick={() => onSelect(e.id)}
      onDoubleClick={() => hasChildren && onToggleFold(e.id)}
      title={d.text || e.id}
    >
      <span className="tree-gutter">{prefix}</span>
      <span
        className="tree-fold"
        onClick={(ev) => { ev.stopPropagation(); hasChildren && onToggleFold(e.id); }}
      >
        {hasChildren ? (isFolded ? "⊞" : "⊟") : ""}
      </span>
      <span className="tree-pathmark">{row.onActivePath ? "•" : ""}</span>
      {branchCount > 1 && (
        <span className="tree-branchcount" title={`此处有 ${branchCount} 条分支`}>
          ⑂{branchCount}
        </span>
      )}
      {mind ? (
        // 导图：每条消息一张小卡片（说话人 + 时间在上，正文一行在下），左侧色条
        // 表达分支归属 —— 用户选的观感（见 CONTEXT.md 2026-09-25）。
        <span className={`tree-card ${d.cls}`}>
          <span className="tree-card-head">
            <span className={`tree-entrylabel ${d.cls}`}>{d.label}</span>
            {row.node.label && <span className="tree-branch-tag">[{row.node.label}]</span>}
            {editPoint && <span className="tree-cp-tag" title={`回退点：此节点后文件已变更（${editPoint.path ?? "未知路径"}）`}>⤺</span>}
            <span className="tree-card-spacer" />
            {ts && <span className="tree-time" title={e.timestamp}>{ts}</span>}
            {row.isCurrent && <span className="tree-leaf-tag">当前</span>}
          </span>
          <span className={`tree-card-text ${d.cls}`}>{d.text || "（无内容）"}</span>
        </span>
      ) : (
        <>
          {row.node.label && <span className="tree-branch-tag">[{row.node.label}]</span>}
          <span className={`tree-entrylabel ${d.cls}`}>{d.label}</span>
          <span className={`tree-entrytext ${d.cls}`}>{d.text}</span>
          {editPoint && <span className="tree-cp-tag" title={`回退点：此节点后文件已变更（${editPoint.path ?? "未知路径"}），可回退到此状态`}>⤺ 回退点</span>}
          {ts && <span className="tree-time" title={e.timestamp}>{ts}</span>}
          {row.isCurrent && <span className="tree-leaf-tag">当前</span>}
        </>
      )}
    </div>
  );
});

export function TreeDialog({
  tabId,
  onClose,
  onOpenTerminal,
  onNavigated,
}: {
  tabId: string;
  onClose: () => void;
  /** Switch to the terminal view (TUI), where the native /tree lives. */
  onOpenTerminal?: () => void;
  /** Called after a successful navigation; editorText = the replayed/fill text. */
  onNavigated?: (editorText?: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<TreeFilterMode>("default");
  /**
   * 导图 (default) shows only your messages and the AI's replies, re-parented so
   * the indentation describes the CONVERSATION ("不用显示工具调用，只需要显示 user
   * 和 assistant 的回复"). 完整 is the previous every-entry tree, kept because
   * tool calls, labels and compactions are sometimes exactly what you are looking
   * for (and because rollback needs them).
   */
  const [view, setView] = useState<"mindmap" | "full">("mindmap");
  const [error, setError] = useState<string | null>(null);
  const [navPhase, setNavPhase] = useState<"idle" | "choose-summary" | "custom-instructions" | "navigating">("idle");
  const [customInstr, setCustomInstr] = useState("");
  const [navigatingId, setNavigatingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Tree fetch state machine: "loading" until the first get_tree response
  // (remote/WSL pi takes 15-20s to boot, so this can be a long wait),
  // "error" on an explicit failure, "ready" after any successful snapshot.
  // The dialog re-asks on an interval (below) so a slow boot or a dropped
  // first request heals itself instead of sitting on an empty tree.
  const [treeStatus, setTreeStatus] = useState<"loading" | "ready" | "error">("loading");
  const [slowTicks, setSlowTicks] = useState(0); // ~3s each; drives the "still loading" hint
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Last applied snapshot (entries + leaf) — identical polls are dropped. */
  const lastSnapshotRef = useRef<{ entries: TreeEntry[]; leafId: string | null } | null>(null);
  /**
   * Cursor for incremental polling: the last entry id we have. `get_entries`
   * with `since` returns ONLY entries after it plus the current `leafId` — the
   * difference between a few hundred bytes and a 2778-entry payload (the user's
   * session!). Measured on their remote: every full poll cost 3.0-3.4s, and
   * navigation polls made it worse (the app log shows 8 polls over 56s).
   * `null` = ask for everything (first load, or after a rejected cursor).
   */
  const entriesCursorRef = useRef<string | null>(null);
  /**
   * Which kind of answer does request `<id>` bring? A cursor response must be
   * APPENDED, a full one REPLACES the list. Deciding from "is a cursor set right
   * now" was wrong — the cursor can change between sending and receiving (another
   * response lands first), which would either duplicate the whole session or drop
   * the entries we already had. Unknown ids (other components' requests) default
   * to "replace", which is always safe.
   */
  const entriesRequestKindRef = useRef(new Map<string, "replace" | "append">());
  const nextEntriesRequestId = useRef(0);
  /** Ids already in `lastSnapshotRef` — appended batches are de-duplicated so
   *  two overlapping polls (the 3s refresh and the 1s navigation poll) cannot
   *  double a row. Rebuilt on a replacing response. */
  const knownEntryIdsRef = useRef(new Set<string>());
  // Mirrors for timers/closures that must not capture stale render values.
  const treeStatusRef = useRef(treeStatus);
  treeStatusRef.current = treeStatus;
  /** When the last get_tree response (any outcome) arrived — stall detection. */
  const lastResponseAtRef = useRef(Date.now());
  /** True once a LIVE get_tree response applied — file snapshot must not
   *  overwrite newer live data (e.g. RPC answered before the file read). */
  const rpcTreeArrivedRef = useRef(false);
  /** True while the shown tree is the file snapshot (RPC not yet answered). */
  const [fileSnapshot, setFileSnapshot] = useState(false);
  /** Last from-file attempt outcome — only "no session file" (tab's session
   *  path not linked yet, pi still booting) is worth retrying; a real read
   *  failure would just repeat the same SFTP/ssh cost. */
  const fileAttemptRef = useRef<{ error: string; at: number }>({ error: "", at: 0 });

  useEffect(() => {
    // Initial fetch + auto-refresh loop. get_tree answers may be delayed
    // (RPC boot) or never arrive (worker crash / tab gone mid-open): the
    // loop re-asks every 3s while the dialog is open (paused during
    // navigation — the navigation poll owns get_tree then) and surfaces an
    // explicit error when rpcSend reports the tab is gone.
    const sendRefresh = () => {
      // get_entries (flat) instead of get_tree (nested): Electron's
      // contextBridge rejects trees nested deeper than 1000 levels, which a
      // long linear session is. The renderer rebuilds the tree from entries.
      // Single-flight: never stack a second request while one is unanswered
      // (see entriesInFlightRef) — the poll interval is far shorter than a
      // slow remote round trip.
      if (!tryAcquireEntriesSlot()) return;
      const since = entriesCursorRef.current;
      const id = `tree-poll-${++nextEntriesRequestId.current}`;
      entriesRequestKindRef.current.set(id, since ? "append" : "replace");
      void window.api.tab.rpcSend(tabId, since ? { type: "get_entries", since, id } : { type: "get_entries", id })
        .then((ok) => {
          window.api.debug.log(`TreeDialog(${tabId}) get_entries sent ok=${ok} since=${since ?? "-"}`, ok ? "debug" : "warn");
          if (!ok) {
            releaseEntriesSlot();
            if (!pendingNavRequestId.current) {
              setTreeStatus("error");
              setError("会话不可用（标签页未就绪或已退出）");
            }
          }
        })
        .catch(() => {
          // IPC rejected (e.g. window torn down mid-invoke): release the slot
          // so the interval retries and heals on success.
          releaseEntriesSlot();
        });
    };
    /** Apply a fetched snapshot, dropping no-op polls so nothing re-renders
     *  while the session is unchanged (the 3s poll stays free).
     *
     *  A cursor response carries only the NEW entries (append), a full one
     *  replaces the list — the session is append-only, so appending is exact and
     *  keeps the abandoned branches we already have. */
    /** Identity-preserving compare of two entry lists (id+parent+type+time). */
    const sameEntries = (a: TreeEntry[], b: TreeEntry[]): boolean => {
      if (a === b) return true;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        const x = a[i]!, y = b[i]!;
        if (x.id !== y.id || x.type !== y.type || x.parentId !== y.parentId || x.timestamp !== y.timestamp) return false;
      }
      return true;
    };
    const applySnapshot = (batch: TreeEntry[], nextLeaf: string | null, mode: "replace" | "append") => {
      const prev = lastSnapshotRef.current;
      let entries: TreeEntry[];
      if (mode === "append" && prev) {
        const known = knownEntryIdsRef.current;
        const fresh = batch.filter((e) => !known.has(e.id));
        for (const e of fresh) known.add(e.id);
        entries = fresh.length > 0 ? [...prev.entries, ...fresh] : prev.entries;
      } else {
        // A replace whose content equals what we already render (a poll answered
        // with the full list because the cursor was just reset) must not fork the
        // array identity: every useMemo below keys on it.
        entries = prev && sameEntries(prev.entries, batch) ? prev.entries : batch;
        knownEntryIdsRef.current = new Set(batch.map((e) => e.id));
      }
      const lastId = entries.length ? entries[entries.length - 1]!.id : null;
      // Advance the cursor for the next poll (never move it backwards).
      if (lastId) entriesCursorRef.current = lastId;
      const prevLeaf = prev?.leafId ?? null;
      // Fast path FIRST: an identical array identity (the append branch reuses
      // prev.entries when a poll found nothing new) means nothing below — the
      // tree, the projection, the flat list, every memo — can be skipped. The
      // navigation poll relied on the element-wise compare below for this, which
      // still walked 2778 entries every second and, in append mode, allocated a
      // fresh `[...prev.entries]` so the compare never saw "same" anyway.
      if (prev && prevLeaf === nextLeaf && prev.entries === entries) {
        setError(null);
        setTreeStatus("ready");
        setSlowTicks(0);
        return;
      }
      if (prev && prevLeaf === nextLeaf && prev.entries.length === entries.length) {
        let same = true;
        for (let i = 0; i < entries.length; i++) {
          const a = prev.entries[i]!, b = entries[i]!;
          if (a.id !== b.id || a.type !== b.type || a.parentId !== b.parentId || a.timestamp !== b.timestamp) {
            same = false;
            break;
          }
        }
        if (same) {
          setError(null);
          setTreeStatus("ready");
          setSlowTicks(0);
          return;
        }
      }
      lastSnapshotRef.current = { entries, leafId: nextLeaf };
      setTree(buildTreeFromEntries(entries).tree);
      setLeafId(nextLeaf);
      setError(null);
      setTreeStatus("ready");
      setSlowTicks(0);
    };
    sendRefresh();
    const tryFileSnapshot = () => {
      void window.api.tree.fromFile(tabId)
        .then((res) => {
          window.api.debug.log(`TreeDialog(${tabId}) fromFile ok=${res.ok} ${res.error ?? ""} entries=${Array.isArray(res.entries) ? res.entries.length : "?"}`);
          fileAttemptRef.current = { error: res.ok ? "" : String(res.error ?? ""), at: Date.now() };
          // Skip when live data already arrived, OR while a navigation is in
          // flight — the snapshot's stale leaf must not trip the navigation
          // completion detector (which fires on leafId change + navigatingId).
          if (res.ok && !rpcTreeArrivedRef.current && !pendingNavRequestId.current && Array.isArray(res.entries)) {
            const entries = res.entries as TreeEntry[];
            lastSnapshotRef.current = { entries, leafId: res.leafId ?? null };
            setTree(buildTreeFromEntries(entries).tree);
            setLeafId(res.leafId ?? null);
            setError(null);
            setTreeStatus("ready");
            setSlowTicks(0);
            setFileSnapshot(true);
          }
        })
        .catch((err) => {
          window.api.debug.log(`TreeDialog(${tabId}) fromFile REJECTED ${err instanceof Error ? err.message : String(err)}`, "error");
          fileAttemptRef.current = { error: "", at: Date.now() };
          // File read unavailable (session not yet linked, transient SFTP
          // failure) — the RPC path below is the fallback.
        });
    };
    // Fast first paint from the session file — no pi round-trip, so a
    // remote pi still booting (or dead) can't hold the tree hostage. The
    // RPC get_tree refresh below then corrects leaf/streaming state.
    tryFileSnapshot();
    // First-response boost: a dropped/late first request should not leave
    // the dialog spinning for a full 3s interval; re-ask once shortly after
    // mount when still loading (no-op once a response flipped us to ready).
    const boostTimer = setTimeout(() => {
      if (treeStatusRef.current === "loading" && !pendingNavRequestId.current) sendRefresh();
    }, 1500);
    const timer = setInterval(() => {
      if (pendingNavRequestId.current) return; // navigation poll owns get_tree
      sendRefresh();
      setSlowTicks((n) => n + 1);
      // The tab's session file may only become linkable AFTER pi answers
      // get_state (continueRecent / new remote sessions). If the last file
      // attempt said "no session file", retry now that pi had time to boot.
      if (treeStatusRef.current === "loading" && fileAttemptRef.current.error === "no session file" && Date.now() - fileAttemptRef.current.at > 15000) {
        tryFileSnapshot();
      }
      // No response for a long time while we still have nothing to show:
      // stop the infinite spinner and surface a diagnosis. The interval
      // keeps retrying underneath — a late response flips back to "ready".
      if (treeStatusRef.current === "loading" && Date.now() - lastResponseAtRef.current > 45000) {
        setTreeStatus("error");
        const fileErr = fileAttemptRef.current.error ? ` · 会话文件读取失败（${fileAttemptRef.current.error}）` : "";
        setError(`远程 pi 未响应（已等待较长时间）${fileErr}。请检查服务器 pi 版本（会话树需 ≥0.80.3）、网络连接或 pi 进程是否存活；可切到终端视图查看，或重开会话。正在后台自动重试…`);
      }
    }, 3000);
    refreshTimerRef.current = timer;
    const off = window.api.onRpcEvent(tabId, (event) => {
      // Entry diagnostics: which events actually reach this handler (a
      // response here proves the event channel is alive end-to-end).
      if (event.type === "response") {
        window.api.debug.log(`TreeDialog(${tabId}) EVENT resp ${String(event.command)}${event.success === false ? " success=false" : ""}${event.id ? ` id=${String(event.id)}` : ""}`, "debug");
      }
      if (event.type === "rpc_no_output") {
        // Remote pi produced ZERO bytes (ssh2 auth hang / exec stalled /
        // bash -ic blocked on .bashrc / pi missing). Only surface when the
        // file snapshot couldn't paint either — a shown tree stays useful.
        if (treeStatusRef.current === "loading") {
          setTreeStatus("error");
          setError("远程 pi 完全无输出（40s 无任何数据）。可能原因：远程服务器未安装 pi-agent / 登录脚本(.bashrc)卡住 / SSH 通道未建立，或保存的密码认证失败。请切到终端视图确认登录与 pi 安装。");
        }
        return;
      }
      if (event.type === "rpc_stalled") {
        // Bytes ARE flowing but pi never answers a command — the login shell
        // is likely stuck (bash -ic sources .bashrc, which can hang under
        // pipes) or the remote pi is unresponsive. The junk lines distinguish
        // "shell noise" from "silence".
        if (treeStatusRef.current === "loading") {
          const junk = Array.isArray((event as { junkLines?: unknown }).junkLines) ? ((event as { junkLines?: unknown }).junkLines as string[]) : [];
          const detail = junk.length > 0
            ? `远程登录脚本输出（非 pi 数据）：${junk.join(" | ").slice(0, 300)}`
            : "远程有字节流出但 pi 无任何应答";
          setTreeStatus("error");
          setError(`远程 pi 未应答（60s）· ${detail}。常见原因：服务器 .bashrc 在无终端管道下卡住（pi 未启动）、或远程 pi 异常。请切到终端视图确认登录与 pi --version。`);
        }
        return;
      }
      if (event.type === "response" && event.command === "navigate_tree") {
        if (pendingNavRequestId.current && event.id === pendingNavRequestId.current) {
          if (!event.success) {
            // Native navigation errors (e.g. entry not found / agent still
            // streaming) arrive as a failed response frame — surface them
            // instead of waiting out the polling timeout.
            if (pendingNavTimer.current) {
              clearInterval(pendingNavTimer.current);
              pendingNavTimer.current = null;
            }
            pendingNavRequestId.current = null;
            setNavPhase("idle");
            setNavigatingId(null);
            useUiStore.getState().showToast(`导航失败: ${String(event.error ?? "未知错误")}`, "err");
          } else {
            // Success: session.navigateTree resolved — any extension prompt
            // (e.g. pi-rewind's "Restore Options" during session_before_tree)
            // was answered as part of it. Finish immediately instead of
            // relying on the leaf-change poll, which never fires when the
            // target's parent equals the current leaf. Only a
            // cancelled/aborted navigation needs handling here.
            const data = event.data as { cancelled?: boolean; aborted?: boolean } | undefined;
            if (data?.cancelled || data?.aborted) {
              if (pendingNavTimer.current) {
                clearInterval(pendingNavTimer.current);
                pendingNavTimer.current = null;
              }
              pendingNavRequestId.current = null;
              setNavPhase("idle");
              setNavigatingId(null);
              useUiStore.getState().showToast(data.aborted ? "摘要已中止" : "导航已取消", "ok");
            } else {
              completionRef.current();
            }
          }
        }
        return;
      }
      if (event.type !== "response" || event.command !== "get_entries") return;
      lastResponseAtRef.current = Date.now();
      // Any get_entries response — refresh poll or navigation poll — frees the
      // single-flight slot. Done BEFORE the navigation filter below: a late
      // refresh response must not leave the slot claimed forever.
      releaseEntriesSlot();
      // During navigation, ignore unrelated tree snapshots (initial refreshes
      // or another consumer's request). They must not be able to complete the
      // current navigation early.
      if (pendingNavRequestId.current && event.id !== pendingNavRequestId.current) return;
      const data = event.data as { entries?: unknown[]; leafId?: string | null; error?: string };
      const responseId = typeof event.id === "string" ? event.id : "";
      const mode = entriesRequestKindRef.current.get(responseId) ?? "replace";
      entriesRequestKindRef.current.delete(responseId);
      if (event.success && Array.isArray(data.entries)) {
        rpcTreeArrivedRef.current = true;
        setFileSnapshot(false);
        window.api.debug.log(`TreeDialog(${tabId}) get_entries RESPONSE mode=${mode} entries=${data.entries.length} leaf=${data.leafId ?? "null"}`, "debug");
        applySnapshot(data.entries as TreeEntry[], data.leafId ?? null, mode);
      } else if (entriesCursorRef.current) {
        // The cursor no longer exists (session replaced: /new, switch, rewind
        // rewrite). Drop it and ask for the whole list once.
        window.api.debug.log(`TreeDialog(${tabId}) get_entries cursor rejected: ${String(event.error ?? "")}`, "warn");
        entriesCursorRef.current = null;
        lastSnapshotRef.current = null;
        knownEntryIdsRef.current = new Set();
        sendRefresh();
      } else {
        setTreeStatus("error");
        setError(friendlyTreeError(String(event.error ?? "获取会话树失败")));
      }
    });
    return () => {
      off();
      clearTimeout(boostTimer);
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [tabId]);

  // Corroboration for the empty-tree state: a session whose chat has
  // messages but whose tree is empty is an anomaly (auto-refresh retries);
  // a session with no messages is a genuinely blank session.
  const hasMessages = useChatStore((s) => (s.states[tabId]?.messages?.length ?? 0) > 0);
  /** pi process reported exited (e.g. RPC auth failed on a password remote). */
  const exited = useChatStore((s) => s.states[tabId]?.exited ?? false);

  // Tool-call lookup for toolResult rows.
  const toolCalls = useMemo(() => {
    const map = new Map<string, { name: string; args: unknown }>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.entry.type === "message" && n.entry.message?.role === "assistant") {
          const content = n.entry.message.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              const block = b as { type?: string; id?: string; name?: string; arguments?: unknown };
              if (block.type === "toolCall" && block.id) map.set(block.id, { name: block.name ?? "tool", args: block.arguments });
            }
          }
        }
        walk(n.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);

  // The mind-map projection is computed from the full tree and carries the leaf
  // mapped to the nearest kept ancestor — that is the row that gets 「当前」.
  const mindMap = useMemo(
    () => (view === "mindmap" ? compactForMindMap(tree, leafId) : null),
    [tree, leafId, view],
  );
  const displayTree = mindMap ? mindMap.tree : tree;
  /** Row height of the view being rendered — the spacers and the window math
   *  must agree with `.tree-row`/`.tree-row-mind` in styles.css. */
  const rowH = mindMap ? MIND_ROW_H : ROW_H;
  /** The leaf as the MAP sees it (the reply you are currently under). */
  const displayLeafId = mindMap ? mindMap.leafId : leafId;

  const { flat } = useMemo(() => flattenTree(displayTree, displayLeafId), [displayTree, displayLeafId]);

  // Filter/search over the flattened rows. `onActivePath`/`isCurrent` come from
  // the shared layout (src/shared/tree-layout.ts), which is unit-tested — the
  // dialog no longer keeps a second, untested copy of the ancestor walk.
  // The mind map already did its own filtering, so it only applies the search.
  const visible = useMemo(
    () => applyVisibility(flat, mindMap ? "all" : filterMode, query, displayLeafId),
    [flat, mindMap, filterMode, query, displayLeafId],
  );

  const filtered = useMemo(() => {
    if (folded.size === 0) return visible;
    const skip = new Set<string>();
    for (const f of visible) {
      const { id, parentId } = f.node.entry;
      if (parentId != null && (folded.has(parentId) || skip.has(parentId))) skip.add(id);
    }
    return visible.filter((f) => !skip.has(f.node.entry.id));
  }, [visible, folded]);

  const selected = useMemo(() => {
    for (const f of flat) if (f.node.entry.id === selectedId) return f.node;
    return null;
  }, [flat, selectedId]);

  // Rollback support: which node ids are file-edit checkpoints, and their path.
  const editPoints = useMemo(() => {
    const m = new Map<string, { path?: string }>();
    for (const [tcId, tc] of toolCalls) {
      const info = isEditToolCall(tc);
      if (info) m.set(tcId, info);
    }
    return m;
  }, [toolCalls]);
  const selectedEditPath = selected?.entry.type === "message" && selected.entry.message?.role === "toolResult"
    ? editPoints.get((selected.entry.message as { toolCallId?: string }).toolCallId ?? "")?.path ?? null
    : null;
  const [rollingBack, setRollingBack] = useState(false);

  const selectedText = selected ? normalize(textOf(selected.entry.message?.content)) : "";
  const isUserMsg = selected?.entry.type === "message" && selected.entry.message?.role === "user";
  const isLeaf = selected?.entry.id === displayLeafId;

  /** Stable identities: an inline arrow here would defeat TreeRow's memo and
   *  re-render all ~80 rows on every scroll event. */
  const selectRow = useCallback((id: string) => {
    setSelectedId(id);
    setNavPhase("idle");
  }, []);
  const toggleFold = useCallback((id: string) => {
    setFolded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Windowed rows: only entries within WINDOW_MARGIN of the viewport mount.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ start: 0, end: 80 });
  const winRef = useRef(win);
  winRef.current = win;
  /**
   * Recompute the mounted window from the scroll offset.
   *
   * rAF-throttled: a wheel can emit several scroll events per frame, and each
   * update re-renders the windowed list. Coalescing them to one update per
   * frame is what keeps long sessions scrollable at frame rate.
   */
  const rafRef = useRef<number | null>(null);
  /** The active row height (card rows are taller). Read through a ref so the
   *  windowing callbacks keep empty dependency lists instead of being rebuilt. */
  const rowHRef = useRef(ROW_H);
  const filteredRef = useRef<TreeFlatRow[]>([]);
  const displayLeafIdRef = useRef<string | null>(null);
  // Kept in sync every render, so the stable (empty-deps) callbacks and the
  // view-change effect can read the latest list/position/row height.
  rowHRef.current = rowH;
  filteredRef.current = filtered;
  displayLeafIdRef.current = displayLeafId;
  const recomputeWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rowH = rowHRef.current;
    const start = Math.max(0, Math.floor(el.scrollTop / rowH) - WINDOW_MARGIN);
    const count = Math.ceil(el.clientHeight / rowH) + WINDOW_MARGIN * 2;
    setWin((w) => (w.start === start && w.end === start + count ? w : { start, end: start + count }));
  }, []);
  const onScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recomputeWindow();
    });
  }, [recomputeWindow]);
  /**
   * Scroll so `index` is visible — pure index arithmetic instead of
   * `scrollIntoView`.
   *
   * Two reasons: (1) `scrollIntoView` also scrolls every scrollable ANCESTOR
   * (the dialog, the page) and forces a synchronous layout of all of it, which
   * is what made opening the dialog on a long session janky; (2) the total
   * height is constant (top + bottom spacers), so a row does not even have to be
   * mounted for its position to be known.
   */
  const revealRow = useCallback((index: number, mode: "center" | "nearest" = "nearest", retry = true) => {
    const el = scrollRef.current;
    if (!el || index < 0) return;
    // Not laid out yet (clientHeight 0 right after mount): try once more on the
    // next frame instead of scrolling to a position computed from a zero height.
    if (el.clientHeight === 0) {
      if (retry) requestAnimationFrame(() => revealRow(index, mode, false));
      return;
    }
    const rowH = rowHRef.current;
    const top = index * rowH;
    const bottom = top + rowH;
    const view = el.clientHeight;
    if (mode === "center") {
      el.scrollTop = Math.max(0, top - (view - rowH) / 2);
    } else if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (bottom > el.scrollTop + view) {
      el.scrollTop = bottom - view;
    }
  }, []);
  /** Nudge the window so `index` is inside it (Home/End, big selection jumps). */
  const ensureWindowCovers = useCallback((index: number) => {
    const w = winRef.current;
    if (index >= w.start && index < w.end) return;
    const start = Math.max(0, index - WINDOW_MARGIN);
    setWin({ start, end: start + WINDOW_MARGIN * 2 + 40 });
  }, []);
  // Switching 导图/完整 changes the row height, so offsets computed for the old
  // height are wrong: re-derive the window and keep the current position visible.
  useEffect(() => {
    recomputeWindow();
    const idx = filteredRef.current.findIndex((f) => f.node.entry.id === displayLeafIdRef.current);
    if (idx >= 0) revealRow(idx, "nearest");
  }, [view, recomputeWindow, revealRow]);

  useEffect(() => {
    recomputeWindow();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [recomputeWindow, onScroll]);
  // Clamp the window when the list size changes (filter switch, tree update).
  useEffect(() => {
    setWin((w) => ({
      start: Math.min(w.start, Math.max(0, filtered.length - 1)),
      end: Math.max(w.end, Math.min(w.start + 80, filtered.length)),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length]);

  const navigate = (choice: SummaryChoice) => {
    if (!selected) return;
    if (choice === "custom") {
      setNavPhase("custom-instructions");
      return;
    }
    doNavigate(choice === "auto" ? "summarize" : undefined, undefined);
  };

  /** Roll the edited file back to the state right after the selected node. */
  const rollbackToNode = async () => {
    const nodeId = selected?.entry.type === "message" ? (selected.entry.message as { toolCallId?: string }).toolCallId : undefined;
    const rawPath = selectedEditPath;
    if (!nodeId || !rawPath) return;
    setRollingBack(true);
    try {
      const cwd = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.cwd ?? "";
      const norm = (p: string) => p.replace(/\\/g, "/");
      const normCwd = norm(cwd).replace(/\/$/, "");
      // args.path may be absolute (pi passes the full path): relativize it.
      const path = norm(rawPath).startsWith(normCwd + "/")
        ? norm(rawPath).slice(normCwd.length + 1)
        : rawPath;
      const isTarget = (p: string) => {
        const np = norm(p);
        return np === path || np === normCwd + "/" + path;
      };
      // Collect file events in session order, cut at this node's tool call.
      const st = useChatStore.getState().states[tabId];
      const events: Array<Record<string, unknown>> = [];
      let cutAt = -1;
      for (const msg of st?.messages ?? []) {
        for (const b of msg.blocks) {
          if (b.kind !== "tool") continue;
          let args: { path?: string; filePath?: string; edits?: Array<{ oldText: string; newText: string }>; content?: string } = {};
          try {
            const raw = JSON.parse(b.argsText || "{}") as typeof args;
            // Normalize untrusted model args: a failed edit call keeps malformed
            // entries in the session, and main's history walk must only see
            // usable oldText/newText pairs.
            const parsed = parseEditArgs(raw);
            args = { ...raw, path: parsed.path, edits: parsed.edits };
          } catch {
            continue;
          }
          const eventPath = args.path ?? args.filePath;
          if (!eventPath || !isTarget(eventPath)) continue;
          if (b.name === "edit" && Array.isArray(args.edits) && args.edits.length) {
            events.push({ type: "edit", edits: args.edits });
          } else if ((b.name === "apply_patch" || b.name === "patch") && b.resultText) {
            events.push({ type: "patch", patch: b.resultText });
          } else if ((b.name === "write_file" || b.name === "write") && typeof args.content === "string") {
            events.push({ type: "write", content: args.content });
          } else {
            continue;
          }
          if (b.toolCallId === nodeId) cutAt = events.length - 1;
        }
      }
      if (cutAt < 0) {
        useUiStore.getState().showToast("未找到该节点的文件事件", "err");
        return;
      }
      const r = await window.api.diff.history(tabId, path, events.slice(0, cutAt + 1));
      const target = r.versions[r.versions.length - 1];
      if (!target || (r.versions.length <= 1 && target.content === "")) {
        useUiStore.getState().showToast("无法重建该节点的文件状态", "err");
        return;
      }
      const w = await window.api.diff.write(tabId, path, target.content);
      if (w.ok) {
        useUiStore.getState().showToast(`已回退 ${path} 到「${target.label}」`, "ok");
        // Reload the tree so leaf diff markers stay consistent.
        void window.api.tab.rpcSend(tabId, { type: "get_entries" });
      } else {
        useUiStore.getState().showToast(`回退失败: ${w.error ?? ""}`, "err");
      }
    } catch (e) {
      useUiStore.getState().showToast(`回退失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setRollingBack(false);
    }
  };

  const doNavigate = (summarize?: string, instructions?: string) => {
    if (!selected || navigatingId) return;
    const targetId = selected.entry.id;
    // Already there? pi would no-op, and the leaf would never "change" — which
    // used to leave the dialog waiting out its 60s timer and then reporting
    // 导航超时. Finish immediately instead.
    if (isAlreadyAtTarget(lastSnapshotRef.current?.entries ?? [], targetId, leafId)) {
      useUiStore.getState().showToast("已在当前位置", "ok");
      onNavigated?.(undefined);
      onClose();
      return;
    }
    navStartLeafRef.current = leafId;
    setNavPhase("navigating");
    setNavigatingId(targetId);
    // SDK tabs navigate via the native `navigate_tree` RPC: a direct session
    // operation, so NOTHING is sent through the prompt channel — no command
    // text, no user message, no agent turn; the chat just lands at the
    // target and waits for input. RPC-backed tabs (remote/WSL, upstream pi
    // has no native command) fall back to the pipi-tree-nav extension bridge.
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    // RPC-backed tabs navigate through the pipi-tree-nav extension command. If
    // that extension is not loaded on this target, sending the prompt would be
    // taken as an ordinary user message: the agent replies, the tree moves to an
    // unrelated place and a bogus message lands in the transcript. So refuse
    // when we already KNOW it is missing (probed on mount, cached per tab).
    if (tab?.mode !== "sdk" && treeNavAvailableRef.current === false) {
      setNavPhase("idle");
      setNavigatingId(null);
      useUiStore
        .getState()
        .showToast("该会话未加载 pipi-tree-nav 扩展，无法跳转（可切到终端视图用 /tree）", "err", {
          failure: true,
          cause: "get_commands 未返回 pipi-tree-nav：扩展未同步到该主机（远程/WSL）或 pi 版本不支持扩展命令",
        });
      return;
    }
    const started = Date.now();
    const requestId = `tree-nav-${started}`;
    pendingNavRequestId.current = requestId;
    const cmd: Record<string, unknown> =
      tab?.mode === "sdk"
        ? {
            type: "navigate_tree",
            id: requestId,
            entryId: targetId,
            summarize: summarize ? true : undefined,
            customInstructions: instructions,
          }
        : {
            type: "prompt",
            message: `/pipi-tree-nav ${targetId}${summarize ? " --summarize" : ""}${instructions ? ` --instructions ${instructions}` : ""}`,
          };
    void window.api.tab.rpcSend(tabId, cmd);
    // Poll get_tree until the leaf moves (or timeout) — navigateTree executes
    // synchronously inside pi, so this resolves quickly. Same single-flight
    // slot as the refresh poll: navigation can take up to 180s (a summarize
    // model call), and 1s polling without the guard queued ~180 requests on
    // pi's serial command loop.
    // Poll with the cursor: the navigation only needs the new `leafId`, and a
    // 2778-entry payload every second is what made this feel frozen (3.0-3.4s per
    // round trip in the user's log, 8 polls over 56s). The cursor is re-read on every tick
    // so a refresh poll that already appended entries is not re-fetched.
    const timer = setInterval(() => {
      if (tryAcquireEntriesSlot()) {
        const sinceNow = entriesCursorRef.current;
        entriesRequestKindRef.current.set(requestId, sinceNow ? "append" : "replace");
        void window.api.tab
          .rpcSend(tabId, sinceNow ? { type: "get_entries", since: sinceNow, id: requestId } : { type: "get_entries", id: requestId })
          .then((ok) => {
            // Tab gone → no response will ever arrive; free the slot so the
            // poll keeps trying instead of waiting out the stall window.
            if (!ok) releaseEntriesSlot();
          })
          .catch(() => releaseEntriesSlot());
      }
      // The timeout is a backstop for a worker that never answers. A human
      // answering an extension prompt during navigation (e.g. pi-rewind's
      // "Restore Options") can legitimately extend the wait, so give plain
      // navigation a generous 60s (summarize runs a model call: 180s).
      if (Date.now() - started > (summarize ? 180_000 : 60_000)) {
        clearInterval(timer);
        pendingNavTimer.current = null;
        pendingNavRequestId.current = null;
        setNavPhase("idle");
        setNavigatingId(null);
        useUiStore.getState().showToast("导航超时", "err");
      }
    }, 1000);
    // The onRpcEvent handler below detects the leaf change and clears the timer.
    pendingNavTimer.current = timer;
  };

  /**
   * Give up waiting (the navigation itself keeps its pi-side effect — we only
   * stop polling). Without this, a slow/unanswered navigation held the dialog
   * hostage for its whole 60s backstop.
   */
  const stopWaitingForNav = () => {
    if (pendingNavTimer.current) {
      clearInterval(pendingNavTimer.current);
      pendingNavTimer.current = null;
    }
    pendingNavRequestId.current = null;
    setNavPhase("idle");
    setNavigatingId(null);
    useUiStore.getState().showToast("已停止等待；分支切换可能仍在 pi 中执行，可稍后用会话树确认", "ok");
  };

  const pendingNavTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingNavRequestId = useRef<string | null>(null);
  /** The leaf when the current navigation started (the settle rule needs it). */
  const navStartLeafRef = useRef<string | null>(null);
  /** Does the RPC bridge command exist? null = not probed yet. */
  const treeNavAvailableRef = useRef<boolean | null>(null);
  /** On open, centre the CURRENT conversation once — "where am I?" answered. */
  const didFocusCurrentRef = useRef(false);
  const focusCurrent = () => {
    if (!displayLeafId) return;
    const idx = filtered.findIndex((f) => f.node.entry.id === displayLeafId);
    if (idx < 0) return;
    ensureWindowCovers(idx);
    revealRow(idx, "center");
  };
  /**
   * Single-flight gate for `get_entries` (both the 3s refresh poll and the
   * 1s navigation poll). The RPC link can be FAR slower than the poll
   * interval — measured 15–18s per response on a high-latency remote — and
   * `pi --mode rpc` answers commands serially behind a stdout backpressure
   * gate. Polling without this gate stacks hundreds of requests (observed:
   * 12949 sends / 12932 responses for one dialog) and starves every other
   * command (prompt/get_state/get_messages), which is what made the app look
   * hung. See tree-poll-guard.ts for the policy + tests.
   */
  const entriesSlotRef = useRef(createEntriesSlot(ENTRIES_STALL_MS));
  /** Drop a stale in-flight claim before polling; false = a request is out. */
  const tryAcquireEntriesSlot = (): boolean => entriesSlotRef.current.acquire();
  const releaseEntriesSlot = (): void => entriesSlotRef.current.release();
  const prevLeafRef = useRef<string | null>(null);

  // Fresh view of the navigation completion. The onRpcEvent handler is
  // registered once (deps [tabId]), so it must not capture stale props or
  // state — this ref is reassigned on every render with the latest values.
  const completionRef = useRef<() => void>(() => {});
  completionRef.current = () => {
    if (pendingNavTimer.current) {
      clearInterval(pendingNavTimer.current);
      pendingNavTimer.current = null;
    }
    pendingNavRequestId.current = null;
    setNavPhase("idle");
    setNavigatingId(null);
    useUiStore.getState().showToast("已导航到目标位置", "ok");
    const editorText = isUserMsg && selectedText ? selectedText : undefined;
    onNavigated?.(editorText);
    onClose();
  };

  // Always stop polling when the dialog closes or the tab changes.
  useEffect(() => () => {
    if (pendingNavTimer.current) {
      clearInterval(pendingNavTimer.current);
      pendingNavTimer.current = null;
      pendingNavRequestId.current = null;
    }
  }, [tabId]);

  // Detect navigation completion. The honest question is not "did the leaf
  // change" but "is the session now at/under the node I asked for" (see
  // isNavigationSettled — a no-op jump is handled in doNavigate, and a summarize
  // appends a NEW entry below the target, which still counts as landing).
  useEffect(() => {
    if (!navigatingId) {
      prevLeafRef.current = leafId;
      return;
    }
    const entries = lastSnapshotRef.current?.entries ?? [];
    const settled = isNavigationSettled(entries, { targetId: navigatingId, startLeafId: navStartLeafRef.current, leafId });
    prevLeafRef.current = leafId;
    if (!settled) return;
    if (pendingNavTimer.current) {
      clearInterval(pendingNavTimer.current);
      pendingNavTimer.current = null;
    }
    pendingNavRequestId.current = null;
    const editorText = isUserMsg && selectedText ? selectedText : undefined;
    setNavPhase("idle");
    setNavigatingId(null);
    useUiStore.getState().showToast("已导航到目标位置", "ok");
    onNavigated?.(editorText);
    onClose();
  }, [leafId, navigatingId, selected, selectedText, isUserMsg, onNavigated, onClose]);

  // Probe the RPC bridge command in the background: by the time the user presses
  // Enter it is usually known, and a missing extension is reported instead of
  // silently turning the jump into a user message.
  useEffect(() => {
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    if (tab?.mode === "sdk") {
      treeNavAvailableRef.current = true;
      return;
    }
    let cancelled = false;
    void fetchCommands(tabId)
      .then((r) => {
        if (cancelled) return;
        treeNavAvailableRef.current = r.commands.some((c) => c.name === "pipi-tree-nav");
      })
      .catch(() => {
        /* unknown — keep sending the prompt (previous behavior) */
      });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  // Initial selection: current leaf.
  useEffect(() => {
    if (!selectedId && flat.length > 0) {
      setSelectedId(leafId && flat.some((f) => f.node.entry.id === leafId) ? leafId : flat[flat.length - 1]!.node.entry.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat]);

  // Selection fallback: if the selected row is filtered/folded out, move to
  // the nearest still-visible ancestor (mirrors the TUI's findNearestVisible).
  useEffect(() => {
    if (!selectedId || filtered.some((f) => f.node.entry.id === selectedId)) return;
    const parentById = new Map<string, string | null>();
    for (const f of flat) parentById.set(f.node.entry.id, f.node.entry.parentId);
    let cur: string | null = parentById.get(selectedId) ?? null;
    while (cur && !filtered.some((f) => f.node.entry.id === cur)) cur = parentById.get(cur) ?? null;
    setSelectedId(cur ?? filtered[filtered.length - 1]?.node.entry.id ?? null);
  }, [filtered, flat, selectedId]);

  // Keyboard: ↑/↓ move, Home/End jump, Enter navigates, Shift+Enter offers the
  // summary choice, Ctrl+F focuses search, Esc backs out / closes. The input
  // keeps all printing keys; nav keys are handled here so arrows work from
  // the search box too (like the TUI). isComposing guards keep an active
  // Chinese IME candidate window from moving the selection or closing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (navPhase !== "idle" || e.isComposing) return;
      const isSearchFocused = document.activeElement === searchRef.current;
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length === 0) return;
        const idx = filtered.findIndex((f) => f.node.entry.id === selectedId);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = idx < 0 ? (delta > 0 ? 0 : filtered.length - 1) : Math.min(filtered.length - 1, Math.max(0, idx + delta));
        setSelectedId(filtered[next]!.node.entry.id);
      } else if (e.key === "Home" || e.key === "End") {
        if (isSearchFocused && !e.ctrlKey && !e.metaKey) return; // text caret
        if (filtered.length === 0) return;
        e.preventDefault();
        setSelectedId((e.key === "Home" ? filtered[0] : filtered[filtered.length - 1])!.node.entry.id);
      } else if (e.key === "Enter") {
        // Enter in the search box commits the search (re-focuses the list),
        // it does not navigate — navigate from the list with Enter/双击.
        if (isSearchFocused) {
          e.preventDefault();
          searchRef.current?.blur();
          return;
        }
        if (!selectedId) return;
        const target = filtered.find((f) => f.node.entry.id === selectedId);
        if (!target) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (target.node.entry.id !== leafId) setNavPhase("choose-summary");
        } else {
          if (target.node.entry.id !== leafId) setNavPhase("choose-summary");
          else useUiStore.getState().showToast("已是当前分支的最新位置", "ok");
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [filtered, selectedId, navPhase, leafId, onClose]);

  // Windowed rendering: keep the selected row in view. Jumps beyond the window
  // (Home/End, the initial pre-selection on a long session) first move the
  // window; the scroll position itself is index math, so the row does not have
  // to be mounted for this to land correctly.
  useEffect(() => {
    if (!selectedId || filtered.length === 0) return;
    const idx = filtered.findIndex((f) => f.node.entry.id === selectedId);
    if (idx < 0) return;
    ensureWindowCovers(idx);
    revealRow(idx, "nearest");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (query) searchRef.current?.focus();
  }, [query]);

  // "I cannot find where the current conversation is": on open, put it in the
  // middle of the viewport once (the tree can be hundreds of rows long).
  useEffect(() => {
    if (didFocusCurrentRef.current || treeStatus !== "ready" || !leafId || filtered.length === 0) return;
    didFocusCurrentRef.current = true;
    focusCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, leafId, treeStatus]);

  const selectedIsCurrent = selectedId === leafId;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog tree-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">会话树（/tree）</div>
        <div className="dialog-body">
          {error && tree.length > 0 && <div className="tree-error">{error}</div>}
          <input
            ref={searchRef}
            className="dialog-input tree-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索消息…（多关键词用空格分隔）"
            title="↑↓ 选择 · Enter 导航 · Shift+Enter 导航并摘要 · Ctrl+F 搜索 · Esc 关闭"
          />
          <div className="tree-filters" role="group" aria-label="显示筛选">
            <button
              className={`tree-chip${view === "mindmap" ? " active" : ""}`}
              aria-pressed={view === "mindmap"}
              title="只显示你的消息和 AI 的回复（思维导图）"
              onClick={() => setView("mindmap")}
            >
              导图
            </button>
            <button
              className={`tree-chip${view === "full" ? " active" : ""}`}
              aria-pressed={view === "full"}
              title="显示会话里的全部条目（含工具调用、压缩、标签等）"
              onClick={() => setView("full")}
            >
              完整
            </button>
            {view === "full" && (Object.keys(FILTER_LABELS) as TreeFilterMode[]).map((m) => (
              <button
                key={m}
                className={`tree-chip${filterMode === m ? " active" : ""}`}
                aria-pressed={filterMode === m}
                onClick={() => setFilterMode(m)}
                title={m === "default" ? "隐藏 model/label 等簿记条目与纯工具调用行" : m === "user-only" ? "只看用户消息（快速定位分支点）" : m === "no-tools" ? "默认视图再去掉工具结果" : m === "labeled-only" ? "只看有标签的节点" : "显示全部条目"}
              >
                {FILTER_LABELS[m]}
              </button>
            ))}
            <button
              className="tree-chip tree-chip-action"
              onClick={() => {
                focusCurrent();
                if (displayLeafId) setSelectedId(displayLeafId);
              }}
              title="把当前对话所在的位置滚到视图中间"
            >
              定位到当前
            </button>
            {folded.size > 0 && (
              <button className="tree-chip tree-chip-action" onClick={() => setFolded(new Set())} title="展开所有折叠的分支">
                展开全部({folded.size})
              </button>
            )}
          </div>
          <div className="tree-scroll" ref={scrollRef}>
            {exited && filtered.length === 0 && (
              <div className="tree-empty">
                pi 进程已退出，无法读取会话树。常见原因：远程密码认证失败（应用内保存的密码可能已过期/变更）或连接断开。请在「远程服务器」设置里更新密码，或切到终端视图确认登录状态。
                <button
                  className="btn tree-retry"
                  onClick={() => {
                    setTreeStatus("loading");
                    setError(null);
                    setSlowTicks(0);
                    void window.api.tab.rpcSend(tabId, { type: "get_entries" });
                  }}
                >
                  重试
                </button>
              </div>
            )}
            {!exited && filtered.length === 0 && treeStatus === "loading" && (
              <div className="tree-empty">
                {slowTicks >= 10
                  ? `远程 pi 响应较慢（已等待 ${slowTicks * 3}s）${fileAttemptRef.current.error ? `· 会话文件读取失败（${fileAttemptRef.current.error}）` : ""}…可能原因：服务器繁忙 / 会话较大 / pi 启动中。再等一会会自动出现，或切到终端视图查看。`
                  : slowTicks >= 3
                    ? `正在从远程读取会话树…（已等待 ${slowTicks * 3}s，远程 pi 启动可能较慢）`
                    : "加载中…"}
              </div>
            )}
            {filtered.length === 0 && treeStatus === "error" && (
              <div className="tree-empty">
                加载失败：{error ?? "未知错误"}
                <button
                  className="btn tree-retry"
                  onClick={() => {
                    setTreeStatus("loading");
                    setError(null);
                    setSlowTicks(0);
                    void window.api.tab.rpcSend(tabId, { type: "get_entries" });
                  }}
                >
                  重试
                </button>
              </div>
            )}
            {filtered.length === 0 && treeStatus === "ready" && tree.length > 0 && mindMap !== null && (
              <div className="tree-empty">
                {query
                  ? "没有匹配的对话消息（试试清空搜索，或切到「完整」看全部条目）"
                  : "这个会话里没有可显示的对话消息（只有工具调用/簿记条目）。切到「完整」查看全部条目。"}
              </div>
            )}
            {filtered.length === 0 && treeStatus === "ready" && tree.length === 0 && (
              <div className="tree-empty">
                {hasMessages ? "会话树为空，正在自动刷新…" : "空会话：尚无消息。发送第一条消息后，这里会显示分支树。"}
              </div>
            )}
            {filtered.length === 0 && treeStatus === "ready" && tree.length > 0 && <div className="tree-empty">（无匹配）</div>}
            {(() => {
              // Windowed render: only rows near the viewport mount, so a
              // thousand-entry session costs the same as a 80-row one. The top
              // and bottom spacers keep the scrolled height CONSTANT, so moving
              // the window never changes the scrollbar range (a changing range
              // is what makes a virtualized list stutter while scrolling).
              const multipleRoots = tree.length > 1;
              const slice = filtered.slice(win.start, win.end);
              return (
                <>
                  {win.start > 0 && <div style={{ height: win.start * rowH }} aria-hidden="true" />}
                  {slice.map((f: TreeFlatRow) => {
                    const e = f.node.entry;
                    const cp = e.type === "message" && e.message?.role === "toolResult"
                      ? editPoints.get((e.message as { toolCallId?: string }).toolCallId ?? "")
                      : undefined;
                    return (
                      <TreeRow
                        key={e.id}
                        row={f}
                        toolCalls={toolCalls}
                        selectedId={selectedId}
                        folded={folded}
                        leafId={displayLeafId}
                        editPoint={cp}
                        multipleRoots={multipleRoots}
                        mind={mindMap !== null}
                        onSelect={selectRow}
                        onToggleFold={toggleFold}
                      />
                    );
                  })}
                  {win.end < filtered.length && <div style={{ height: (filtered.length - win.end) * rowH }} aria-hidden="true" />}
                </>
              );
            })()}
          </div>
          <div className="tree-status">
            ({filtered.findIndex((f) => f.node.entry.id === selectedId) + 1 || 0}/{filtered.length})
            {mindMap && ` · 导图（已隐藏 ${mindMap.hidden} 条工具/簿记条目）`}
            {query && " · 搜索中"}
            {!mindMap && filterMode !== "default" && ` · ${FILTER_LABELS[filterMode]}`}
            {folded.size > 0 && " · 有折叠"} · ↑↓ 选择 · Enter 导航 · Esc 关闭
          </div>
          {fileSnapshot && (
            <div className="tree-snapshot-note">树来自会话文件快照 · 正在同步实时状态（远程 pi 未就绪时先显示存档数据）</div>
          )}

          {selected && navPhase === "idle" && (
            <div className="tree-detail">
              <div className="tree-detail-text">{selectedText || selected.entry.type}</div>
              <div className="tree-detail-actions">
                <span className="tree-detail-hint">
                  {isLeaf ? "（当前分支的最新位置）" : isUserMsg ? "导航会回到该消息之前，并把消息填入输入框" : "导航会切换到该位置"}
                </span>
                {!isLeaf && (
                  <button className="btn btn-primary" onClick={() => setNavPhase("choose-summary")} disabled={!!navigatingId}>
                    导航到这里
                  </button>
                )}
                {selectedEditPath && (
                  <button className="btn" onClick={() => void rollbackToNode()} disabled={rollingBack || !!navigatingId} title={`把 ${selectedEditPath} 回退到此节点编辑后的状态`}>
                    {rollingBack ? "回退中…" : "回退文件到此状态"}
                  </button>
                )}
                {isUserMsg && !isLeaf && (
                  <button className="btn" onClick={async () => {
                    // fork: new branch session + replay (equivalent to /fork)
                    const ok = await window.api.tab.rpcSend(tabId, { type: "fork", entryId: selected.entry.id });
                    if (ok) {
                      useUiStore.getState().showToast("已创建新分支并重放该消息", "ok");
                      onClose();
                    }
                  }} disabled={!!navigatingId}>
                    从这里继续（新分支）
                  </button>
                )}
              </div>
            </div>
          )}

          {navPhase === "choose-summary" && selected && (
            <div className="tree-detail">
              <div className="tree-detail-text">导航到该位置前，是否生成分支摘要？</div>
              <div className="tree-summary-options">
                <button className="btn" onClick={() => navigate("none")} disabled={!!navigatingId}>不摘要</button>
                <button className="btn" onClick={() => navigate("auto")} disabled={!!navigatingId}>自动摘要</button>
                <button className="btn" onClick={() => navigate("custom")} disabled={!!navigatingId}>自定义提示词</button>
                <button className="btn" onClick={() => setNavPhase("idle")}>取消</button>
              </div>
            </div>
          )}

          {navPhase === "custom-instructions" && selected && (
            <div className="tree-detail">
              <div className="tree-detail-text">自定义摘要提示词：</div>
              <textarea
                className="dialog-input ui-editor tree-instr"
                value={customInstr}
                onChange={(e) => setCustomInstr(e.target.value)}
                rows={3}
                placeholder="例如：用中文总结这个分支做了什么…"
              />
              <div className="tree-summary-options">
                <button className="btn btn-primary" onClick={() => doNavigate("summarize", customInstr.trim() || undefined)} disabled={!!navigatingId}>
                  导航并摘要
                </button>
                <button className="btn" onClick={() => setNavPhase("idle")}>取消</button>
              </div>
            </div>
          )}

          {navPhase === "navigating" && (
            <div className="tree-detail">
              <span className="tree-detail-hint">
                已请求 pi 切换到目标位置，正在等待它确认（远程会话每次往返约 3s，通常 1-2 次内完成）。
                等待期间可以继续浏览、搜索或直接关闭窗口 —— 切换本身已经在 pi 里执行了。
              </span>
              <div className="tree-detail-actions">
                <span />
                <button className="btn" onClick={stopWaitingForNav}>不再等待</button>
              </div>
            </div>
          )}
        </div>
        <div className="ui-dialog-actions">
          {onOpenTerminal && (
            <span className="tree-native-hint">标签编辑等完整分支能力在终端视图的原生 /tree 中</span>
          )}
          <button
            className="btn"
            onClick={() => {
              onClose();
              onOpenTerminal?.();
            }}
            disabled={!!navigatingId}
          >
            终端视图 /tree
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
