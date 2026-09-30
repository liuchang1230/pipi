/**
 * Child process for src/main/__tests__/clipboard-guard.test.ts.
 *
 * Imports the real pi SDK exactly the way `src/main/chat-backend/sdk-worker.ts`
 * does — flipping `TERMUX_VERSION` for the duration of the import only — and
 * reports which clipboard modules that pulled into Node's module cache.
 *
 * Usage: node clipboard-guard-probe.mjs <sdk-entry.mjs> <guard|control>
 * Prints one JSON line on stdout.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const sdkEntry = process.argv[2];
const mode = process.argv[3];

const prevTermuxVersion = process.env.TERMUX_VERSION;
if (mode === "guard") process.env.TERMUX_VERSION = "pipi-sdk-worker";

const before = new Set(Object.keys(require.cache));
let exportsCount = null;
let error = null;
try {
  const sdk = await import(pathToFileURL(sdkEntry).href);
  exportsCount = Object.keys(sdk).length;
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
} finally {
  // Same restore as the worker (and, for the guard case, the thing under test:
  // the flag must not stay flipped).
  if (prevTermuxVersion === undefined) delete process.env.TERMUX_VERSION;
  else process.env.TERMUX_VERSION = prevTermuxVersion;
}

const added = Object.keys(require.cache).filter((k) => !before.has(k) && /clipboard/i.test(k));
process.stdout.write(
  JSON.stringify({
    mode,
    error,
    exportsCount,
    // Relative tails: keep the output readable and machine-checkable.
    clipboardModules: added.map((k) => k.replace(/\\/g, "/").split("/node_modules/").pop()),
    // "loaded" means the actual NAPI binary entered the process — the crash vector.
    loadedNative: added.some((k) => k.endsWith(".node")),
    termuxAfter: process.env.TERMUX_VERSION ?? null,
  }) + "\n",
);
