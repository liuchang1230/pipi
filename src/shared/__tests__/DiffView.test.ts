import { describe, expect, it } from "vitest";
import { editsToDiff, isDiffish } from "../../renderer/src/components/diff-utils";

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
});
