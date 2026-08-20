/**
 * Session tree dialog — aligned with pi's TUI /tree (TreeSelectorComponent):
 *  - connector gutter (└/├/─), fold markers, active-path dots, branch labels
 *  - per-type entry labels (user:/assistant:/[tool]/[model]/[compaction]/…)
 *  - active-branch-first ordering, single-child chains rendered flat
 *  - current leaf pre-selected, search filter, fold/unfold
 *  - navigate to a point (SDK tabs: native `navigate_tree` RPC — a silent
 *    session operation, nothing enters the prompt channel; RPC-backed
 *    remote/WSL tabs: pipi-tree-nav extension command bridge, since
 *    upstream pi has no native command), with the same "Summarize branch?"
 *    choice as /tree; fork kept as the "start new branch" action
 *    (equivalent to /fork).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../stores/uiStore";
import { useTabsStore } from "../stores/tabsStore";
import { useChatStore } from "../stores/chatStore";

interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
  modelId?: string;
  thinkingLevel?: string;
  summary?: string;
  name?: string;
  customType?: string;
  content?: unknown;
  tokensBefore?: number;
  toolName?: string;
  toolCallId?: string;
  command?: string;
  label?: string;
}

interface TreeNode {
  entry: TreeEntry;
  children: TreeNode[];
  label?: string;
  labelTimestamp?: string;
}

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

interface FlatNode {
  node: TreeNode;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  isVirtualRootChild: boolean;
}

function flattenTree(roots: TreeNode[], leafId: string | null): { flat: FlatNode[]; containsActive: Map<string, boolean> } {
  const containsActive = new Map<string, boolean>();
  // Post-order: does a subtree contain the active leaf?
  {
    const all: TreeNode[] = [];
    const stack = [...roots];
    while (stack.length) {
      const n = stack.pop()!;
      all.push(n);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i]!;
      let has = leafId !== null && n.entry.id === leafId;
      for (const c of n.children) if (containsActive.get(c.entry.id)) has = true;
      containsActive.set(n.entry.id, has);
    }
  }
  const flat: FlatNode[] = [];
  const multipleRoots = roots.length > 1;
  const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)));
  const stack: Array<[TreeNode, number, boolean, boolean, boolean, boolean]> = [];
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    stack.push([orderedRoots[i]!, multipleRoots ? 1 : 0, multipleRoots, multipleRoots, i === orderedRoots.length - 1, multipleRoots]);
  }
  while (stack.length) {
    const [node, indent, justBranched, showConnector, isLast, isVirtualRootChild] = stack.pop()!;
    flat.push({ node, indent, showConnector, isLast, isVirtualRootChild });
    const children = node.children;
    const multipleChildren = children.length > 1;
    const orderedChildren = [...children].sort((a, b) => Number(containsActive.get(b.entry.id)) - Number(containsActive.get(a.entry.id)));
    let childIndent: number;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;
    for (let i = orderedChildren.length - 1; i >= 0; i--) {
      stack.push([orderedChildren[i]!, childIndent, multipleChildren, multipleChildren, i === orderedChildren.length - 1, false]);
    }
  }
  return { flat, containsActive };
}

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

function entryDisplay(node: TreeNode, toolCalls: Map<string, { name: string; args: unknown }>): { label: string; cls: string; text: string } {
  const e = node.entry;
  switch (e.type) {
    case "message": {
      const role = e.message?.role;
      const text = normalize(textOf(e.message?.content));
      if (role === "user") return { label: "user:", cls: "user", text };
      if (role === "assistant") {
        if (text) return { label: "assistant:", cls: "assistant", text };
        if (e.message?.stopReason === "aborted") return { label: "assistant:", cls: "assistant", text: "(aborted)" };
        if (e.message?.errorMessage) return { label: "assistant:", cls: "assistant error", text: normalize(e.message.errorMessage).slice(0, 80) };
        return { label: "assistant:", cls: "assistant", text: "(no content)" };
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

export function TreeDialog({
  tabId,
  onClose,
  onNavigated,
}: {
  tabId: string;
  onClose: () => void;
  /** Called after a successful navigation; editorText = the replayed/fill text. */
  onNavigated?: (editorText?: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [navPhase, setNavPhase] = useState<"idle" | "choose-summary" | "custom-instructions" | "navigating">("idle");
  const [customInstr, setCustomInstr] = useState("");
  const [navigatingId, setNavigatingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = () => void window.api.tab.rpcSend(tabId, { type: "get_tree" });

  useEffect(() => {
    refresh();
    const off = window.api.onRpcEvent(tabId, (event) => {
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
      if (event.type !== "response" || event.command !== "get_tree") return;
      // During navigation, ignore unrelated tree snapshots (initial refreshes
      // or another consumer's request). They must not be able to complete the
      // current navigation early.
      if (pendingNavRequestId.current && event.id !== pendingNavRequestId.current) return;
      const data = event.data as TreeResponse;
      if (event.success && data.tree) {
        setTree(data.tree);
        setLeafId(data.leafId ?? null);
        setError(null);
      } else {
        setError(String(event.error ?? "获取会话树失败"));
      }
    });
    return () => off();
  }, [tabId]);

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

  const { flat } = useMemo(() => flattenTree(tree, leafId), [tree, leafId]);

  const activePath = useMemo(() => {
    const set = new Set<string>();
    let cur: string | null = leafId;
    const byId = new Map<string, TreeEntry>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        byId.set(n.entry.id, n.entry);
        walk(n.children);
      }
    };
    walk(tree);
    while (cur) {
      set.add(cur);
      const e = byId.get(cur);
      cur = e?.parentId ?? null;
    }
    return set;
  }, [tree, leafId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter((f) => {
      const d = entryDisplay(f.node, toolCalls);
      return (d.label + " " + d.text).toLowerCase().includes(q);
    });
  }, [flat, query, toolCalls]);

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
  const isLeaf = selected?.entry.id === leafId;

  const toggleFold = (id: string) => {
    setFolded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
            args = JSON.parse(b.argsText || "{}");
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
        void window.api.tab.rpcSend(tabId, { type: "get_tree" });
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
    setNavPhase("navigating");
    setNavigatingId(targetId);
    // SDK tabs navigate via the native `navigate_tree` RPC: a direct session
    // operation, so NOTHING is sent through the prompt channel — no command
    // text, no user message, no agent turn; the chat just lands at the
    // target and waits for input. RPC-backed tabs (remote/WSL, upstream pi
    // has no native command) fall back to the pipi-tree-nav extension bridge.
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
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
    // synchronously inside pi, so this resolves quickly.
    const timer = setInterval(() => {
      void window.api.tab.rpcSend(tabId, { type: "get_tree", id: requestId });
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

  const pendingNavTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingNavRequestId = useRef<string | null>(null);
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

  // Detect navigation completion via leafId change in the get_tree responses.
  useEffect(() => {
    if (prevLeafRef.current === null) {
      prevLeafRef.current = leafId;
      return;
    }
    if (leafId !== prevLeafRef.current && navigatingId) {
      prevLeafRef.current = leafId;
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
    } else {
      prevLeafRef.current = leafId;
    }
  }, [leafId, navigatingId, selected, selectedText, isUserMsg, onNavigated, onClose]);

  // Initial selection: current leaf.
  useEffect(() => {
    if (!selectedId && flat.length > 0) {
      setSelectedId(leafId && flat.some((f) => f.node.entry.id === leafId) ? leafId : flat[flat.length - 1]!.node.entry.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat]);

  useEffect(() => {
    if (query) searchRef.current?.focus();
  }, [query]);

  const selectedIsCurrent = selectedId === leafId;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog tree-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">会话树（/tree）</div>
        <div className="dialog-body">
          {error && <div className="tree-error">{error}</div>}
          <input
            ref={searchRef}
            className="dialog-input tree-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索消息…"
          />
          <div className="tree-scroll">
            {filtered.length === 0 && <div className="tree-empty">（无匹配）</div>}
            {filtered.map((f) => {
              const e = f.node.entry;
              const d = entryDisplay(f.node, toolCalls);
              const isOnActive = activePath.has(e.id);
              const isSelected = e.id === selectedId;
              const isCurrent = e.id === leafId;
              const hasChildren = f.node.children.length > 0;
              const isFolded = folded.has(e.id);
              // Build the connector gutter (mirrors TreeSelector's prefix logic)
              let prefix = "";
              const displayIndent = f.indent;
              // connectors at each ancestor level
              const connectorLevel = Math.max(0, displayIndent - 1);
              const showOwnConnector = f.showConnector && !f.isVirtualRootChild;
              // simple: draw vertical/elbow connectors based on isLast
              if (showOwnConnector) {
                const depth = displayIndent;
                // we approximate: root-level rows get no gutter; deeper rows get
                // "│  " for non-last ancestors and "└─ " for the last row
                if (depth === 0) {
                  prefix = "";
                } else {
                  const isLast = f.isLast;
                  prefix = (isLast ? "└" : "├") + "─ ";
                  // for depth > 1 add vertical continuation of ancestors
                  void connectorLevel;
                }
              } else {
                prefix = "  ".repeat(Math.max(0, displayIndent - 1));
              }
              const foldMarker = hasChildren ? (isFolded ? "⊞ " : "⊟ ") : "";
              const pathMarker = isOnActive ? "• " : "";
              const labelPart = f.node.label ? `[${f.node.label}] ` : "";
              // rollback checkpoint badge on file-edit tool nodes
              const cp = e.type === "message" && e.message?.role === "toolResult"
                ? editPoints.get((e.message as { toolCallId?: string }).toolCallId ?? "")
                : undefined;
              return (
                <div
                  key={e.id}
                  className={`tree-row${isSelected ? " selected" : ""}${isCurrent ? " current" : ""}`}
                  onClick={() => {
                    if (hasChildren) {
                      // single click selects; double-click toggles fold
                    }
                    setSelectedId(e.id);
                    setNavPhase("idle");
                  }}
                  onDoubleClick={() => hasChildren && toggleFold(e.id)}
                  title={d.text || e.id}
                >
                  <span className="tree-gutter">{prefix}</span>
                  <span className="tree-fold" onClick={(ev) => { ev.stopPropagation(); hasChildren && toggleFold(e.id); }}>
                    {foldMarker}
                  </span>
                  <span className="tree-pathmark">{pathMarker}</span>
                  <span className={`tree-entrylabel ${d.cls}`}>{d.label}</span>
                  <span className={`tree-entrytext ${d.cls}`}>{d.text}</span>
                  {labelPart && <span className="tree-branch-tag">{labelPart}</span>}
                  {cp && <span className="tree-cp-tag" title={`回退点：此节点后文件已变更（${cp.path ?? "未知路径"}），可回退到此状态`}>⤺ 回退点</span>}
                  {isCurrent && <span className="tree-leaf-tag">当前</span>}
                </div>
              );
            })}
          </div>
          <div className="tree-status">
            ({filtered.findIndex((f) => f.node.entry.id === selectedId) + 1 || 0}/{filtered.length})
            {query && " · 过滤中"} {folded.size > 0 && " · 有折叠"} · 单击选中 · 双击折叠/展开
          </div>

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

          {navPhase === "navigating" && <div className="tree-detail">正在导航（{navigatingId === selected?.entry.id ? "等待 pi 切换分支…" : ""}）</div>}
        </div>
        <div className="ui-dialog-actions">
          <button className="btn" onClick={onClose} disabled={!!navigatingId}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
