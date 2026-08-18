// Regression tests for the pi detection/install rework:
// - resolveCliJsFromShim: the detection now resolves pi.cmd → cli.js and runs
//   it with node.exe directly (what a terminal does), instead of the fragile
//   `cmd /c <path> --version` probe that failed on paths with spaces.
// - installGlobalPiFromBundled: shims are ALWAYS rewritten, even when the
//   package dir is already intact (a missing pi.cmd is a broken install).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

vi.mock("electron", () => ({
  app: {
    getAppPath: vi.fn(() => process.env.PIPI_TEST_APP_PATH ?? "C:\\fake\\app"),
    getPath: vi.fn(() => process.env.PIPI_TEST_USERDATA ?? "C:\\fake\\userdata"),
  },
}));

// Import AFTER mocking electron; pty.ts imports electron at module load.
const { resolveCliJsFromShim, installGlobalPiFromBundled, npmGlobalDir, classifyInstallStage, resolveNpmEntry } = await import("../pty");

describe("resolveCliJsFromShim", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipi-shim-"));
  });

  it("resolves the standard npm layout next to the shim", () => {
    const cliDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    writeFileSync(join(dir, "pi.cmd"), "@ECHO off");
    mkdirSync(dirname(join(cliDir, "cli.js")), { recursive: true }); writeFileSync(join(cliDir, "cli.js"), "// cli");
    expect(resolveCliJsFromShim(join(dir, "pi.cmd"))).toBe(join(cliDir, "cli.js"));
  });

  it("parses a custom layout from the shim content (%dp0% expansion)", () => {
    const cliDir = join(dir, "custom", "pi", "dist");
    mkdirSync(dirname(join(cliDir, "cli.js")), { recursive: true }); writeFileSync(join(cliDir, "cli.js"), "// cli");
    const shim = join(dir, "pi.cmd");
    writeFileSync(shim, `@ECHO off\n"%_prog%" "%dp0%\\custom\\pi\\dist\\cli.js" %*\n`);
    // The resolved path normalizes to forward slashes (valid on Windows).
    expect(resolveCliJsFromShim(shim)).toBe(join(dir, "custom", "pi", "dist", "cli.js").replace(/\\/g, "/"));
  });

  it("returns null for non-.cmd entries and missing cli.js", () => {
    expect(resolveCliJsFromShim("C:\\tools\\pi.exe")).toBeNull();
    expect(resolveCliJsFromShim(join(dir, "pi.cmd"))).toBeNull(); // no cli.js written
  });

  it("handles forward-slash paths", () => {
    const cliDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    mkdirSync(dirname(join(cliDir, "cli.js")), { recursive: true }); writeFileSync(join(cliDir, "cli.js"), "// cli");
    writeFileSync(join(dir, "pi.cmd"), "@ECHO off");
    expect(resolveCliJsFromShim(join(dir, "pi.cmd").replace(/\\/g, "/"))).toBe(join(cliDir, "cli.js"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});

describe("installGlobalPiFromBundled", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pipi-install-"));
    process.env.APPDATA = tmp;
    process.env.PIPI_TEST_USERDATA = join(tmp, "userdata");
    process.env.PIPI_TEST_APP_PATH = join(tmp, "app");
  });

  it("rewrites shims even when the package is already installed (noop copy)", async () => {
    const pkg = join(tmp, "app", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(dirname(join(pkg, "dist", "cli.js")), { recursive: true }); writeFileSync(join(pkg, "dist", "cli.js"), "// cli");
    const dest = join(tmp, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(dirname(join(dest, "dist", "cli.js")), { recursive: true }); writeFileSync(join(dest, "dist", "cli.js"), "// cli");

    const result = await installGlobalPiFromBundled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("noop");

    // The bug: shims were only written on the copy path — a missing pi.cmd
    // with an intact package left detection broken. They must always exist.
    for (const f of ["pi.cmd", "pi", "pi.ps1"]) {
      expect((await import("node:fs")).existsSync(join(tmp, "npm", f))).toBe(true);
    }
  });

  it("copies the package when cli.js is missing", async () => {
    const pkg = join(tmp, "app", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(dirname(join(pkg, "dist", "cli.js")), { recursive: true });
    writeFileSync(join(pkg, "dist", "cli.js"), "// cli");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-coding-agent", version: "0.1.0" }));

    const result = await installGlobalPiFromBundled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("installed");
    const fs = await import("node:fs");
    expect(fs.existsSync(join(tmp, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"))).toBe(true);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.APPDATA;
    delete process.env.PIPI_TEST_USERDATA;
    delete process.env.PIPI_TEST_APP_PATH;
  });
});

describe("classifyInstallStage", () => {
  it("maps npm fetch lines to a download stage", () => {
    expect(classifyInstallStage("npm http fetch GET 200 https://registry.npmjs.org/foo 123ms")).toBe("正在下载依赖…");
  });

  it("maps dependency resolution lines to resolving", () => {
    expect(classifyInstallStage("npm warn reify node_modules/@earendil-works/pi-coding-agent")).toBe("正在解析依赖…");
  });

  it("maps completion lines to wrapping up", () => {
    expect(classifyInstallStage("added 214 packages in 12s")).toBe("正在收尾…");
    expect(classifyInstallStage("npm warn 1 package removed")).toBe("正在收尾…");
  });

  it("maps npm error lines to failure", () => {
    expect(classifyInstallStage("npm error code ENOENT")).toBe("安装失败");
    expect(classifyInstallStage("npm ERR! code E401")).toBe("安装失败");
  });

  it("falls back to a generic installing stage", () => {
    expect(classifyInstallStage("some other npm output")).toBe("正在安装…");
    expect(classifyInstallStage("")).toBe("正在安装…");
  });
});

describe("resolveNpmEntry", () => {
  it("passes through non-.cmd binaries", () => {
    expect(resolveNpmEntry("C:\\Tools\\npm.exe")).toEqual({ file: "C:\\Tools\\npm.exe", args: [] });
  });

  it("falls back to shell:true for proxy shims", () => {
    expect(resolveNpmEntry("C:\\nvm4w\\npm.cmd")).toEqual({ file: "C:\\nvm4w\\npm.cmd", args: [], shell: true });
  });
});
