// Line-buffer stripper for the remote __PIPI_READY__ marker — pure logic.
// The marker is echoed as its own PLAIN line (no backslash escapes, which
// the ssh→bash quoting layers on Windows mangle). This strips that line from
// the pty stream before the renderer sees it — including CRLF endings, which
// ConPTY delivers on Windows — and reports when the session is genuinely
// established (auth + shell up).
import { describe, expect, it } from "vitest";
import { stripMarkerLine } from "../pty";

const MARKER = "__PIPI_READY__";

describe("stripMarkerLine", () => {
  it("strips a marker line with LF ending", () => {
    const r = stripMarkerLine(undefined, `${MARKER}\n`);
    expect(r.ready).toBe(true);
    expect(r.forward).toBe("");
  });

  it("strips a marker line with CRLF ending (ConPTY on Windows)", () => {
    const r = stripMarkerLine(undefined, `${MARKER}\r\n`);
    expect(r.ready).toBe(true);
    expect(r.forward).toBe("");
  });

  it("finds the marker split across chunk boundaries", () => {
    const first = stripMarkerLine(undefined, `${MARKER.slice(0, 8)}`);
    expect(first.ready).toBe(false);
    expect(first.forward).toBe(""); // held back: looks like the marker start
    expect(first.restBuf).toBe(MARKER.slice(0, 8));
    const second = stripMarkerLine(first.restBuf, `${MARKER.slice(8)}\n`);
    expect(second.ready).toBe(true);
    expect(second.forward).toBe("");
  });

  it("finds the marker split with a CRLF ending", () => {
    const first = stripMarkerLine(undefined, `${MARKER}\r`);
    expect(first.ready).toBe(false);
    expect(first.restBuf).toBe(`${MARKER}\r`); // trailing \r tolerated in the prefix check
    const second = stripMarkerLine(first.restBuf, "\n");
    expect(second.ready).toBe(true);
    expect(second.forward).toBe("");
  });

  it("strips the marker when an ssh banner precedes it (CRLF)", () => {
    const r = stripMarkerLine(undefined, `Warning: Permanently added 'x' (ED25519).\r\n${MARKER}\r\n`);
    expect(r.ready).toBe(true);
    expect(r.forward).toBe("Warning: Permanently added 'x' (ED25519).\r\n");
  });

  it("keeps a line AFTER the marker in the same chunk (chatty .bashrc)", () => {
    const r = stripMarkerLine(undefined, `A\n${MARKER}\nB\n`);
    expect(r.ready).toBe(true);
    expect(r.forward).toBe("A\nB\n");
    const crlf = stripMarkerLine(undefined, `A\r\n${MARKER}\r\nB\r\n`);
    expect(crlf.ready).toBe(true);
    expect(crlf.forward).toBe("A\r\nB\r\n");
  });

  it("forwards the prompt line that follows the marker", () => {
    const r = stripMarkerLine(undefined, `${MARKER}\r\ncrscu@host:/data$ `);
    expect(r.ready).toBe(true);
    expect(r.forward).toBe("crscu@host:/data$ ");
  });

  it("passes unrelated output through untouched", () => {
    const r = stripMarkerLine(undefined, "Password: ");
    expect(r.ready).toBe(false);
    expect(r.forward).toBe("Password: "); // not a marker prefix → forwarded at once
    expect(r.restBuf).toBe("");
    const next = stripMarkerLine(undefined, "Permission denied\n");
    expect(next.ready).toBe(false);
    expect(next.forward).toBe("Permission denied\n");
  });

  it("buffers an incomplete line only while it could be the marker start", () => {
    const r = stripMarkerLine(undefined, "echo hello\n__PIPI");
    expect(r.ready).toBe(false);
    expect(r.forward).toBe("echo hello\n"); // completed lines forward immediately
    expect(r.restBuf).toBe("__PIPI"); // marker-prefix tail held back
  });

  it("releases the buffer when the tail stops matching the marker prefix", () => {
    const first = stripMarkerLine(undefined, "__PIPI");
    const second = stripMarkerLine(first.restBuf, "X");
    expect(second.forward).toBe("__PIPIX"); // no longer a marker start → flush
    expect(second.restBuf).toBe("");
    expect(second.ready).toBe(false);
  });

  it("flushes a long no-newline line immediately (no unbounded buffering)", () => {
    const big = "x".repeat(8192);
    const r = stripMarkerLine(undefined, big);
    expect(r.ready).toBe(false);
    expect(r.forward).toBe(big);
    expect(r.restBuf).toBe("");
  });

  it("does not treat a marker prefix inside a longer line as a split", () => {
    const r = stripMarkerLine(undefined, `pre${MARKER}post`);
    expect(r.ready).toBe(false);
    expect(r.forward).toBe(`pre${MARKER}post`); // not a marker START → flushed whole
    expect(r.restBuf).toBe("");
  });

  it("strips a marker line with trailing whitespace", () => {
    const r = stripMarkerLine(undefined, `${MARKER}  \n`);
    expect(r.ready).toBe(true);
    expect(r.forward).toBe("");
  });

  it("does NOT strip a marker without a trailing newline (not a complete line)", () => {
    const r = stripMarkerLine(undefined, MARKER);
    expect(r.ready).toBe(false);
    expect(r.restBuf).toBe(MARKER); // held as a potential split; next chunk decides
    const next = stripMarkerLine(r.restBuf, " \n");
    expect(next.ready).toBe(true);
  });

  it("a newline splitting the marker breaks detection (echo corruption is not recoverable)", () => {
    const first = stripMarkerLine(undefined, `${MARKER.slice(0, 8)}`);
    const second = stripMarkerLine(first.restBuf, "\n"); // \n lands between pieces
    expect(second.ready).toBe(false);
    expect(second.forward).toBe(`${MARKER.slice(0, 8)}\n`); // prefix became a complete non-marker line → forwarded
    const third = stripMarkerLine(second.restBuf, `${MARKER.slice(8)}\n`);
    expect(third.ready).toBe(false); // no intact marker line remains
    expect(third.forward).toBe(`${MARKER.slice(8)}\n`);
  });

  it("flushes a marker-prefix tail that follows the marker line (double echo)", () => {
    const r = stripMarkerLine(undefined, `${MARKER}\n${MARKER.slice(0, 5)}`);
    expect(r.ready).toBe(true);
    expect(r.forward).toBe(""); // marker line stripped; the 5-char prefix tail is held
    expect(r.restBuf).toBe(MARKER.slice(0, 5));
  });
});
