// wsl-shell — 「WSL 里哪个 pi 才算数」的两条规则（ADR 0010）：
// PATH 清洗（只留发行版自己的条目）与 argv 形状（--exec 绕开 wsl.exe 的 $VAR
// 预展开）。纯文本在这里断言；真机行为在 Ubuntu-22.04 上实测过
// （docs/diagnosis/2026-10-05.md）。
import { describe, expect, it } from "vitest";
import { wslArgv, wslCleanPathSnippet, wslInnerCommand } from "../wsl-shell";

describe("wslCleanPathSnippet", () => {
  it("drops /mnt/* entries and keeps the distro's own order", () => {
    expect(wslCleanPathSnippet()).toContain('grep -v "^/mnt/"');
  });

  it("exports the cleaned PATH and chains with && (a failed filter must stop the command)", () => {
    const s = wslCleanPathSnippet();
    expect(s).toMatch(/^PATH=\$\(.*\) && export PATH$/);
    expect(s).not.toContain(";"); // one pipeline, no sequencing surprises
  });

  it("contains no single quotes (it nests inside bash -ic '…')", () => {
    expect(wslCleanPathSnippet()).not.toContain("'");
  });

  it("expands $PATH inside the distro shell (no literal newline, no pre-expanded vars)", () => {
    // wsl.exe 的 `--` 模式会把 $VAR 预展开成空；这里的 $PATH 必须原样出现在
    // 命令文本里，由 --exec 模式下的发行版 bash 自己展开。
    expect(wslCleanPathSnippet()).toContain('$PATH');
    expect(wslCleanPathSnippet()).not.toContain("\n");
  });
});

describe("wslInnerCommand", () => {
  it("prefixes the cleaning so the command runs with the distro's PATH", () => {
    expect(wslInnerCommand("cd ~ && pi --version")).toBe(
      `${wslCleanPathSnippet()} && cd ~ && pi --version`,
    );
  });
});

describe("wslArgv", () => {
  it("uses --exec /bin/bash: `--` lets wsl.exe pre-expand $VAR into empty strings", () => {
    const argv = wslArgv("Debian", "pi --version");
    expect(argv.slice(0, 4)).toEqual(["-d", "Debian", "--exec", "/bin/bash"]);
    expect(argv[4]).toBe("-ic");
  });

  it("keeps the command as the last argument and never grows with a payload", () => {
    const argv = wslArgv("Debian", "pi --version");
    expect(argv).toHaveLength(6);
    expect(argv[5].endsWith("&& pi --version")).toBe(true);
  });
});
