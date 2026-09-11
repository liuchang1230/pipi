// Single-flight + coalescing gate for the transcript (get_messages) download.
//
// Regression context: one get_messages round trip measures 17–45s on a slow
// remote link, while triggers arrive from the mount effect, the state_ready
// branch and branch navigation. Without a gate, three multi-MB downloads
// overlapped on the same link (log 08:32:03.062 / 08:32:03.071 / 08:32:04.923)
// and saturated it.
import { describe, expect, it } from "vitest";
import { createHistoryGate } from "../history-gate";

describe("createHistoryGate", () => {
  it("allows the first begin and refuses a second while in flight", () => {
    const gate = createHistoryGate();
    expect(gate.begin()).toBe(true);
    expect(gate.isInFlight()).toBe(true);
    expect(gate.begin()).toBe(false);
    expect(gate.isInFlight()).toBe(true); // the refused call must not claim twice
  });

  it("reports no re-run when nothing was triggered mid-flight", () => {
    const gate = createHistoryGate();
    gate.begin();
    expect(gate.settle()).toBe(false);
    expect(gate.isInFlight()).toBe(false);
  });

  it("reports exactly one re-run however many triggers arrived mid-flight", () => {
    const gate = createHistoryGate();
    gate.begin();
    // mount + state_ready + navigation all fire while the payload is in flight.
    expect(gate.begin()).toBe(false);
    expect(gate.begin()).toBe(false);
    expect(gate.begin()).toBe(false);
    expect(gate.settle()).toBe(true); // coalesced into ONE re-run
    // The re-run consumes the trigger: settling it again must not loop.
    expect(gate.begin()).toBe(true);
    expect(gate.settle()).toBe(false);
  });

  it("accepts a new request after settling", () => {
    const gate = createHistoryGate();
    expect(gate.begin()).toBe(true);
    gate.settle();
    expect(gate.begin()).toBe(true);
  });

  it("cannot wedge: settle always frees the slot, even after a timeout", () => {
    const gate = createHistoryGate();
    gate.begin();
    gate.begin(); // a trigger recorded while the request later times out
    expect(gate.settle()).toBe(true);
    expect(gate.isInFlight()).toBe(false);
    expect(gate.begin()).toBe(true); // usable again
  });
});
