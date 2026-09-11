/**
 * Session-file title watcher plan — pure logic, no fs/Electron runtime.
 *
 * Real bug this pins down: pi's `get_state` reports the session path BEFORE the
 * file exists (a new session's .jsonl is written on its first assistant
 * response — verified against pi 0.85.1). `fs.watch` on a missing path throws,
 * and chat tabs are linked from exactly that promise, so the watcher was never
 * armed and the tab kept the PROJECT name as its title for the whole session
 * while the sidebar showed the real name from the session list.
 */
import { describe, expect, it } from "vitest";
import { sessionWatchPlan } from "../pty";

const local = (sessionPath?: string) => ({ sessionPath });

describe("sessionWatchPlan", () => {
  it("watches an existing session file (renames/first message follow)", () => {
    expect(sessionWatchPlan(local("C:/sessions/a.jsonl"), true)).toBe("file");
  });

  it("watches the DIR when pi promised a file that is not written yet", () => {
    // The regression: this must NOT fall through to \"file\" (watch throws).
    expect(sessionWatchPlan(local("C:/sessions/a.jsonl"), false)).toBe("dir-until-file");
  });

  it("watches the dir for a blank tab (first session file created belongs to it)", () => {
    expect(sessionWatchPlan(local(undefined), false)).toBe("dir-until-link");
    // A blank tab whose (stale) path happens to exist still needs linking.
    expect(sessionWatchPlan(local(undefined), true)).toBe("dir-until-link");
  });

  it("does nothing for remote/WSL tabs (the session list syncs their titles)", () => {
    expect(sessionWatchPlan({ ...local("C:/sessions/a.jsonl"), remote: {} }, true)).toBe("none");
    expect(sessionWatchPlan({ ...local(undefined), remote: {} }, false)).toBe("none");
    expect(sessionWatchPlan({ ...local("C:/sessions/a.jsonl"), wsl: {} }, false)).toBe("none");
  });
});
