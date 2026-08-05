// Injects the app's CSS custom properties from THEME_TOKENS (the single
// token source) into a <style> element at boot. styles.css no longer defines
// :root / [data-theme="light"] by hand — they are generated here so the CSS
// surface and the terminal palette can never drift apart.
import { themeCssVars } from "../../shared/theme-tokens";

let injected = false;

export function ensureThemeVars(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.setAttribute("data-theme-vars", "");
  style.textContent = themeCssVars();
  document.head.appendChild(style);
}
