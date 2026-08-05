import { createRoot } from "react-dom/client";
import { ensureThemeVars } from "./theme-vars";
import App from "./App";
import "./styles.css";

// Inject the token-derived CSS variables before first paint.
ensureThemeVars();

createRoot(document.getElementById("root")!).render(<App />);
