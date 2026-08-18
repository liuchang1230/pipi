// readFileContent + image preview payload (main process, no Electron runtime).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileContent, imagePayloadOf, rasterImageMimeOf, IMAGE_PREVIEW_MAX_BYTES, listFiles, listDirChildren, readPreviewFromAbs, TEXT_PREVIEW_MAX_BYTES, TEXT_PREVIEW_HALF_BYTES } from "../file-tree";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "filetree-read-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lazy tree listing (listDirChildren / listFiles)", () => {
  it("lists only ONE level; dirs carry undefined children", async () => {
    writeFileSync(join(root, "README.md"), "y");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "src", "deep", "b.ts"), "x");

    const nodes = await listFiles(root);
    expect(nodes.map((n) => n.name).sort()).toEqual(["README.md", "src"]);
    const src = nodes.find((n) => n.name === "src")!;
    expect(src.children).toBeUndefined(); // lazy: not walked

    const srcChildren = await listDirChildren(root, "src");
    expect(srcChildren.map((n) => n.name).sort()).toEqual(["a.ts", "deep"]);
    expect(srcChildren.find((n) => n.name === "deep")!.children).toBeUndefined();
    // Paths stay relative to the project ROOT.
    expect(srcChildren.map((n) => n.path).sort()).toEqual(["src/a.ts", "src/deep"]);

    const deepChildren = await listDirChildren(root, "src/deep");
    expect(deepChildren.map((n) => n.path)).toEqual(["src/deep/b.ts"]);
  });

  it("filters IGNORE and hidden entries per level", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x.js"), "x");
    writeFileSync(join(root, ".secret"), "x");
    writeFileSync(join(root, ".gitignore"), "x"); // allowlisted dotfile
    const nodes = await listFiles(root);
    const names = nodes.map((n) => n.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".secret");
    expect(names).toContain(".gitignore");
  });

  it("refuses paths that escape the project root", async () => {
    await expect(listDirChildren(root, "../escape")).rejects.toThrow(/escapes/);
  });

  it("returns an empty listing for a vanished directory", async () => {
    expect(await listDirChildren(root, "nope")).toEqual([]);
  });
});

describe("text preview read gate (oversize head+tail sampling)", () => {
  it("reads files at/below the cap whole (no truncation)", async () => {
    writeFileSync(join(root, "ok.log"), "x".repeat(TEXT_PREVIEW_MAX_BYTES));
    const res = await readPreviewFromAbs(join(root, "ok.log"), "ok.log");
    expect(res.truncated).toBeUndefined();
    expect(res.bytes).toBe(TEXT_PREVIEW_MAX_BYTES);
    expect(res.content.length).toBe(TEXT_PREVIEW_MAX_BYTES); // exact boundary: not truncated
  });

  it("cap+1: truncated, head/tail windows do not overlap, size kept", async () => {
    const size = TEXT_PREVIEW_MAX_BYTES + 1; // just over the cap
    const headText = "H".repeat(TEXT_PREVIEW_HALF_BYTES);
    const tailText = "T".repeat(TEXT_PREVIEW_HALF_BYTES);
    writeFileSync(join(root, "over.log"), headText + "M" + tailText); // size = 2*half + 1
    expect(size).toBe(2 * TEXT_PREVIEW_HALF_BYTES + 1);
    const res = await readPreviewFromAbs(join(root, "over.log"), "over.log");
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(size);
    // The byte at index half (the "M") falls in the gap — only head+tail show.
    expect(res.content.startsWith(headText));
    expect(res.content.endsWith(tailText));
    expect(res.content).not.toContain("M");
  });

  it("multibyte char at the head cut yields U+FFFD, not a crash", async () => {
    // A 3-byte UTF-8 char ends exactly at the 512KB head cut → head decode
    // gets a partial sequence (U+FFFD); the preview must not throw.
    const char = Buffer.from("你", "utf8"); // 3 bytes
    const head = Buffer.concat([Buffer.alloc(TEXT_PREVIEW_HALF_BYTES - 1, 0x78), char.subarray(0, 1)]);
    const tail = Buffer.alloc(TEXT_PREVIEW_HALF_BYTES, 0x74);
    writeFileSync(join(root, "seam.txt"), Buffer.concat([head, tail, Buffer.alloc(8)]));
    const res = await readPreviewFromAbs(join(root, "seam.txt"), "seam.txt");
    expect(res.truncated).toBe(true);
    expect(res.isBinary).toBe(false);
    expect(typeof res.content).toBe("string");
    expect(res.content).toContain("\uFFFD"); // partial sequence at the seam
  });

  it("samples head+tail only for oversize text, keeping the true size", async () => {
    const head = "HEAD\n".repeat(1000);
    const tail = "TAIL\n".repeat(1000);
    const filler = "m".repeat(2 * 1024 * 1024); // > cap, no newlines in the middle
    writeFileSync(join(root, "big.log"), head + filler + tail);
    const res = await readPreviewFromAbs(join(root, "big.log"), "big.log");
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeGreaterThan(TEXT_PREVIEW_MAX_BYTES);
    expect(res.isBinary).toBe(false);
    // Head and tail both present; the middle filler is NOT (it's the gap).
    expect(res.content).toContain("HEAD");
    expect(res.content).toContain("TAIL");
    expect(res.content.length).toBeLessThan(TEXT_PREVIEW_MAX_BYTES + 64);
    expect(res.content).toContain("……"); // visible gap marker
  });

  it("oversize binary: binary placeholder, no text sampling, no image for non-images", async () => {
    const head = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.alloc(TEXT_PREVIEW_HALF_BYTES - 4)]);
    const tail = Buffer.alloc(TEXT_PREVIEW_HALF_BYTES);
    writeFileSync(join(root, "big.bin"), Buffer.concat([head, tail, Buffer.alloc(1024)]));
    const res = await readPreviewFromAbs(join(root, "big.bin"), "big.bin");
    expect(res.isBinary).toBe(true);
    expect(res.image).toBeUndefined();
    expect(res.content).toContain("二进制");
  });

  it("raster between the text cap and the image cap still gets a payload (full read)", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
      Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 128, 0x00),
    ]);
    writeFileSync(join(root, "mid.png"), png);
    const res = await readPreviewFromAbs(join(root, "mid.png"), "mid.png");
    expect(res.isBinary).toBe(true);
    expect(res.image?.mimeType).toBe("image/png");
    expect(res.image?.base64.length).toBeGreaterThan(0);
  });

  it("raster larger than the image cap gets NO payload", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1, 0x00),
    ]);
    writeFileSync(join(root, "huge.png"), png);
    const res = await readPreviewFromAbs(join(root, "huge.png"), "huge.png");
    expect(res.isBinary).toBe(true);
    expect(res.image).toBeUndefined();
  });
});

