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
 * Dark values are aligned to the embedded terminal's pipi-dark palette
 * (terminal-theme.ts) so the app chrome and the terminal share one color
 * family — the user-facing request was "match the terminal", and the two
 * used to be Catppuccin vs pipi, which clashed (plus a pure-black terminal
 * viewport). Light stays as the original neutral scheme.
 */
export type ThemeMode = "dark" | "light";

export interface AppThemeTokens {
  bg: string;
  bgPanel: string;
  bgInput: string;
  /** Tool-call card surface: dark = deep dark green (subtler than page,
   *  never bright); light = soft sage green (muted, not white). */
  toolBg: string;
  text: string;
  textDim: string;
  border: string;
  accent: string;
  success: string;
  danger: string;
  /** Caution / pending state distinct from destructive errors. */
  warning: string;
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
    // pipi-dark family (terminal-theme.ts vars + export.pageBg/cardBg):
    // bg = pageBg, bgPanel = cardBg, bgInput = toolPendingBg,
    // border = darkGray, textDim = gray, accent/success/danger = pi's own.
    // Softened: not near-black (was #18181e), borders muted so the dark
    // theme reads gentle rather than harsh.
    bg: "#1f1f28",
    bgPanel: "#26262f",
    bgInput: "#2e2e38",
    toolBg: "#1e2a20",
    text: "#d4d4d4",
    textDim: "#8a8a94",
    border: "#3c3c46",
    accent: "#8abeb7",
    success: "#b5bd68",
    danger: "#cc6666",
    warning: "#d6a85d",
    userBg: "rgba(51, 61, 85, 0.35)",
    assistantBg: "rgba(38, 53, 43, 0.35)",
    terminalBg: "#1f1f28",
    hover: "rgba(255, 255, 255, 0.04)",
    hoverMedium: "rgba(255, 255, 255, 0.06)",
    hoverStrong: "rgba(255, 255, 255, 0.08)",
    hoverSoft: "rgba(255, 255, 255, 0.05)",
    hoverFaint: "rgba(255, 255, 255, 0.02)",
  },
  light: {
    // Softened light: no pure white — panels are off-white, page is a
    // gentle gray, accents muted so the theme reads soft, not bright.
    bg: "#eef0f4",
    bgPanel: "#f7f8fa",
    bgInput: "#e4e7ec",
    toolBg: "#e2e8e3",
    text: "#2e3038",
    textDim: "#6b7280",
    border: "#d8dbe2",
    accent: "#3d6bd0",
    success: "#3f9a63",
    danger: "#cf4a4a",
    warning: "#a66a16",
    userBg: "rgba(61, 107, 208, 0.07)",
    assistantBg: "rgba(63, 154, 99, 0.06)",
    terminalBg: "#f8f8f8",
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
  ["toolBg", "--tool-bg"],
  ["text", "--text"],
  ["textDim", "--text-dim"],
  ["border", "--border"],
  ["accent", "--accent"],
  ["success", "--success"],
  ["danger", "--danger"],
  ["warning", "--warning"],
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
