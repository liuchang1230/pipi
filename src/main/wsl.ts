/**
 * WSL distro listing — pure parsing, split out of pty.ts so the UTF-16LE
 * sniff + format regex are unit-testable without mocking electron/node-pty.
 * pty.ts owns the spawn plumbing; this owns the bytes → distros logic.
 */
export interface WslDistro {
  name: string;
  default: boolean;
  running: boolean;
  version: number;
}

/** Parse `wsl.exe -l -v` output. wsl.exe emits UTF-16LE when stdout is not a
 *  console; detect via BOM or interleaved null bytes, else treat as UTF-8. */
export function parseWslDistroList(stdout: Buffer): WslDistro[] {
  if (stdout.length === 0) return [];
  let output: string;
  // Check for UTF-16LE BOM or interleaved null bytes.
  if (stdout[0] === 0xff && stdout[1] === 0xfe) {
    output = stdout.toString("utf16le");
  } else if (stdout.length > 2 && stdout[1] === 0x00) {
    output = stdout.toString("utf16le");
  } else {
    output = stdout.toString("utf8");
  }
  // A UTF-16LE BOM decodes to U+FEFF at the start of the FIRST line; strip it
  // or the leading `^(*?)` can never match (the default distro would vanish).
  output = output.replace(/^\ufeff/, "");
  const distros: WslDistro[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.replace(/^\ufeff/, "");
    // Format: "* Ubuntu-22.04    Running    2" or "  docker-desktop    Stopped    2"
    const m = trimmed.match(/^(\*?)\s+(\S+)\s+(Running|Stopped)\s+(\d+)/i);
    if (!m) continue;
    distros.push({
      name: m[2],
      default: m[1] === "*",
      running: m[3].toLowerCase() === "running",
      version: parseInt(m[4]) || 2,
    });
  }
  return distros;
}
