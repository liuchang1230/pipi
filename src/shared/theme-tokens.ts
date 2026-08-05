/**
 * THEME_TOKENS — the single source of truth for the app's color surface.
 *
 * Both consumers derive from here, never hand-copy:
 *  - styles.css's CSS custom properties are GENERATED at renderer boot from
 *    these tokens (theme-vars.ts injects a <style>); the old hand-written
 *    `:root` / `[data-theme="light"]` blocks are gone.
 *  - terminal-theme.ts's xterm palette imports the shared fields (accent,
 *    text, terminalBg) so the terminal and the app chrome can never drift
 *    apart again (they already agreed — by coincidence, not by contract).
 *
 * Values are byte-identical to the pre-A1 hand-written CSS so the refactor
 * is behavior-preserving.
 */
export type ThemeMode = "dark" | "light";

export interface AppThemeTokens {
  bg: string;
  bgPanel: string;
  bgInput: string;
  text: string;
  textDim: string;
  border: string;
  accent: string;
  success: string;
  danger: string;
  userBg: string;
  assistantBg: string;
  /** The terminal viewport background (xterm canvas + scrollbar area). */
  terminalBg: string;
  // Semantic surface tokens (light mode must not be white-on-white).
  hover: string;
  hoverMedium: string;
  hoverStrong: string;
  hoverSoft: string;
  hoverFaint: string;
}

export const MONO_STACK =
  '"Cascadia Code", "Consolas", "Courier New", monospace';

export const THEME_TOKENS: Record<ThemeMode, AppThemeTokens> = {
  dark: {
    bg: "#1e1e2e",
    bgPanel: "#181825",
    bgInput: "#11111b",
    text: "#cdd6f4",
    textDim: "#7f849c",
    border: "#313244",
    accent: "#89b4fa",
    success: "#a6e3a1",
    danger: "#f38ba8",
    userBg: "rgba(137, 180, 250, 0.08)",
    assistantBg: "rgba(166, 227, 161, 0.05)",
    terminalBg: "#000000",
    hover: "rgba(255, 255, 255, 0.04)",
    hoverMedium: "rgba(255, 255, 255, 0.06)",
    hoverStrong: "rgba(255, 255, 255, 0.08)",
    hoverSoft: "rgba(255, 255, 255, 0.05)",
    hoverFaint: "rgba(255, 255, 255, 0.02)",
  },
  light: {
    bg: "#f5f5f5",
    bgPanel: "#ffffff",
    bgInput: "#e8e8e8",
    text: "#1a1a2e",
    textDim: "#6b7280",
    border: "#d1d5db",
    accent: "#2563eb",
    success: "#16a34a",
    danger: "#dc2626",
    userBg: "rgba(37, 99, 235, 0.06)",
    assistantBg: "rgba(16, 185, 129, 0.05)",
    terminalBg: "#ffffff",
    hover: "rgba(0, 0, 0, 0.05)",
    hoverMedium: "rgba(0, 0, 0, 0.07)",
    hoverStrong: "rgba(0, 0, 0, 0.1)",
    hoverSoft: "rgba(0, 0, 0, 0.06)",
    hoverFaint: "rgba(0, 0, 0, 0.03)",
  },
};

const TOKEN_VAR_MAP: Array<[keyof AppThemeTokens, string]> = [
  ["bg", "--bg"],
  ["bgPanel", "--bg-panel"],
  ["bgInput", "--bg-input"],
  ["text", "--text"],
  ["textDim", "--text-dim"],
  ["border", "--border"],
  ["accent", "--accent"],
  ["success", "--success"],
  ["danger", "--danger"],
  ["userBg", "--user-bg"],
  ["assistantBg", "--assistant-bg"],
  ["terminalBg", "--terminal-bg"],
  ["hover", "--hover"],
  ["hoverMedium", "--hover-medium"],
  ["hoverStrong", "--hover-strong"],
  ["hoverSoft", "--hover-soft"],
  ["hoverFaint", "--hover-faint"],
];

/** Render the `:root` (dark) and `[data-theme="light"]` blocks from tokens.
 *  Order matters: the light block must come after :root so it wins at equal
 *  specificity — exactly the cascade the old hand-written CSS relied on.
 *  --mono is theme-independent, so it lives in :root only. */
export function themeCssVars(): string {
  const block = (tokens: AppThemeTokens): string => {
    const lines = TOKEN_VAR_MAP.map(([key, varName]) => `  ${varName}: ${tokens[key]};`);
    return lines.join("\n");
  };
  return `:root {\n  --mono: ${MONO_STACK};\n${block(THEME_TOKENS.dark)}\n}\n[data-theme="light"] {\n${block(THEME_TOKENS.light)}\n}`;
}
