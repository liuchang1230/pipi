import { createRoot } from "react-dom/client";
import { ensureThemeVars } from "./theme-vars";
import App from "./App";
import "./styles.css";

// Any renderer JS error lands in the main-process debug log (pipi-debug.log)
// so remote-side failures are diagnosable without the dev terminal.
window.addEventListener("error", (e) => {
  try {
    window.api.debug.log(`renderer-ERROR ${e.message} @ ${(e.filename ?? "").split("/").pop()}:${e.lineno} ${(e.error?.stack ?? "").split("\n").slice(0, 3).join(" | ")}`);
  } catch {
    /* preload missing (tests) */
  }
});
window.addEventListener("unhandledrejection", (e) => {
  try {
    window.api.debug.log(`renderer-UNHANDLED ${String((e.reason as Error | undefined)?.message ?? e.reason).slice(0, 300)}`);
  } catch {
    /* preload missing (tests) */
  }
});

// Inject the token-derived CSS variables before first paint.
ensureThemeVars();

createRoot(document.getElementById("root")!).render(<App />);
