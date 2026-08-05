/**
 * Single source of truth for terminal rendering.
 *
 * The app owns ALL rendering decisions for local and remote terminals:
 *
 *  - `xterm`  → drives the xterm.js canvas (background, cursor, selection,
 *               and the ANSI 16-color palette so `ls`/`git`/shell colors
 *               match the app instead of the host terminal).
 *  - `pi`     → the full pi TUI theme JSON (51 tokens). Written to
 *               `~/.pi/agent/themes/<piName>.json` (local) and the same
 *               path on remote servers; pi discovers these files and hot-
 *               reloads them, so the app fully controls pi's colors.
 *  - `colorfgbg` → value of the COLORFGBG env var injected into the pi
 *               process. pi reads it during theme detection and it decides
 *               which half of the auto mapping (`pipi-light/pipi-dark`
 *               in settings.json) is active — the app picks the mode.
 *
 * The two pi JSONs are based on pi's built-in dark/light themes (same
 * colors) but registered under unique names so pi treats them as custom
 * themes: custom names keep pi's theme file watcher alive (hot reload)
 * and cannot be shadowed by the user's own terminal background detection.
 */
import type { ITheme } from "@xterm/xterm";
import { THEME_TOKENS } from "./theme-tokens";

export type ThemeMode = "dark" | "light";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface XtermTheme extends ITheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  ansi: string[];
  brightAnsi: string[];
}

export interface TerminalTheme {
  mode: ThemeMode;
  /** Theme name registered in pi; file is `~/.pi/agent/themes/<piName>.json`. */
  piName: string;
  /** COLORFGBG value ("fg;bg" indices) that makes pi auto-detect this mode. */
  colorfgbg: string;
  /** Full pi theme JSON (51 required tokens). */
  pi: JsonValue;
  xterm: XtermTheme;
}

const dark = {
  mode: "dark",
  piName: "pipi-dark",
  colorfgbg: "15;0", // fg white, bg black → pi detects "dark"
  pi: {
    $schema:
      "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
    name: "pipi-dark",
    vars: {
      cyan: "#00d7ff",
      blue: "#5f87ff",
      green: "#b5bd68",
      red: "#cc6666",
      yellow: "#ffff00",
      text: "#d4d4d4",
      gray: "#808080",
      dimGray: "#666666",
      darkGray: "#505050",
      accent: "#8abeb7",
      selectedBg: "#3a3a4a",
      userMsgBg: "#343541",
      toolPendingBg: "#282832",
      toolSuccessBg: "#283228",
      toolErrorBg: "#3c2828",
      customMsgBg: "#2d2838",
    },
    colors: {
      accent: "accent",
      border: "blue",
      borderAccent: "cyan",
      borderMuted: "darkGray",
      success: "green",
      error: "red",
      warning: "yellow",
      muted: "gray",
      dim: "dimGray",
      text: "text",
      thinkingText: "gray",
      selectedBg: "selectedBg",
      userMessageBg: "userMsgBg",
      userMessageText: "text",
      customMessageBg: "customMsgBg",
      customMessageText: "text",
      customMessageLabel: "#9575cd",
      toolPendingBg: "toolPendingBg",
      toolSuccessBg: "toolSuccessBg",
      toolErrorBg: "toolErrorBg",
      toolTitle: "text",
      toolOutput: "gray",
      mdHeading: "#f0c674",
      mdLink: "#81a2be",
      mdLinkUrl: "dimGray",
      mdCode: "accent",
      mdCodeBlock: "green",
      mdCodeBlockBorder: "gray",
      mdQuote: "gray",
      mdQuoteBorder: "gray",
      mdHr: "gray",
      mdListBullet: "accent",
      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "gray",
      syntaxComment: "#6A9955",
      syntaxKeyword: "#569CD6",
      syntaxFunction: "#DCDCAA",
      syntaxVariable: "#9CDCFE",
      syntaxString: "#CE9178",
      syntaxNumber: "#B5CEA8",
      syntaxType: "#4EC9B0",
      syntaxOperator: "#D4D4D4",
      syntaxPunctuation: "#D4D4D4",
      thinkingOff: "darkGray",
      thinkingMinimal: "#6e6e6e",
      thinkingLow: "#5f87af",
      thinkingMedium: "#81a2be",
      thinkingHigh: "#b294bb",
      thinkingXhigh: "#d183e8",
      thinkingMax: "#ff5fff",
      bashMode: "green",
    },
    export: {
      pageBg: "#18181e",
      cardBg: "#1e1e24",
      infoBg: "#3c3728",
    },
  },
  xterm: {
    // Shared surface fields derive from THEME_TOKENS (the single token
    // source) so the terminal can never drift from the app chrome: cursor /
    // selection follow the accent, foreground follows text, background the
    // terminal viewport token. The ANSI palettes stay terminal-specific.
    background: THEME_TOKENS.dark.terminalBg,
    foreground: THEME_TOKENS.dark.text,
    cursor: THEME_TOKENS.dark.accent,
    cursorAccent: "#000000",
    selectionBackground: THEME_TOKENS.dark.accent,
    selectionForeground: "#000000",
    // ANSI 0-7 / 8-15 aligned with the pi dark theme's accent vars so
    // raw program colors (ls, git, shell prompts) stay in the same family.
    ansi: ["#282832", "#cc6666", "#b5bd68", "#ffff00", "#5f87ff", "#b294bb", "#00d7ff", "#d4d4d4"],
    brightAnsi: ["#808080", "#ff6b6b", "#d9f29a", "#ffff66", "#7fa8ff", "#d183e8", "#4de3ff", "#ffffff"],
  },
} as const satisfies TerminalTheme;

