import { describe, expect, it } from "vitest";
import { ABORT_GRACE_MS, isCancelledTurnMessage, isUserAbortMessage } from "../abort-message";

describe("isUserAbortMessage", () => {
  it("recognizes the wording pi/Node actually produce", () => {
    // Verbatim from a real session file (the message the user saw as "模型错误").
    expect(isUserAbortMessage("This operation was aborted")).toBe(true);
    expect(isUserAbortMessage("Request was aborted")).toBe(true);
    expect(isUserAbortMessage("aborted")).toBe(true);
    expect(isUserAbortMessage("AbortError: The user aborted a request.")).toBe(true);
    // "Retry cancelled" is handled where the retry itself is tracked (it means
    // the retry loop stopped, not that the turn was cancelled) — kept out of
    // this narrow matcher so it cannot swallow an unrelated "…cancelled" error.
    expect(isUserAbortMessage("cancelled by user")).toBe(true);
  });

  it("does NOT swallow connection failures that merely say aborted", () => {
    // The trap: these are real failures and must stay visible.
    expect(isUserAbortMessage("Connection aborted.")).toBe(false);
    expect(isUserAbortMessage("socket hang up")).toBe(false);
    expect(isUserAbortMessage("read ECONNRESET")).toBe(false);
    expect(isUserAbortMessage("Timeout, server 1.2.3.4 not responding.")).toBe(false);
    expect(isUserAbortMessage("connection reset by peer")).toBe(false);
  });

  it("is false for empty/undefined and for ordinary model errors", () => {
    expect(isUserAbortMessage(undefined)).toBe(false);
    expect(isUserAbortMessage("")).toBe(false);
    expect(isUserAbortMessage("   ")).toBe(false);
    expect(isUserAbortMessage("Provider finish_reason: error")).toBe(false);
    expect(isUserAbortMessage("insufficient balance")).toBe(false);
  });
});

describe("isCancelledTurnMessage", () => {
  it("trusts pi's own abort marker", () => {
    expect(isCancelledTurnMessage({ stopReason: "aborted" })).toBe(true);
  });

  it("trusts the cancellation wording even with no abort request recorded", () => {
    // Escape pressed in the terminal view, or an abort made by an extension:
    // we never saw the click, but the text is unambiguous.
    expect(isCancelledTurnMessage({ stopReason: "error", errorMessage: "This operation was aborted" })).toBe(true);
  });

  it("treats an empty message as cancelled when we know the user pressed stop", () => {
    const now = 1_000_000;
    expect(
      isCancelledTurnMessage({
        stopReason: "error",
        errorMessage: "some opaque provider text",
        contentLength: 0,
        abortRequestedAt: now - 5_000,
        now,
      }),
    ).toBe(true);
  });

  it("still reports a real failure when output was produced before it", () => {
    const now = 1_000_000;
    expect(
      isCancelledTurnMessage({
        stopReason: "error",
        errorMessage: "Provider finish_reason: error",
        contentLength: 120,
        abortRequestedAt: now - 5_000,
        now,
      }),
    ).toBe(false);
  });

  it("does not use a stale stop request to explain a later failure", () => {
    const now = 1_000_000;
    expect(
      isCancelledTurnMessage({
        stopReason: "error",
        errorMessage: "insufficient balance",
        contentLength: 0,
        abortRequestedAt: now - (ABORT_GRACE_MS + 1),
        now,
      }),
    ).toBe(false);
  });

  it("a fresh stop cannot explain away a NAMED failure", () => {
    const now = 1_000_000;
    const stale = { contentLength: 0, abortRequestedAt: now - 1_000, now };
    for (const text of ["socket hang up", "insufficient balance", "429 Too Many Requests", "invalid api key", "Provider finish_reason: error"]) {
      expect(isCancelledTurnMessage({ stopReason: "error", errorMessage: text, ...stale }), text).toBe(false);
    }
    // Opaque teardown text with nothing produced is still our abort.
    expect(isCancelledTurnMessage({ stopReason: "error", errorMessage: "undici: body stream", ...stale })).toBe(true);
    expect(isCancelledTurnMessage({ stopReason: "error", errorMessage: "", ...stale })).toBe(true);
  });

  it("never calls a connection failure a cancellation", () => {
    expect(
      isCancelledTurnMessage({ stopReason: "error", errorMessage: "socket hang up", contentLength: 0 }),
    ).toBe(false);
  });

  it("without any abort signal, an unexplained error stays an error", () => {
    expect(isCancelledTurnMessage({ stopReason: "error", errorMessage: "boom", contentLength: 0 })).toBe(false);
  });
});
