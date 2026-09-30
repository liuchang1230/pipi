// tree-view — pure display-layer helpers for the session tree dialog:
// visibility rules (mirroring pi TUI's applyFilter), search text extraction
// and compact timestamps. No React / Electron runtime.
import { describe, expect, it } from "vitest";
import { activeFolds, applyVisibility, foldedAwayIds, formatEntryTime, searchableText } from "../tree-view";
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

/** One conversation turn: user / assistant text / tool-call-only reply / toolResult,
 *  i.e. three VISIBLE rows deep (the tool-call-only reply is dropped by the default
 *  filter) — the shape that used to break the fold walk. */
const turn = (n: number) => [
  user(`u${n}`, `问题 ${n}`, { id: `u${n}`, parentId: n === 0 ? null : `c${n - 1}` }),
  { id: `a${n}`, parentId: `u${n}`, message: { role: "assistant", content: `回答 ${n}` } },
  { id: `k${n}`, parentId: `a${n}`, message: { role: "assistant", content: [{ type: "toolCall", id: `t${n}`, name: "read", arguments: {} }] } },
  { id: `c${n}`, parentId: `k${n}`, message: { role: "toolResult", content: "ok" } },
];

describe("foldedAwayIds", () => {
  it("collapses descendants even when their direct parent is filtered away", () => {
    // `k0` (tool-call-only assistant) is dropped by the default filter, so `c0`'s
    // parent is NOT in the rendered list. A pass that only looks at the direct
    // parent leaves `c0` and every later turn on screen — the bug.
    const flat = flatFrom(entries(...turn(0), ...turn(1), ...turn(2)));
    const visible = applyVisibility(flat, "default", "", null);
    expect(visible.map((f) => f.node.entry.id)).toEqual(["u0", "a0", "c0", "u1", "a1", "c1", "u2", "a2", "c2"]);
    // The FULL list is what gets folded (see the contract in foldedAwayIds).
    const hidden = foldedAwayIds(flat, new Set(["u0"]));
    expect(visible.filter((f) => !hidden.has(f.node.entry.id)).map((f) => f.node.entry.id)).toEqual(["u0"]);
  });

  it("keeps the folded row itself and its ancestors", () => {
    const flat = flatFrom(entries(...turn(0), ...turn(1)));
    const hidden = foldedAwayIds(flat, new Set(["a0"]));
    expect(hidden.has("a0")).toBe(false);
    expect(hidden.has("c0")).toBe(true);
    expect(hidden.has("u1")).toBe(true);
    expect(hidden.has("u0")).toBe(false);
  });

  it("is order-independent", () => {
    const flat = flatFrom(entries(...turn(0), ...turn(1)));
    const shuffled = [...flat].reverse();
    const hidden = foldedAwayIds(shuffled, new Set(["u0"]));
    // The verdict covers every row of the input (the dialog then filters its own
    // already-filtered list by this set).
    expect([...hidden].sort()).toEqual(["a0", "a1", "c0", "c1", "k0", "k1", "u1"]);
  });

  it("nests folds and stops at the first unfolded ancestor", () => {
    const flat = flatFrom(entries(...turn(0), ...turn(1), ...turn(2)));
    const hidden = foldedAwayIds(flat, new Set(["u0", "a1"]));
    expect(hidden.has("c1")).toBe(true);
    expect(hidden.has("u2")).toBe(true);
    expect(hidden.has("a0")).toBe(true); // only reachable through folded u0
    expect(hidden.has("u0")).toBe(false);
  });

  it("returns an empty set when nothing is folded", () => {
    const flat = flatFrom(entries(...turn(0)));
    expect(foldedAwayIds(flat, new Set()).size).toBe(0);
  });

  it("terminates on a parentId ring and never hides the folded row itself", () => {
    // A ring cannot occur in a pi session (buildTreeFromEntries promotes ring
    // members to roots) — this only pins the two properties that keep the dialog
    // alive: no infinite walk, and the folded row stays on screen so it can be
    // unfolded again. Other ring members have no consistent verdict.
    const rows = [
      { node: { entry: { id: "x", type: "message", parentId: "y" } } },
      { node: { entry: { id: "y", type: "message", parentId: "x" } } },
    ];
    const hidden = foldedAwayIds(rows as never, new Set(["x"]));
    expect(hidden.has("x")).toBe(false);
  });

  it("under-hides when handed a list with the parent filtered away (why the contract says FULL list)", () => {
    // Guard for the exact regression: the call site used to pass the FILTERED list.
    // This pins the wake-up call — the deeper rows survive because the chain has a
    // hole (c0's parent k0 is dropped by the default filter), which is the reported
    // 「只折叠下面一条」. If this ever fails because the helper got smarter, the call
    // site may no longer need `flat` — until then, passing `visible` is the bug.
    const flat = flatFrom(entries(...turn(0), ...turn(1)));
    const visible = applyVisibility(flat, "default", "", null);
    const hidden = foldedAwayIds(visible, new Set(["u0"]));
    expect(hidden.has("c0")).toBe(false);
    expect(hidden.has("u1")).toBe(false);
  });
});

describe("activeFolds", () => {
  it("keeps only folds whose own row is rendered", () => {
    const flat = flatFrom(entries(...turn(0), ...turn(1)));
    const visible = applyVisibility(flat, "user-only", "", null);
    expect(visible.map((f) => f.node.entry.id)).toEqual(["u0", "u1"]);
    expect([...activeFolds(visible, new Set(["u0", "a0"]))]).toEqual(["u0"]);
  });

  it("switching the filter therefore stops a hidden fold from hiding rows", () => {
    // Fold the reply, then switch to 用户: the reply row is gone, so the prompt below
    // it must come back — otherwise the list could read 「（无匹配）」 while it matched.
    const flat = flatFrom(entries(...turn(0), ...turn(1)));
    const standard = applyVisibility(flat, "default", "", null);
    const usersOnly = applyVisibility(flat, "user-only", "", null);
    expect(foldedAwayIds(flat, activeFolds(standard, new Set(["a0"]))).has("u1")).toBe(true);
    expect(foldedAwayIds(flat, activeFolds(usersOnly, new Set(["a0"]))).has("u1")).toBe(false);
  });

  it("returns the very same set when nothing is folded (no allocation per render)", () => {
    const folded = new Set<string>();
    expect(activeFolds([], folded)).toBe(folded);
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
