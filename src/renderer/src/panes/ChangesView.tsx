/**
 * 右侧「变更」面板：默认聚焦当前查看器打开的文件，展示它的完整变更记录
 * 与版本对比（HEAD → 每次编辑后 → 当前）。顶部下拉可切换其他变更文件；
 * 非 git 场景自动降级为会话工具聚合。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../stores/chatStore";
import { useTabsStore } from "../stores/tabsStore";
import { DiffView, editsToDiff, isDiffish } from "../components/DiffView";

export interface DiffFileEntry {
  status: string;
  path: string;
  additions: number;
  deletions: number;
}

const STATUS_LABEL: Record<string, string> = {
  M: "修改", A: "新增", D: "删除", R: "重命名", C: "复制", U: "未跟踪", S: "会话",
};

/** Extract the file path from a unified diff text (diff --git a/… b/…). */
function diffPath(text: string): string | null {
  const m = text.match(/^diff --git a\/(.+?) b\//m);
  if (m) return m[1]!;
  const m2 = text.match(/^\+\+\+ b\/(.+)$/m);
  return m2?.[1] ?? null;
}

function normalizePath(p: string, cwd: string): string {
  const normCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const normP = p.replace(/\\/g, "/");
  if (normP.startsWith(normCwd + "/")) return normP.slice(normCwd.length + 1);
  return p;
}

/** Aggregate apply_patch/edit diffs from the session (non-git fallback). */
function aggregateToolDiffs(tabId: string, cwd: string): { files: DiffFileEntry[]; diffs: Map<string, string> } {
  const state = useChatStore.getState().states[tabId];
  const byPath = new Map<string, string[]>();
  for (const msg of state?.messages ?? []) {
    for (const b of msg.blocks) {
      if (b.kind !== "tool" || !b.resultText) continue;
      const argsPath = (() => {
        try {
          const args = JSON.parse(b.argsText || "{}") as { path?: string };
          return typeof args.path === "string" ? args.path : undefined;
        } catch {
          return undefined;
        }
      })();
      const p = normalizePath(diffPath(b.resultText) ?? argsPath ?? "", cwd);
      if (!p) continue;
      const arr = byPath.get(p) ?? [];
      const diffText = isDiffish(b.resultText)
        ? b.resultText
        : (() => {
            try {
              const args = JSON.parse(b.argsText || "{}") as { edits?: Array<{ oldText: string; newText: string }> };
              return editsToDiff(p, Array.isArray(args.edits) ? args.edits : []);
            } catch {
              return "";
            }
          })();
      if (diffText) arr.push(diffText);
      byPath.set(p, arr);
    }
  }
  const files: DiffFileEntry[] = [...byPath.entries()].map(([path]) => ({
    status: "M",
    path,
    additions: 0,
    deletions: 0,
  }));
  const diffs = new Map([...byPath.entries()].map(([p, arr]) => [p, arr.join("\n")]));
  return { files, diffs };
}

interface ChangesViewProps {
  tabId: string;
  /** File to focus (the file open in the viewer, if any). */
  focusPath?: string | null;
  onFocusPathHandled?: () => void;
}

export function ChangesView({ tabId, focusPath, onFocusPathHandled }: ChangesViewProps) {
  const [files, setFiles] = useState<DiffFileEntry[]>([]);
  const [isGit, setIsGit] = useState(true);
  const [fallback, setFallback] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<string | null>(null);
  const [versions, setVersions] = useState<Array<{ label: string; content: string }> | null>(null);
  const [verA, setVerA] = useState<number | null>(null);
  const [verB, setVerB] = useState<number | null>(null);
  const [compareText, setCompareText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cwdRef = useRef("");
  const focusHandled = useRef(false);

  /** Show one file: working-tree diff + version history. */
  const selectFile = async (path: string) => {
    setSelected(path);
    setGitDiff(null);
    setVersions(null);
    setCompareText(null);
    setVerA(null);
    setVerB(null);
    setError(null);
    // Working-tree diff (or aggregated session diff for gitignored/non-git).
    if (!isGit || fallback.has(path)) {
      setGitDiff(fallback.get(path) ?? "");
    } else {
      const r = await window.api.diff.get(tabId, path);
      if (r.error) {
        setError(r.error);
        setGitDiff("");
      } else {
        setGitDiff(r.diff || "（无变更内容）");
      }
    }
    // Version history from session edit events.
    const st = useChatStore.getState().states[tabId];
    const events: Array<{ type: "edit"; edits: Array<{ oldText: string; newText: string }> }> = [];
    for (const msg of st?.messages ?? []) {
      for (const b of msg.blocks) {
        if (b.kind !== "tool" || b.name !== "edit") continue;
        try {
          const args = JSON.parse(b.argsText || "{}") as {
            path?: string;
            edits?: Array<{ oldText: string; newText: string }>;
          };
          if (normalizePath(args.path ?? "", cwdRef.current) !== path) continue;
          const edits = Array.isArray(args.edits) ? args.edits : [];
          if (edits.length) events.push({ type: "edit", edits });
        } catch {
          /* partial args */
        }
      }
    }
    if (events.length) {
      const r = await window.api.diff.history(tabId, path, events);
      if (r.error) {
        setError(r.error);
        return;
      }
      setVersions(r.versions);
      setVerA(0);
      setVerB(r.versions.length - 1);
    }
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const cwd = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.cwd ?? "";
      cwdRef.current = cwd;
      const agg = aggregateToolDiffs(tabId, cwd);
      const r = await window.api.diff.list(tabId);
      let merged: DiffFileEntry[];
      let mergedDiffs: Map<string, string>;
      if (!r.isGit) {
        setIsGit(false);
        merged = agg.files;
        mergedDiffs = agg.diffs;
      } else {
        setIsGit(true);
        const gitPaths = new Set(r.files.map((f) => f.path));
        merged = [...r.files];
        mergedDiffs = new Map();
        for (const f of agg.files) {
          if (!gitPaths.has(f.path)) {
            merged.push({ ...f, status: "S" });
            const d = agg.diffs.get(f.path);
            if (d) mergedDiffs.set(f.path, d);
          }
        }
      }
      setFiles(merged);
      setFallback(mergedDiffs);
      // Focus: requested file (viewer), else keep current, else first.
      const target =
        (focusPath && merged.some((f) => f.path === normalizePath(focusPath, cwd)))
          ? normalizePath(focusPath, cwd)
          : (selected && merged.some((f) => f.path === selected) ? selected : merged[0]?.path ?? null);
      if (target && target !== selected) {
        await selectFile(target);
      } else if (!selected && target) {
        await selectFile(target);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      if (!focusHandled.current) {
        focusHandled.current = true;
        onFocusPathHandled?.();
      }
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, focusPath]);

  const doCompare = async (a: number, b: number) => {
    if (!versions || a === b || a == null || b == null) return;
    const contentA = versions[a]?.content ?? "";
    const contentB = versions[b]?.content ?? "";
    const path = selected ?? "file";
    if (!contentA && !contentB) {
      setCompareText("");
      return;
    }
    if (contentA === contentB) {
      setCompareText("（两个版本内容相同）");
      return;
    }
    const r = await window.api.diff.compare(contentA, contentB, path);
    setCompareText(r.diff || "（无差异）");
  };

  useEffect(() => {
    if (verA === null || verB === null) return;
    void doCompare(verA, verB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verA, verB, versions]);

  const totalAdd = files.reduce((s, f) => s + Math.max(f.additions, 0), 0);
  const totalDel = files.reduce((s, f) => s + Math.max(f.deletions, 0), 0);
  const showCompare = compareText !== null && verA !== null && verB !== null;
  const isCompareText = useMemo(() => showCompare && isDiffish(compareText ?? ""), [showCompare, compareText]);

  return (
    <div className="changes-panel">
      <div className="changes-header">
        <select
          className="changes-file-select"
          value={selected ?? ""}
          onChange={(e) => void selectFile(e.target.value)}
          title="变更文件（默认当前查看器打开的文件）"
        >
          {files.length === 0 && <option value="">（没有变更文件）</option>}
          {files.map((f) => (
            <option key={f.path} value={f.path}>
              [{STATUS_LABEL[f.status] ?? f.status}] {f.path}
            </option>
          ))}
        </select>
        <div className="diff-dialog-actions">
          {files.length > 0 && (
            <span className="diff-total">
              <span className="add">+{totalAdd}</span>
              <span className="del">−{totalDel}</span>
            </span>
          )}
          {!isGit && files.length > 0 && <span className="diff-fallback-tag">非 git</span>}
          <button className="chat-btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </div>
      {error && <div className="diff-error">{error}</div>}
      {selected && versions && versions.length > 1 && (
        <div className="changes-compare">
          <span className="changes-compare-label">版本对比</span>
          <select value={verA ?? 0} onChange={(e) => setVerA(Number(e.target.value))}>
            {versions.map((v, i) => (
              <option key={i} value={i}>{v.label}</option>
            ))}
          </select>
          <span className="changes-compare-vs">vs</span>
          <select value={verB ?? 0} onChange={(e) => setVerB(Number(e.target.value))}>
            {versions.map((v, i) => (
              <option key={i} value={i}>{v.label}</option>
            ))}
          </select>
          {versions[verA ?? 0]?.content === versions[verB ?? 0]?.content && (
            <span className="changes-compare-same">内容相同</span>
          )}
        </div>
      )}
      <div className="changes-body">
        {!selected && <div className="diff-empty">{loading ? "加载中…" : "（没有变更文件）"}</div>}
        {selected && !showCompare && gitDiff !== null && (
          isDiffish(gitDiff) ? <DiffView diffText={gitDiff} /> : <div className="diff-empty">{gitDiff || "（无变更内容）"}</div>
        )}
        {selected && showCompare && isCompareText && <DiffView diffText={compareText ?? ""} />}
        {selected && showCompare && !isCompareText && (
          <div className="diff-empty">{compareText || "（无差异）"}</div>
        )}
        {selected && versions && versions.length <= 1 && (
          <div className="diff-empty">该文件在会话中没有编辑记录；上方为工作区变更</div>
        )}
      </div>
    </div>
  );
}
