// Pure parser for `wsl.exe -l -v` output — the UTF-16LE sniff and format
// regex are the trickiest part of the async WSL-distro conversion, so they
// get direct coverage (no electron/node-pty needed).
import { describe, expect, it } from "vitest";
import { parseWslDistroList } from "../wsl";

const UTF16 = (s: string) => Buffer.from("\ufeff" + s, "utf16le");

describe("parseWslDistroList", () => {
  it("parses UTF-16LE output with a BOM (wsl.exe's console-less format)", () => {
    const out = UTF16("* Ubuntu-22.04    Running    2\r\n  docker-desktop    Stopped    2\r\n");
    expect(parseWslDistroList(out)).toEqual([
      { name: "Ubuntu-22.04", default: true, running: true, version: 2 },
      { name: "docker-desktop", default: false, running: false, version: 2 },
    ]);
  });

  it("sniffs interleaved-null UTF-16LE without a BOM", () => {
    // Real wsl.exe lines always start with "* " or two spaces.
    const noBom = Buffer.from("  Ubuntu Running 2", "utf16le");
    expect(parseWslDistroList(noBom)).toEqual([{ name: "Ubuntu", default: false, running: true, version: 2 }]);
  });

  it("treats plain UTF-8 output as UTF-8", () => {
    const out = Buffer.from("* WSL2    Running    2\n", "utf8");
    expect(parseWslDistroList(out)).toEqual([{ name: "WSL2", default: true, running: true, version: 2 }]);
  });

  it("handles empty stdout and junk lines gracefully", () => {
    expect(parseWslDistroList(Buffer.alloc(0))).toEqual([]);
    expect(parseWslDistroList(Buffer.from("Windows Subsystem for Linux\nheader line\n"))).toEqual([]);
  });

  it("skips lines without a version column (the format regex requires it)", () => {
    const out = Buffer.from("Ubuntu    Running\n", "utf8");
    expect(parseWslDistroList(out)).toEqual([]);
  });
});
