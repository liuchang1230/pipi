/**
 * sdk-queue unit tests — pure routing decision for the SDK worker's
 * command-while-opening handling (see sdk-queue.ts / sdk-worker.ts).
 */
import { describe, it, expect } from "vitest";
import { decideCmdRouting, queueAtCapacity, OPENING_CMD_QUEUE_MAX } from "../chat-backend/sdk-queue";

describe("decideCmdRouting", () => {
  it("runs commands for a registered, non-closing tab", () => {
    expect(decideCmdRouting({ registered: true, closing: false, opening: false })).toBe("run");
    expect(decideCmdRouting({ registered: true, closing: false, opening: true })).toBe("run");
  });

  it("queues commands while the tab is still opening (not registered yet)", () => {
    expect(decideCmdRouting({ registered: false, closing: false, opening: true })).toBe("queue");
  });

  it("drops commands for unknown tabs or tabs being torn down", () => {
    expect(decideCmdRouting({ registered: false, closing: false, opening: false })).toBe("drop");
    expect(decideCmdRouting({ registered: false, closing: true, opening: false })).toBe("drop");
    expect(decideCmdRouting({ registered: true, closing: true, opening: false })).toBe("drop");
  });
});

describe("queueAtCapacity", () => {
  it("is false below the cap and true at/above it", () => {
    expect(queueAtCapacity(0)).toBe(false);
    expect(queueAtCapacity(OPENING_CMD_QUEUE_MAX - 1)).toBe(false);
    expect(queueAtCapacity(OPENING_CMD_QUEUE_MAX)).toBe(true);
    expect(queueAtCapacity(OPENING_CMD_QUEUE_MAX + 10)).toBe(true);
  });
});
