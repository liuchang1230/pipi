// Pure decision core for the WSL session-change forwarder (index.ts).
// With two tabs of one distro open, attributing a change event to the wrong
// tabId corrupts the sidebar's remoteSessions cache (keyed by tabId) and
// leaves the hydration-idle clear never firing for the real tab.
import { describe, it, expect } from "vitest";
import { pickWslEventTab } from "../wsl-event-tab";

const tab = (id: string, distro?: string, path?: string) => ({ id, wsl: distro ? { distro, path } : undefined });

describe("pickWslEventTab", () => {
  it("prefers the active tab of the distro when the event matches the polled scope", () => {
    const tabs = [tab("a", "ubuntu", "/home/u/proj"), tab("b", "ubuntu", "/home/u/other")];
    const active = tab("b", "ubuntu", "/home/u/other");
    const picked = pickWslEventTab(tabs, active, true, "ubuntu", "/home/u/other");
    expect(picked?.id).toBe("b");
  });

  it("does NOT blindly trust the active tab when the event is not from the polled scope", () => {
    // Click-path refresh of project A while tab B is active: event must go
    // to the tab whose PATH matches (a), not the active tab (b).
    const tabs = [tab("a", "ubuntu", "/home/u/proj"), tab("b", "ubuntu", "/home/u/other")];
    const active = tab("b", "ubuntu", "/home/u/other");
    const picked = pickWslEventTab(tabs, active, false, "ubuntu", "/home/u/proj");
    expect(picked?.id).toBe("a");
  });

  it("falls back to exact path match, then any tab of the distro", () => {
    const tabs = [tab("a", "debian", "/home/d/x"), tab("b", "ubuntu", "/home/u/proj")];
    expect(pickWslEventTab(tabs, undefined, false, "ubuntu", "/home/u/proj")?.id).toBe("b");
    // No path match → first tab of the distro by insertion order.
    expect(pickWslEventTab(tabs, undefined, false, "ubuntu", "/home/u/other")?.id).toBe("b");
  });

  it("returns undefined when no tab of the distro exists", () => {
    const tabs = [tab("a", "debian", "/home/d/x")];
    expect(pickWslEventTab(tabs, undefined, false, "ubuntu", "/home/u/proj")).toBeUndefined();
  });

  it("~ path normalization: a tab without path matches cwd ~", () => {
    const tabs = [tab("a", "ubuntu")];
    expect(pickWslEventTab(tabs, undefined, false, "ubuntu", "~")?.id).toBe("a");
  });
});
