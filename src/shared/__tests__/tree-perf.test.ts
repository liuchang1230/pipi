import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";
import { flattenTree } from "../tree-layout";
import { applyVisibility } from "../tree-view";

/**
 * Performance guard for the branch-tree pipeline (pure data part).
 *
 * Reported symptom: "打开分支有点卡顿" on long sessions. Two ways that can
 * happen and neither is visible by reading a few lines:
 *  - an O(n²) step sneaks into the layout (e.g. walking the ancestor chain of
 *    every row instead of precomputing membership once) — 3000 entries then
 *    costs millions of operations;
 *  - the filter step copies the whole flat list per row.
 *
 * The budget is deliberately generous (a desktop frame is 16ms; these numbers
 * are ~10-40x smaller) so the test flags an algorithmic regression rather than
 * normal machine noise. The DOM half of the story (windowed rendering, memoized
 * rows) is verified in the app itself — see scripts/robustness-smoke.mjs.
 */
function syntheticSession(count: number, branchEvery = 25): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < count; i++) {
    const id = `e${i}`;
    // Every `branchEvery` entries, branch off an older node so the tree has
    // real forks (a pure chain would not exercise child sorting/indent logic).
    if (i > 0 && i % branchEvery === 0) parentId = `e${Math.max(0, i - branchEvery - 1)}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      message: {
        role: i % 4 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `row ${i} `.repeat(12) }],
      },
    });
    parentId = id;
  }
  return entries;
}

describe("branch tree layout cost (3000-entry session)", () => {
  it("builds, flattens and filters well under a frame budget", () => {
    const entries = syntheticSession(3000);
    const leafId = entries[entries.length - 1]!.id;

    const t0 = performance.now();
    const { tree } = buildTreeFromEntries(entries);
    const t1 = performance.now();
    const { flat } = flattenTree(tree, leafId);
    const t2 = performance.now();
    const visible = applyVisibility(flat, "default", "", leafId);
    const t3 = performance.now();
    expect(visible.length).toBe(3000);

    // (measured above the assertions so the failure message carries real numbers)
    const layout = t2 - t1;
    const filter = t3 - t2;
    const build = t1 - t0;
    // Printed so a regression shows its actual cost in CI output, not just "fail".
    console.log(`[tree-perf] build=${build.toFixed(1)}ms layout=${layout.toFixed(1)}ms filter=${filter.toFixed(1)}ms`);
    // Reference numbers on this machine: build 150ms before the cycle-check fix,
    // 4ms after; layout 3ms; filter 2ms. Budgets sit between the two so the
    // regression that caused the reported lag cannot come back unnoticed.
    expect(build).toBeLessThan(30);
    expect(layout).toBeLessThan(30);
    expect(filter).toBeLessThan(20);
    expect(build + layout + filter).toBeLessThan(60);
  });

  it("keeps the active-path flags correct on a large tree (no per-row ancestor walk)", () => {
    const entries = syntheticSession(1200);
    const leafId = entries[entries.length - 1]!.id;
    const { tree } = buildTreeFromEntries(entries);
    const { flat } = flattenTree(tree, leafId);
    // Exactly one row is the current leaf, and the active path is its ancestor
    // chain: the layout must precompute membership, which is also what keeps the
    // cost linear.
    expect(flat.filter((f) => f.isCurrent)).toHaveLength(1);
    const onPath = flat.filter((f) => f.onActivePath).length;
    expect(onPath).toBeGreaterThan(1);
    expect(onPath).toBeLessThanOrEqual(entries.length);
  });
});
