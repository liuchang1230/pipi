/**
 * session-page — the projection and the window cut behind the branch dialog's paging
 * (docs/adr/0011-session-entry-paging.md).
 *
 * The regression these pin: the dialog used to ship the whole session over IPC
 * (8.07 MB measured for a 2763-entry session; a long remote session 10-50x that) and
 * to render every row from full entries. What it actually needs is a preview per row,
 * the tool-call name + a few arguments, and the user's own prompt whole (it is handed
 * back to the editor when you navigate to it).
 */
import { describe, expect, it } from "vitest";
import { buildTreeFromEntries, type TreeEntry } from "../tree-build";
import { PAGE_BUDGET, pageFromWindow, projectEntry, type SessionPageBudget } from "../session-page";
import { searchableText } from "../tree-view";
import { indexToolCalls } from "../tree-index";

const line = (o: unknown) => JSON.stringify(o);
const buf = (o: unknown) => Buffer.from(line(o), "utf8");

/** A realistic assistant entry: prose + a tool call with a fat `command`. */
function assistantWithToolCall(id: string, parentId: string | null, textBody: string, args: Record<string, unknown>) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-07T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: textBody }, { type: "toolCall", id: `tc-${id}`, name: "bash", arguments: args }] },
  };
}

describe("projectEntry", () => {
  it("keeps the identity fields the tree is built from", () => {
    const e = projectEntry({ type: "message", id: "a", parentId: "p", timestamp: "t1", message: { role: "user", content: "hi" } })!;
    expect(e).toMatchObject({ type: "message", id: "a", parentId: "p", timestamp: "t1" });
  });

  it("keeps a user prompt WHOLE (it is handed back to the editor on navigate)", () => {
    const prompt = `长提示词\n${"x".repeat(5000)}`;
    const e = projectEntry({ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: prompt }] } })!;
    expect(e.message!.content).toBe(prompt);
  });

  it("caps assistant prose at one row's worth and keeps the tool call", () => {
    const e = projectEntry(assistantWithToolCall("a", null, "y".repeat(5000), { command: "npm test" }))!;
    const content = e.message!.content as Array<{ type: string; text?: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text!.length).toBe(200);
    expect(indexToolCalls(buildTreeFromEntries([e]).tree).get("tc-a")).toEqual({ name: "bash", args: { command: "npm test" } });
  });

  it("keeps a file path whole (rollback relativizes it) and caps other arguments", () => {
    const long = "/very/long/path/".repeat(40) + "file.ts";
    const e = projectEntry(assistantWithToolCall("a", null, "x", { path: long, edits: [{ oldText: "o".repeat(900), newText: "n" }] }))!;
    const args = indexToolCalls(buildTreeFromEntries([e]).tree).get("tc-a")!.args as Record<string, unknown>;
    expect(args.path).toBe(long);
    // The shape rollback/display needs is there; nothing else survived.
    expect(Object.keys(args)).toEqual(["path"]);
  });

  it("falls back to the first argument when no known key is present (row label still speaks)", () => {
    const e = projectEntry(assistantWithToolCall("a", null, "x", { notaKey: "some text", big: "z".repeat(900) }))!;
    const args = indexToolCalls(buildTreeFromEntries([e]).tree).get("tc-a")!.args as Record<string, unknown>;
    expect(args.notaKey).toBe("some text");
    // Parity with the unprojected path: TreeDialog.formatToolCall strings the first
    // argument and caps it, so a non-string value degrades the same way it always did.
    const withObject = projectEntry(assistantWithToolCall("b", null, "x", { weird: { nested: "z".repeat(900) } }))!;
    const other = indexToolCalls(buildTreeFromEntries([withObject]).tree).get("tc-b")!.args as Record<string, unknown>;
    expect(typeof other.weird).toBe("string");
    expect((other.weird as string).length).toBeLessThanOrEqual(200);
  });

  it("drops a tool result body to a preview (the row shows the CALL, not the body)", () => {
    const body = "z".repeat(100_000);
    const e = projectEntry({ type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "tc-a", toolName: "bash", content: [{ type: "text", text: body }] } })!;
    expect((e.message!.content as string).length).toBe(200);
    expect(e.message!.toolCallId).toBe("tc-a");
    expect(JSON.stringify(e).length).toBeLessThan(500);
  });

  it("keeps the fields the row renderer prints for every entry type", () => {
    expect(projectEntry({ type: "compaction", id: "c", parentId: null, tokensBefore: 12345, summary: "s".repeat(5000) })).toMatchObject({ tokensBefore: 12345 });
    expect(projectEntry({ type: "branch_summary", id: "b", parentId: null, summary: "s".repeat(5000), fromId: "x" })!.summary!.length).toBe(2000);
    expect(projectEntry({ type: "model_change", id: "m", parentId: null, modelId: "gpt-x" })).toMatchObject({ modelId: "gpt-x" });
    expect(projectEntry({ type: "thinking_level_change", id: "th", parentId: null, thinkingLevel: "high" })).toMatchObject({ thinkingLevel: "high" });
    expect(projectEntry({ type: "session_info", id: "si", parentId: null, name: "标题" })).toMatchObject({ name: "标题" });
    expect(projectEntry({ type: "custom_message", id: "cm", parentId: null, customType: "note", content: "hello" })).toMatchObject({ customType: "note", content: "hello" });
    // A bashExecution message row prints its command.
    expect(projectEntry({ type: "message", id: "be", parentId: null, command: "ls -la", message: { role: "bashExecution" } })).toMatchObject({ command: "ls -la" });
  });

  it("keeps label/targetId (buildTreeFromEntries resolves branch labels from them)", () => {
    const e = projectEntry({ type: "label", id: "l", parentId: null, targetId: "a", label: "分支名", timestamp: "t" })!;
    expect(e).toMatchObject({ targetId: "a", label: "分支名" });
    const { tree } = buildTreeFromEntries([{ type: "message", id: "a", parentId: null, message: { role: "user", content: "q" } }, e]);
    expect(tree[0]!.label).toBe("分支名");
  });

  it("rejects the header, non-objects and id-less records", () => {
    expect(projectEntry({ type: "session", id: "s0", version: 3 })).toBeNull();
    expect(projectEntry({ type: "message", parentId: null })).toBeNull();
    expect(projectEntry("nope")).toBeNull();
    expect(projectEntry([{ id: "a" }])).toBeNull();
    expect(projectEntry(null)).toBeNull();
  });

  it("is idempotent (the renderer may project RPC deltas too)", () => {
    const raw = assistantWithToolCall("a", "p", "prose", { command: "c".repeat(500), path: "/x/y.ts" });
    const once = projectEntry(raw)!;
    expect(projectEntry(once)).toEqual(once);
  });

  it("still answers search and visibility questions for a projected entry", () => {
    const e = projectEntry(assistantWithToolCall("a", null, "正文内容", { command: "npm run build" }))!;
    expect(searchableText({ entry: e })).toContain("正文内容");
    expect(searchableText({ entry: e })).toContain("assistant");
  });
});

