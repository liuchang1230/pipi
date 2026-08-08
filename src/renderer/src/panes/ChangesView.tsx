/**
 * 右侧「变更」面板：git 工作区 diff + 会话工具聚合 + 版本对比。
 * 选中文件后显示版本链（HEAD → 每次编辑后 → 当前），任选两个版本对比；
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
  M: "修改", A: "新增", D: "删除", R: "重命名", C: "复制", U: "未跟踪",
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
      // prefer a real diff; else synthesize one from edit args
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
  /** File to focus when present (e.g. the file open in the viewer). */
  focusPath?: string | null;
  onFocusPathHandled?: () => void;
}

export function ChangesView({ tabId, focusPath, onFocusPathHandled }: ChangesViewProps) {
  const [list, setList] = useState<{ isGit: boolean; files: DiffFileEntry[]; error?: string } | null>(null);
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

  // Focus a file: select it and switch to version-compare when it has a history.
  const selectFile = async (path: string) => {
    setSelected(path);
    setGitDiff(null);
    setVersions(null);
    setCompareText(null);
    setError(null);
    if (list && !list.isGit) {
      setGitDiff(fallback.get(path) ?? "");
      return;
    }
    if (list && list.isGit && fallback.has(path)) {
      // Session-touched file not tracked by git (e.g. gitignored).
      setGitDiff(fallback.get(path) ?? "");
      return;
    }
    const r = await window.api.diff.get(tabId, path);
    if (r.error) {
      setError(r.error);
      setGitDiff("");
    } else {
      setGitDiff(r.diff || "（无变更内容）");
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
      if (!r.isGit) {
        setList({ isGit: false, files: agg.files });
        setFallback(agg.diffs);
      } else {
        // git list + session-touched files (e.g. gitignored docs) merged;
        // session-only files fall back to aggregated diffs.
        const gitPaths = new Set(r.files.map((f) => f.path));
        const merged = [...r.files];
        const mergedDiffs = new Map<string, string>();
        for (const f of agg.files) {
          if (!gitPaths.has(f.path)) {
            merged.push({ ...f, status: "S" });
            const d = agg.diffs.get(f.path);
            if (d) mergedDiffs.set(f.path, d);
          }
        }
        setList({ isGit: true, files: merged });
        setFallback(mergedDiffs);
      }
      // Re-select the focused or previously selected file.
      const keep = (focusPath ?? selected) && list?.files.some((f) => f.path === (focusPath ?? selected));
      const target = keep ? (focusPath ?? selected)! : null;
      if (target && target !== selected) {
        await selectFile(target);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      onFocusPathHandled?.();
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Load version history for the selected file (from session edit events).
  const loadHistory = async (path: string) => {
    const st = useChatStore.getState().states[tabId];
    const events: Array<{ type: "edit"; edits: Array<{ oldText: string; newText: string }> }> = [];
    for (const msg of st?.messages ?? []) {
      for (const b of msg.blocks) {
        if (b.kind !== "tool" || (b.name !== "edit" && b.name !== "apply_patch")) continue;
        let edits: Array<{ oldText: string; newText: string }> = [];
        try {
          const args = JSON.parse(b.argsText || "{}") as {
            path?: string;
            edits?: Array<{ oldText: string; newText: string }>;
          };
          const p = normalizePath(args.path ?? "", cwdRef.current);
          if (p !== path) continue;
          edits = Array.isArray(args.edits) ? args.edits : [];
        } catch {
          continue;
        }
        if (!edits.length) continue;
        events.push({ type: "edit", edits });
      }
    }
    if (!events.length) {
      setVersions(null);
      setVerA(null);
      setVerB(null);
      setCompareText(null);
      return;
    }
    const r = await window.api.diff.history(tabId, path, events);
    if (r.error) {
      setError(r.error);
      return;
    }
    setVersions(r.versions);
    setVerA(0);
    setVerB(r.versions.length - 1);
    setCompareText(null);
  };

  const handleSelect = async (path: string) => {
    setSelected(path);
    await selectFile(path);
    void loadHistory(path);
  };

  // Compare two versions.
  const doCompare = async (a: number, b: number) => {
    if (!versions || a === b) return;
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

  const files = list?.files ?? [];
  const totalAdd = files.reduce((s, f) => s + Math.max(f.additions, 0), 0);
  const totalDel = files.reduce((s, f) => s + Math.max(f.deletions, 0), 0);
  const showCompare = compareText !== null && verA !== null && verB !== null;
  const isCompareText = useMemo(() => showCompare && isDiffish(compareText ?? ""), [showCompare, compareText]);

  return (
    <div className="changes-panel">
      <div className="changes-header">
        <span className="changes-title">
          文件变更
          {files.length > 0 && (
            <span className="diff-dialog-count">
              {files.length} 个文件
              {(totalAdd > 0 || totalDel > 0) && (
                <span className="diff-total">
                  <span className="add">+{totalAdd}</span>
                  <span className="del">−{totalDel}</span>
                </span>
              )}
            </span>
          )}
        </span>
        <div className="diff-dialog-actions">
          {!list?.isGit && files.length > 0 && <span className="diff-fallback-tag">会话工具聚合（非 git）</span>}
          <button className="chat-btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </div>
      {error && <div className="diff-error">{error}</div>}
      <div className="changes-body">
        <div className="diff-filelist">
          {files.length === 0 && !loading && <div className="diff-empty">工作区没有变更</div>}
          {files.map((f) => (
            <div
              key={f.path}
              className={`diff-file ${selected === f.path ? "active" : ""}`}
              onClick={() => void handleSelect(f.path)}
              title={f.path}
            >
              <span className={`diff-status st-${f.status}`}>
                {STATUS_LABEL[f.status] ?? (f.status === "S" ? "会话" : f.status)}
              </span>
              <span className="diff-filepath">{f.path}</span>
              {f.additions !== 0 || f.deletions !== 0 ? (
                <span className="diff-filecount">
                  <span className="add">+{f.additions}</span>
                  <span className="del">−{f.deletions}</span>
                </span>
              ) : f.status === "U" ? (
                <span className="diff-filecount new">新文件</span>
              ) : null}
            </div>
          ))}
        </div>
        <div className="diff-content">
          {!selected && <div className="diff-placeholder">← 选择一个文件查看 diff</div>}
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
          {selected && gitDiff !== null && !showCompare && (
            isDiffish(gitDiff) ? <DiffView diffText={gitDiff} /> : <div className="diff-empty">{gitDiff || "（无变更内容）"}</div>
          )}
          {selected && showCompare && isCompareText && <DiffView diffText={compareText ?? ""} />}
          {selected && showCompare && !isCompareText && (
            <div className="diff-empty">{compareText || "（无差异）"}</div>
          )}
          {selected && versions && versions.length <= 1 && (
            <div className="diff-empty">该文件在会话中没有可对比的编辑记录</div>
          )}
        </div>
      </div>
    </div>
  );
}
