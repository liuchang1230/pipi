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
 *
 * Self-healing fetch: the tree is re-asked every 3s while the dialog is
 * open (paused during navigation), so a remote/WSL pi still booting, a
 * dropped first request, or a worker hiccup fills in instead of leaving a
 * stale empty tree; explicit failures show an error + retry, and a truly
 * blank session gets its own empty-state copy instead of a misleading
 * "（无匹配）".
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

/** Turn raw get_tree failures into user-facing copy. */
function friendlyTreeError(raw: string): string {
  if (/unknown command/i.test(raw)) {
    return "pi 版本过低：会话树需要 get_tree 命令（pi ≥ 0.80.3）";
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
      void window.api.tab.rpcSend(tabId, { type: "get_tree" })
        .then((ok) => {
          if (!ok && !pendingNavRequestId.current) {
            setTreeStatus("error");
            setError("会话不可用（标签页未就绪或已退出）");
          }
        })
        .catch(() => {
          // IPC rejected (e.g. window torn down mid-invoke): stay on the
          // current state; the interval keeps retrying and heals on success.
        });
    };
    sendRefresh();
    const tryFileSnapshot = () => {
      void window.api.tree.fromFile(tabId)
        .then((res) => {
          fileAttemptRef.current = { error: res.ok ? "" : String(res.error ?? ""), at: Date.now() };
          // Skip when live data already arrived, OR while a navigation is in
          // flight — the snapshot's stale leaf must not trip the navigation
          // completion detector (which fires on leafId change + navigatingId).
          if (res.ok && !rpcTreeArrivedRef.current && !pendingNavRequestId.current && Array.isArray(res.tree)) {
            setTree(res.tree as TreeNode[]);
            setLeafId(res.leafId ?? null);
            setError(null);
            setTreeStatus("ready");
            setSlowTicks(0);
            setFileSnapshot(true);
          }
        })
        .catch(() => {
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
      if (event.type !== "response" || event.command !== "get_tree") return;
      lastResponseAtRef.current = Date.now();
      // During navigation, ignore unrelated tree snapshots (initial refreshes
      // or another consumer's request). They must not be able to complete the
      // current navigation early.
      if (pendingNavRequestId.current && event.id !== pendingNavRequestId.current) return;
      const data = event.data as TreeResponse;
      if (event.success && data.tree) {
        rpcTreeArrivedRef.current = true;
        setFileSnapshot(false);
        setTree(data.tree);
        setLeafId(data.leafId ?? null);
        setError(null);
        setTreeStatus("ready");
        setSlowTicks(0);
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
          {error && tree.length > 0 && <div className="tree-error">{error}</div>}
          <input
            ref={searchRef}
            className="dialog-input tree-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索消息…"
          />
          <div className="tree-scroll">
            {exited && filtered.length === 0 && (
              <div className="tree-empty">
                pi 进程已退出，无法读取会话树。常见原因：远程密码认证失败（应用内保存的密码可能已过期/变更）或连接断开。请在「远程服务器」设置里更新密码，或切到终端视图确认登录状态。
                <button
                  className="btn tree-retry"
                  onClick={() => {
                    setTreeStatus("loading");
                    setError(null);
                    setSlowTicks(0);
                    void window.api.tab.rpcSend(tabId, { type: "get_tree" });
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
                    void window.api.tab.rpcSend(tabId, { type: "get_tree" });
                  }}
                >
                  重试
                </button>
              </div>
            )}
            {filtered.length === 0 && treeStatus === "ready" && tree.length === 0 && (
              <div className="tree-empty">
                {hasMessages ? "会话树为空，正在自动刷新…" : "空会话：尚无消息。发送第一条消息后，这里会显示分支树。"}
              </div>
            )}
            {filtered.length === 0 && treeStatus === "ready" && tree.length > 0 && <div className="tree-empty">（无匹配）</div>}
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

          {navPhase === "navigating" && <div className="tree-detail">正在导航（{navigatingId === selected?.entry.id ? "等待 pi 切换分支…" : ""}）</div>}
        </div>
        <div className="ui-dialog-actions">
          {onOpenTerminal && (
            <span className="tree-native-hint">完整分支能力（标签/折叠/搜索/快捷键）在终端视图的原生 /tree 中</span>
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
          <button className="btn" onClick={onClose} disabled={!!navigatingId}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