describe("pageFromWindow", () => {
  const budget: SessionPageBudget = { maxEntries: 3, maxBytes: 1024, maxPageBytes: 4096, hardMaxBytes: 4096 };
  const entries = [0, 1, 2, 3, 4].map((i) => ({ type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, message: { role: "user", content: `p${i}` } }));

  it("returns the newest entries and the byte offset of the oldest of them", () => {
    const all = Buffer.from(entries.map((e) => line(e)).join("\n") + "\n", "utf8");
    const page = pageFromWindow(all, budget);
    expect(page.entries.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
    expect(page.droppedOlder).toBe(true);
    // The offset points at the start of e2's OWN line, so the next page ends exactly there.
    expect(all.subarray(page.oldestOffset!).toString("utf8").startsWith(line(entries[2]!))).toBe(true);
  });

  it("skips the fragment a window start cut in half and still lands on a line start", () => {
    const all = Buffer.from(entries.map((e) => line(e)).join("\n") + "\n", "utf8");
    const cut = 7; // inside e0's own line
    const page = pageFromWindow(all.subarray(cut), { ...budget, maxEntries: 10 });
    // e0's line was cut, so e0 is not in this page — but its bytes stay OLDER than the
    // returned offset, so the next page's window ends there and picks e0 up in full.
    expect(page.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    const oldest = all.subarray(cut + page.oldestOffset!).toString("utf8");
    expect(oldest.startsWith(line(entries[1]!))).toBe(true);
    expect(page.droppedOlder).toBe(false);
  });

  it("parses the last line of an older page (its newline falls outside the window)", () => {
    const all = Buffer.from(entries.map((e) => line(e)).join("\n") + "\n", "utf8");
    // A `before` window ends exactly at a line start → no newline for the final line.
    const end = all.length - Buffer.byteLength(line(entries[4]!) + "\n", "utf8");
    const page = pageFromWindow(all.subarray(0, end), { ...budget, maxEntries: 10 });
    expect(page.entries.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3"]);
    expect(page.droppedOlder).toBe(false);
  });

  it("skips malformed lines and a torn trailing write, and skips the header", () => {
    const raw = [
      line({ type: "session", id: "s0", version: 3 }),
      "{not json",
      line(entries[0]!),
      '{"type":"message","id":"e1","parentId":"e0","message":{"role":"user","content":"p1"',
    ].join("\n");
    const page = pageFromWindow(Buffer.from(raw, "utf8"), budget);
    expect(page.entries.map((e) => e.id)).toEqual(["e0"]);
    expect(page.droppedOlder).toBe(false);
  });

  it("finds nothing in a window that is all partial line (the caller must grow it)", () => {
    const all = Buffer.from(line({ type: "message", id: "e0", parentId: null, message: { role: "user", content: "x".repeat(300) } }), "utf8");
    const page = pageFromWindow(all.subarray(200), budget);
    expect(page.entries).toEqual([]);
    expect(page.oldestOffset).toBeNull();
  });

  it("ships a fraction of the bytes (the whole point of the projection)", () => {
    const fat: TreeEntry[] = [];
    for (let i = 0; i < 200; i++) {
      fat.push({
        type: "message",
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        message: { role: "toolResult", toolCallId: `tc${i}`, toolName: "bash", content: [{ type: "text", text: "output ".repeat(4000) }] },
      } as unknown as TreeEntry);
    }
    const raw = Buffer.from(fat.map((e) => line(e)).join("\n") + "\n", "utf8");
    const page = pageFromWindow(raw, { ...PAGE_BUDGET, maxEntries: 200 });
    const shipped = Buffer.byteLength(JSON.stringify(page.entries), "utf8");
    expect(page.entries.length).toBe(200);
    expect(shipped).toBeLessThan(raw.length / 10);
  });
});
