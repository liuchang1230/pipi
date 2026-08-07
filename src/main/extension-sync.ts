/**
 * Ship app-bundled pi extensions to ~/.pi/agent/extensions/ so every pi
 * spawned by a tab picks them up via auto-discovery (see docs/extensions.md).
 *
 * Source of truth: the files in src/main/extensions/, embedded at build time
 * via Vite `?raw` imports (no packaging/asar concerns).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import staticIndicatorSource from "./extensions/pipi-static-indicator.ts?raw";
import treeNavSource from "./extensions/pipi-tree-nav.ts?raw";

const EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

const SHIPPED: Array<{ fileName: string; content: string }> = [
  { fileName: "pipi-static-indicator.ts", content: staticIndicatorSource },
  { fileName: "pipi-tree-nav.ts", content: treeNavSource },
];

/**
 * Best-effort sync of shipped extensions. Runs at app startup, before any
 * tab can spawn pi; only writes when content actually differs so we don't
 * churn mtimes on every launch. Failures are logged, never fatal.
 */
export function ensureShippedExtensions(): void {
  for (const { fileName, content } of SHIPPED) {
    try {
      mkdirSync(EXTENSIONS_DIR, { recursive: true });
      const target = join(EXTENSIONS_DIR, fileName);
      const current = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (current !== content) {
        writeFileSync(target, content, "utf8");
        console.log(`[extensions] wrote ${target}`);
      }
    } catch (e) {
      console.error(`[extensions] failed to ship ${fileName}:`, e instanceof Error ? e.message : String(e));
    }
  }
}
