/**
 * 文件变更弹层：git 工作区 diff（本地/WSL/远程同一套 IPC）。
 * 非 git 仓库自动降级——从当前会话事件流的 apply_patch/edit 工具结果
 * 聚合 diff 文本，按文件分组展示。
 */
import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "../stores/chatStore";

interface DiffFileEntry {
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

/** Fallback for non-git cwd: aggregate apply_patch/edit diffs from the session. */
function aggregateToolDiffs(tabId: string): { files: DiffFileEntry[]; diffs: Map<string, string> } {
  const state = useChatStore.getState().states[tabId];
  const byPath = new Map<string, string[]>();
  for (const msg of state?.messages ?? []) {
    for (const b of msg.blocks) {
      if (b.kind === "tool" && b.resultText?.startsWith("diff --git")) {
        const p = diffPath(b.resultText);
        if (p) {
          const arr = byPath.get(p) ?? [];
          arr.push(b.resultText);
          byPath.set(p, arr);
        }
      }
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

interface DiffLine {
  type: "header" | "hunk" | "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Parse unified diff text into rows with per-line numbers. */
function parseDiff(diffText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") ||
        raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") ||
        raw.startsWith("rename ") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("Binary files")) {
      lines.push({ type: "header", text: raw });
    } else if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? parseInt(m[1]!, 10) : 0;
      newNo = m ? parseInt(m[2]!, 10) : 0;
      lines.push({ type: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ type: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else {
      lines.push({ type: "ctx", text: raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return lines;
}

/** Character-level inline highlight between adjacent -/+ line pairs. */
function inlineMarks(a: string, b: string): { a: [number, number]; b: [number, number] } {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return {
    a: [pre, a.length - suf],
    b: [pre, b.length - suf],
  };
}

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.type === "header") {
    return <div className="diff-row diff-header">{line.text}</div>;
  }
  if (line.type === "hunk") {
    return <div className="diff-row diff-hunk">{line.text}</div>;
  }
  const num = line.type === "del" ? line.oldNo : line.newNo;
  return (
    <div className={`diff-row diff-${line.type}`}>
      <span className="diff-num">{num ?? ""}</span>
      <span className="diff-sig">{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
      <code className="diff-code">{line.text || " "}</code>
    </div>
  );
}

function DiffView({ diffText }: { diffText: string }) {
  const lines = useMemo(() => parseDiff(diffText), [diffText]);
  // Pair adjacent -/+ rows for inline highlighting.
  const rows = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.type === "add" || line.type === "del") {
        // Find a partner of the opposite sign in the following rows.
        let partner: DiffLine | null = null;
        let j = i + 1;
        while (j < lines.length && (lines[j]!.type === "add" || lines[j]!.type === "del")) {
          if (lines[j]!.type !== line.type) {
            partner = lines[j]!;
            break;
          }
          j++;
        }
        if (partner && partner.type === "add" && line.type === "del") {
          const marks = inlineMarks(line.text, partner.text);
          out.push(
            <div key={`r${i}`} className="diff-row diff-del">
              <span className="diff-num">{line.oldNo ?? ""}</span>
              <span className="diff-sig">−</span>
              <code className="diff-code">
                {line.text.slice(0, marks.a[0])}
                <mark>{line.text.slice(marks.a[0], marks.a[1])}</mark>
                {line.text.slice(marks.a[1])}
              </code>
            </div>
          );
          out.push(
            <div key={`r${j}`} className="diff-row diff-add">
              <span className="diff-num">{partner.newNo ?? ""}</span>
              <span className="diff-sig">+</span>
              <code className="diff-code">
                {partner.text.slice(0, marks.b[0])}
                <mark>{partner.text.slice(marks.b[0], marks.b[1])}</mark>
                {partner.text.slice(marks.b[1])}
              </code>
            </div>
          );
          i = j;
          continue;
        }
      }
      out.push(<DiffLineRow key={`r${i}`} line={line} />);
    }
    return out;
  }, [lines]);
  return <div className="diff-view">{rows}</div>;
}

interface DiffDialogProps {
  tabId: string;
  onClose: () => void;
}

export function DiffDialog({ tabId, onClose }: DiffDialogProps) {
  const [list, setList] = useState<{ isGit: boolean; files: DiffFileEntry[]; error?: string } | null>(null);
  const [fallback, setFallback] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.api.diff.list(tabId);
      if (!r.isGit) {
        const agg = aggregateToolDiffs(tabId);
        setList({ isGit: false, files: agg.files });
        setFallback(agg.diffs);
      } else {
        setList(r);
        setFallback(new Map());
      }
      // Keep selection if still present.
      const keep = selected && (list?.isGit ? list.files.some((f) => f.path === selected) : fallback.has(selected));
      if (!keep) {
        setSelected(null);
        setDiffText(null);
      } else if (list?.isGit) {
        void openFile(selected);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const openFile = async (path: string) => {
    setSelected(path);
    setDiffText(null);
    setError(null);
    if (list && !list.isGit) {
      setDiffText(fallback.get(path) ?? null);
      return;
    }
    const r = await window.api.diff.get(tabId, path);
    if (r.error) {
      setError(r.error);
      setDiffText("");
    } else {
      setDiffText(r.diff || "（无变更内容）");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const files = list?.files ?? [];
  const totalAdd = files.reduce((s, f) => s + Math.max(f.additions, 0), 0);
  const totalDel = files.reduce((s, f) => s + Math.max(f.deletions, 0), 0);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog ui-dialog diff-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="diff-dialog-header">
          <span className="diff-dialog-title">
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
            <button className="diff-close" onClick={onClose}>×</button>
          </div>
        </div>
        {error && <div className="diff-error">{error}</div>}
        <div className="diff-body">
          <div className="diff-filelist">
            {files.length === 0 && !loading && (
              <div className="diff-empty">工作区没有变更</div>
            )}
            {files.map((f) => (
              <div
                key={f.path}
                className={`diff-file ${selected === f.path ? "active" : ""}`}
                onClick={() => void openFile(f.path)}
                title={f.path}
              >
                <span className={`diff-status st-${f.status}`}>{STATUS_LABEL[f.status] ?? f.status}</span>
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
            {diffText === null && selected === null && (
              <div className="diff-placeholder">← 选择一个文件查看 diff</div>
            )}
            {diffText !== null && (diffText.startsWith("diff --git") ? <DiffView diffText={diffText} /> : <div className="diff-empty">{diffText}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
