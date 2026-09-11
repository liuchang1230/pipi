// Single-flight gate for the TreeDialog get_entries poll.
//
// Regression context: the 3s poll had no in-flight guard, and a remote
// get_entries round trip measures 15–18s — so requests stacked up (12949 sends
// for one dialog) and saturated pi's serial RPC command loop, starving
// prompts/get_state and making the whole app look hung.
import { describe, expect, it } from "vitest";
import { createEntriesSlot } from "../tree-poll-guard";

describe("createEntriesSlot", () => {
  it("allows the first acquire and blocks a second while in flight", () => {
    const slot = createEntriesSlot(1000, () => 0);
    expect(slot.acquire()).toBe(true);
    expect(slot.acquire()).toBe(false);
    expect(slot.isInFlight()).toBe(true);
  });

  it("frees the slot on release", () => {
    const slot = createEntriesSlot(1000, () => 0);
    slot.acquire();
    slot.release();
    expect(slot.isInFlight()).toBe(false);
    expect(slot.acquire()).toBe(true);
  });

  it("re-claims a stalled slot only after the stall window (dropped response)", () => {
    let t = 0;
    const slot = createEntriesSlot(30_000, () => t);
    expect(slot.acquire()).toBe(true);
    t = 29_999;
    expect(slot.acquire()).toBe(false); // still inside the legitimate window
    t = 30_000;
    expect(slot.acquire()).toBe(true); // channel presumed dead — retry
  });

  it("a slow-but-alive response inside the window is never duplicated", () => {
    let t = 0;
    const slot = createEntriesSlot(30_000, () => t);
    slot.acquire();
    t = 18_000; // measured worst-case remote round trip
    expect(slot.acquire()).toBe(false);
  });
});
