/**
 * ErrorBoundary: the guard against the app-wide white screen.
 *
 * React semantics need a DOM to exercise (the suite runs in node), so what is
 * pinned here is the part that must never itself throw: the message formatter
 * and the fact that a crash handler tolerating a missing preload is pure.
 */
import { describe, expect, it } from "vitest";
import { ErrorBoundary, describeError } from "../ErrorBoundary";

describe("describeError", () => {
  it("renders Error instances with their name", () => {
    expect(describeError(new TypeError("x is not a function"))).toBe("TypeError: x is not a function");
  });

  it("renders non-Error throws (React can catch any value)", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(42)).toBe("42");
    expect(describeError({ code: 7 })).toBe('{"code":7}');
    expect(describeError(undefined)).toBe("undefined");
  });

  it("survives a value JSON.stringify refuses", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof describeError(cyclic)).toBe("string");
  });
});

describe("ErrorBoundary", () => {
  it("reports the thrown value as state (getDerivedStateFromError)", () => {
    const err = new Error("card blew up");
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
    expect(ErrorBoundary.getDerivedStateFromError("string throw")).toEqual({ error: "string throw" });
  });

  it("initial state shows children (no crash)", () => {
    const boundary = new ErrorBoundary({ children: null });
    expect(boundary.state.error).toBeNull();
  });
});
