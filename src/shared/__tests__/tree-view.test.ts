// tree-view — pure display-layer helpers for the session tree dialog:
// visibility rules (mirroring pi TUI's applyFilter), search text extraction
// and compact timestamps. No React / Electron runtime.
import { describe, expect, it } from "vitest";
import { applyVisibility, formatEntryTime, searchableText } from "../tree-view";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";
import type { TreeNode } from "../tree-build";

function entries(...objs: Array<Record<string, unknown>>): TreeEntry[] {
  return objs.map((o) => ({ type: "message", parentId: null, ...o }) as unknown as TreeEntry);
}

/** Build flat rows the way TreeDialog does: tree → flatten (single chain). */
function flatFrom(entriesList: TreeEntry[]): Array<{ node: TreeNode }> {
  const { tree } = buildTreeFromEntries(entriesList);
  const out: Array<{ node: TreeNode }> = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push({ node: n });
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

const user = (id: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  parentId: null,
  message: { role: "user", content: text },
  ...extra,
});

describe("applyVisibility", () => {
  it("default mode hides bookkeeping entries but keeps messages", () => {
    const flat = flatFrom(
      entries(
        user("u1", "hello"),
        { id: "m1", type: "model_change", modelId: "gpt" },
        { id: "l1", type: "label", label: "x" },
        { id: "s1", type: "session_info", name: "t" },
        user("u2", "world"),
      ),
    );
    const out = applyVisibility(flat, "default", "", null);
    expect(out.map((f) => f.node.entry.id)).toEqual(["u1", "u2"]);
  });

  it("user-only mode keeps only user messages", () => {
    const flat = flatFrom(
      entries(
        user("u1", "q"),
        { id: "a1", message: { role: "assistant", content: "answer" } },
        { id: "b1", message: { role: "bashExecution" }, command: "ls" },
      ),
    );
    const out = applyVisibility(flat, "user-only", "", null);
    expect(out.map((f) => f.node.entry.id)).toEqual(["u1"]);
  });

  it("no-tools mode drops toolResult rows and bookkeeping", () => {
    const flat = flatFrom(
      entries(
        user("u1", "q"),
        { id: "t1", message: { role: "toolResult" } },
        { id: "a1", message: { role: "assistant", content: "done" } },
        { id: "c1", type: "compaction", tokensBefore: 9000 },
      ),
    );
    const out = applyVisibility(flat, "no-tools", "", null);
    expect(out.map((f) => f.node.entry.id)).toEqual(["u1", "a1", "c1"]);
  });

  it("labeled-only mode keeps only labeled nodes", () => {
    const flat = flatFrom(
      entries(
        user("u1", "q"),
        user("u2", "marked"),
        { id: "lab", type: "label", targetId: "u2", label: "checkpoint" },
      ),
    );
    const out = applyVisibility(flat, "labeled-only", "", null);
    expect(out.map((f) => f.node.entry.id)).toEqual(["u2"]);
  });

  it("hides tool-call-only assistant rows unless current/error/aborted", () => {
    const flat = flatFrom(
      entries(
        { id: "silent", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "read" }] } },
        { id: "err", message: { role: "assistant", content: [], errorMessage: "boom" } },
        { id: "aborted", message: { role: "assistant", content: [], stopReason: "aborted" } },
        { id: "leaf", message: { role: "assistant", content: [{ type: "toolCall", id: "y", name: "read" }] } },
      ),
    );
    const out = applyVisibility(flat, "default", "", "leaf");
    expect(out.map((f) => f.node.entry.id)).toEqual(["err", "aborted", "leaf"]);
  });

  it("multi-token search is an AND across role/content/keywords", () => {
    const flat = flatFrom(
      entries(
        user("u1", "fix the login bug"),
        user("u2", "add dark theme"),
        { id: "c1", type: "compaction", tokensBefore: 1000 },
      ),
    );
    expect(applyVisibility(flat, "default", "login", null).map((f) => f.node.entry.id)).toEqual(["u1"]);
    expect(applyVisibility(flat, "default", "user fix", null).map((f) => f.node.entry.id)).toEqual(["u1"]);
    // "compaction" keyword surfaces bookkeeping rows via search
    expect(applyVisibility(flat, "default", "compaction", null).map((f) => f.node.entry.id)).toEqual(["c1"]);
    expect(applyVisibility(flat, "default", "login theme", null)).toEqual([]);
  });
});

describe("searchableText", () => {
  it("includes role, label, title and custom types", () => {
    const { tree } = buildTreeFromEntries(
      entries(
        user("u1", "body text"),
        { id: "s1", type: "session_info", name: "Refactor auth" },
      ),
    );
    const [n1, n2] = tree;
    expect(searchableText(n1!)).toContain("user");
    expect(searchableText(n1!)).toContain("body text");
    expect(searchableText(n2!)).toContain("title");
    expect(searchableText(n2!)).toContain("Refactor auth");
  });
});

describe("formatEntryTime", () => {
  it("returns empty for missing/invalid timestamps", () => {
    expect(formatEntryTime(undefined)).toBe("");
    expect(formatEntryTime("not-a-date")).toBe("");
  });

  it("formats today as HH:MM and other years as yy/M/D HH:MM", () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5);
    expect(formatEntryTime(today.toISOString())).toBe(`09:05`);
    const old = new Date(2019, 0, 3, 8, 1);
    expect(formatEntryTime(old.toISOString())).toBe(`19/1/3 08:01`);
    void pad;
  });
});