const light = {
  mode: "light",
  piName: "pipi-light",
  colorfgbg: "0;15", // fg black, bg white → pi detects "light"
  pi: {
    $schema:
      "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
    name: "pipi-light",
    vars: {
      teal: "#5a8080",
      blue: "#547da7",
      green: "#588458",
      red: "#aa5555",
      yellow: "#9a7326",
      text: "#1f2328",
      mediumGray: "#6c6c6c",
      dimGray: "#767676",
      lightGray: "#b0b0b0",
      selectedBg: "#d0d0e0",
      userMsgBg: "#e8e8e8",
      toolPendingBg: "#e8e8f0",
      toolSuccessBg: "#e8f0e8",
      toolErrorBg: "#f0e8e8",
      customMsgBg: "#ede7f6",
    },
    colors: {
      accent: "teal",
      border: "blue",
      borderAccent: "teal",
      borderMuted: "lightGray",
      success: "green",
      error: "red",
      warning: "yellow",
      muted: "mediumGray",
      dim: "dimGray",
      text: "text",
      thinkingText: "mediumGray",
      selectedBg: "selectedBg",
      userMessageBg: "userMsgBg",
      userMessageText: "text",
      customMessageBg: "customMsgBg",
      customMessageText: "text",
      customMessageLabel: "#7e57c2",
      toolPendingBg: "toolPendingBg",
      toolSuccessBg: "toolSuccessBg",
      toolErrorBg: "toolErrorBg",
      toolTitle: "text",
      toolOutput: "mediumGray",
      mdHeading: "yellow",
      mdLink: "blue",
      mdLinkUrl: "dimGray",
      mdCode: "teal",
      mdCodeBlock: "green",
      mdCodeBlockBorder: "mediumGray",
      mdQuote: "mediumGray",
      mdQuoteBorder: "mediumGray",
      mdHr: "mediumGray",
      mdListBullet: "green",
      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "mediumGray",
      syntaxComment: "#008000",
      syntaxKeyword: "#0000FF",
      syntaxFunction: "#795E26",
      syntaxVariable: "#001080",
      syntaxString: "#A31515",
      syntaxNumber: "#098658",
      syntaxType: "#267F99",
      syntaxOperator: "#000000",
      syntaxPunctuation: "#000000",
      thinkingOff: "lightGray",
      thinkingMinimal: "#767676",
      thinkingLow: "blue",
      thinkingMedium: "teal",
      thinkingHigh: "#875f87",
      thinkingXhigh: "#8b008b",
      thinkingMax: "#af005f",
      bashMode: "green",
    },
    export: {
      pageBg: "#f8f8f8",
      cardBg: "#ffffff",
      infoBg: "#fffae6",
    },
  },
  xterm: {
    background: THEME_TOKENS.light.terminalBg,
    foreground: THEME_TOKENS.light.text,
    cursor: THEME_TOKENS.light.accent,
    cursorAccent: "#ffffff",
    selectionBackground: THEME_TOKENS.light.accent,
    selectionForeground: "#ffffff",
    ansi: ["#1f2328", "#aa5555", "#588458", "#9a7326", "#547da7", "#875f87", "#5a8080", "#b0b0b0"],
    brightAnsi: ["#767676", "#cc6666", "#6aa06a", "#b08a30", "#6a8fbf", "#9d6f9d", "#6e9d9d", "#ffffff"],
  },
} as const satisfies TerminalTheme;

export const TERMINAL_THEMES: Record<ThemeMode, TerminalTheme> = { dark, light };
