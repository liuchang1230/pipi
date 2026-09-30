/**
 * Real-Linux check of the extension install script — runs the WSL-only test
 * that `npm test` deliberately skips (see ssh-install-script-wsl.test.ts).
 *
 * Why a wrapper instead of an inline env var in the npm script: `VAR=1 cmd`
 * is not valid cmd.exe syntax, and this has to work from the same shell on
 * Windows and Linux without cross-env.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitest)) {
  console.error(`vitest not found at ${vitest} — run npm install first.`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [vitest, "run", "src/main/__tests__/ssh-install-script-wsl.test.ts"],
  { cwd: root, stdio: "inherit", env: { ...process.env, PIPI_WSL_E2E: "1" } },
);

process.exit(result.status ?? 1);