describe("image preview payload", () => {
  it("maps raster extensions to MIME types; non-images return null", () => {
    expect(rasterImageMimeOf("a.png")).toBe("image/png");
    expect(rasterImageMimeOf("dir/b.JPG")).toBe("image/jpeg");
    expect(rasterImageMimeOf("c.webp")).toBe("image/webp");
    expect(rasterImageMimeOf("x.txt")).toBeNull();
    expect(rasterImageMimeOf("noext")).toBeNull();
    expect(rasterImageMimeOf("dir/archive.tar.gz")).toBeNull();
  });

  it("builds a base64 payload for a small raster, skips big files and non-images", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(imagePayloadOf(png, "img.png")).toEqual({ mimeType: "image/png", base64: png.toString("base64") });
    expect(imagePayloadOf(png, "doc.txt")).toBeUndefined();
    const atCap = Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES);
    expect(imagePayloadOf(atCap, "exact.png")?.base64.length).toBeGreaterThan(0);
    const big = Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1);
    expect(imagePayloadOf(big, "huge.png")).toBeUndefined();
    expect(imagePayloadOf(Buffer.alloc(0), "empty.png")).toBeUndefined();
  });

  it("readFileContent attaches the image payload to raster files", async () => {
    // Real PNG header + chunk bytes (NULs + high bytes → binary heuristic hits).
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length+type
      0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    writeFileSync(join(root, "shot.png"), png);
    const res = await readFileContent(root, "shot.png");
    expect(res.isBinary).toBe(true);
    expect(res.image).toEqual({ mimeType: "image/png", base64: png.toString("base64") });
  });

  it("readFileContent leaves text files and non-image binaries without a payload", async () => {
    writeFileSync(join(root, "a.ts"), "const x = 1;\n");
    const text = await readFileContent(root, "a.ts");
    expect(text.isBinary).toBe(false);
    expect(text.image).toBeUndefined();

    writeFileSync(join(root, "b.bin"), Buffer.from([1, 2, 3, 0, 5]));
    const bin = await readFileContent(root, "b.bin");
    expect(bin.isBinary).toBe(true);
    expect(bin.image).toBeUndefined();

    // SVG is text — no raster payload; the renderer inlines it as a data URL.
    writeFileSync(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const svg = await readFileContent(root, "icon.svg");
    expect(svg.isBinary).toBe(false);
    expect(svg.image).toBeUndefined();
  });
});
