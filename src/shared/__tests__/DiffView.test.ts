import { describe, expect, it } from "vitest";
import { editsToDiff, isDiffish, normalizeEdits, parseEditArgs } from "../../renderer/src/components/diff-utils";

describe("isDiffish", () => {
  it("recognizes unified diff forms (incl. apply_patch patch arg)", () => {
    const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-a\n+x\n b\n";
    expect(isDiffish(patch)).toBe(true);
    expect(isDiffish("diff --git a/x b/x\nindex 1..2 100644")).toBe(true);
    expect(isDiffish("plain text result")).toBe(false);
    expect(isDiffish("{\"path\":\"a\"}")).toBe(false);
  });
});

describe("editsToDiff", () => {
  it("builds a unified diff from oldText/newText pairs", () => {
    const d = editsToDiff("f.md", [{ oldText: "旧内容", newText: "新内容" }]);
    expect(d).toContain("--- a/f.md");
    expect(d).toContain("-旧内容");
    expect(d).toContain("+新内容");
  });

  it("returns empty instead of throwing on malformed edits (white-screen regression)", () => {
    // Real session data: a failed edit call persisted verbatim in the .jsonl
    // (`edits.0.oldText: must have required properties oldText`).
    const failedCall = { edits: [{ newText: "五个场景的算法统一采用" }] };
    expect(editsToDiff(undefined, failedCall.edits)).toBe("");
    expect(() => editsToDiff("a.md", [null, 1, "x", {}, { oldText: "a" }, { newText: "b" }])).not.toThrow();
    expect(editsToDiff("a.md", [null, 1, "x", {}, { oldText: "a" }, { newText: "b" }])).toBe("");
  });

  it("keeps the usable pairs when only some entries are malformed", () => {
    const d = editsToDiff("a.ts", [{ oldText: "a", newText: "b" }, { newText: "oops" }]);
    expect(d).toContain("-a");
    expect(d).toContain("+b");
  });

  it("falls back to the placeholder path when path is missing", () => {
    expect(editsToDiff(undefined, [{ oldText: "a", newText: "b" }])).toContain("--- a/file");
    expect(editsToDiff("", [{ oldText: "a", newText: "b" }])).toContain("--- a/file");
  });

  it("drops empty-oldText pairs (pi never applies them)", () => {
    expect(editsToDiff("a.ts", [{ oldText: "", newText: "inserted" }])).toBe("");
    expect(normalizeEdits([{ oldText: "", newText: "x" }, { oldText: "a", newText: "b" }])).toEqual([
      { oldText: "a", newText: "b" },
    ]);
  });
});

describe("normalizeEdits / parseEditArgs", () => {
  it("accepts a single entry object and a JSON string of edits", () => {
    expect(normalizeEdits({ oldText: "a", newText: "b" })).toEqual([{ oldText: "a", newText: "b" }]);
    expect(normalizeEdits('[{"oldText":"a","newText":"b"}]')).toEqual([{ oldText: "a", newText: "b" }]);
    expect(normalizeEdits("{not json")).toEqual([]);
    expect(normalizeEdits(undefined)).toEqual([]);
  });

  it("parses path plus pairs, including pi's legacy single-edit shorthand", () => {
    expect(parseEditArgs({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })).toEqual({
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(parseEditArgs({ path: "a.ts", oldText: "a", newText: "b" })).toEqual({
      path: "a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(parseEditArgs({ edits: [{ path: "nested.ts", oldText: "a", newText: "b" }] }).path).toBe("nested.ts");
    expect(parseEditArgs(null)).toEqual({ path: undefined, edits: [] });
  });
});
