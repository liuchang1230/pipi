/**
 * Shared unified-diff renderer: line-level coloring (+ green / − red /
 * context dim / headers accent) with character-level inline highlighting
 * between adjacent −/+ line pairs. Used by tool cards and the changes panel.
 */
import { useMemo } from "react";
import { isDiffish, editsToDiff } from "./diff-utils";

export { isDiffish, editsToDiff };

const MAX_RENDERED_DIFF_LINES = 1_500;

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
    if (
      raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") ||
      raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity") ||
      raw.startsWith("rename ") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("Binary files")
    ) {
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

export function DiffView({ diffText }: { diffText: string }) {
  const parsedLines = useMemo(() => parseDiff(diffText), [diffText]);
  // Tool output can contain enormous patches. A bounded preview keeps opening
  // a tool card instant; the full patch remains available in the terminal.
  const truncated = parsedLines.length > MAX_RENDERED_DIFF_LINES;
  const lines = truncated ? parsedLines.slice(0, MAX_RENDERED_DIFF_LINES) : parsedLines;
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
  return (
    <div className="diff-view">
      {rows}
      {truncated && <div className="diff-truncated">为保持页面流畅，仅显示前 {MAX_RENDERED_DIFF_LINES.toLocaleString()} / {parsedLines.length.toLocaleString()} 行变更</div>}
    </div>
  );
}
