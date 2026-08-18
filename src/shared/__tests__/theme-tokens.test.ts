// A1 invariant tests: THEME_TOKENS is the single color source. These pin the
// generated CSS-vars output AND the cross-source contract — the xterm palette
// must derive its shared fields (accent/text/terminalBg) from the same tokens
// the app chrome uses, so the two can never drift apart again.
import { describe, expect, it } from "vitest";
import { THEME_TOKENS, themeCssVars, MONO_STACK } from "../theme-tokens";
import { TERMINAL_THEMES } from "../terminal-theme";

describe("themeCssVars (generated CSS custom properties)", () => {
  it("emits :root (dark) then [data-theme=light] so light wins the cascade", () => {
    const css = themeCssVars();
    expect(css.indexOf(":root")).toBeLessThan(css.indexOf('[data-theme="light"]'));
    // Dark values present in :root, light values in the override.
    expect(css).toContain("--bg: #1f1f28");
    expect(css).toContain("--accent: #8abeb7");
    expect(css).toContain("--hover: rgba(255, 255, 255, 0.04)");
    expect(css).toContain('--bg: #eef0f4');
    expect(css).toContain("--accent: #3d6bd0");
    expect(css).toContain("--hover: rgba(0, 0, 0, 0.05)");
    expect(css).toContain(`--mono: ${MONO_STACK}`);
  });

  it("covers every var name the stylesheet consumes", () => {
    const css = themeCssVars();
    for (const name of [
      "--bg", "--bg-panel", "--bg-input", "--tool-bg", "--text", "--text-dim", "--border",
      "--accent", "--success", "--danger", "--user-bg", "--assistant-bg",
      "--terminal-bg", "--hover", "--hover-medium", "--hover-strong",
      "--hover-soft", "--hover-faint", "--mono",
    ]) {
      expect(css).toContain(`${name}:`);
    }
  });
});

describe("single-source contract (app chrome ⇄ terminal)", () => {
  it("xterm cursor/selection follow the accent token in both modes", () => {
    expect(TERMINAL_THEMES.dark.xterm.cursor).toBe(THEME_TOKENS.dark.accent);
    expect(TERMINAL_THEMES.dark.xterm.selectionBackground).toBe(THEME_TOKENS.dark.accent);
    expect(TERMINAL_THEMES.light.xterm.cursor).toBe(THEME_TOKENS.light.accent);
    expect(TERMINAL_THEMES.light.xterm.selectionBackground).toBe(THEME_TOKENS.light.accent);
  });

  it("xterm foreground follows the text token", () => {
    expect(TERMINAL_THEMES.dark.xterm.foreground).toBe(THEME_TOKENS.dark.text);
    expect(TERMINAL_THEMES.light.xterm.foreground).toBe(THEME_TOKENS.light.text);
  });

  it("xterm background follows the terminalBg token (matches the scrollbar CSS)", () => {
    expect(TERMINAL_THEMES.dark.xterm.background).toBe(THEME_TOKENS.dark.terminalBg);
    expect(TERMINAL_THEMES.light.xterm.background).toBe(THEME_TOKENS.light.terminalBg);
  });
});
