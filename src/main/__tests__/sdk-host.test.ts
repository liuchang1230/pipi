/**
 * sdk-host unit tests — mock electron + worker_threads to verify the
 * host-side routing logic without spawning a real worker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const sent = new Map<string, unknown[]>();
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static handler: ((m: unknown) => void) | null = null;
    posted: Array<Record<string, unknown>> = [];
    exitCb: ((code: number) => void) | null = null;
    constructor(_url: URL, _opts: unknown) {
      FakeWorker.instances.push(this);
    }
    postMessage(m: Record<string, unknown>): void {
      this.posted.push(m);
    }
    on(ev: string, cb: (code: number) => void): void {
      if (ev === "exit") this.exitCb = cb;
      if (ev === "message") FakeWorker.handler = cb as never;
      if (ev === "error") { /* ignore */ }
    }
    terminate(): Promise<void> {
      return Promise.resolve();
    }
    emitMessage(m: unknown): void {
      FakeWorker.handler?.(m);
    }
    emitExit(code: number): void {
      this.exitCb?.(code);
    }
  }
  return { sent, FakeWorker };
});

// Mock electron BEFORE importing sdk-host.
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (ch: string, ...args: unknown[]) => { h.sent.set(ch, args); } } },
    ],
  },
}));

// Mock node:worker_threads so ensureWorker() gets a fake worker we control.
vi.mock("node:worker_threads", () => ({ Worker: h.FakeWorker }));

// Mock pty module (registerExternalTab etc.).
vi.mock("../pty", () => ({
  registerExternalTab: vi.fn(),
  unregisterExternalTab: vi.fn(),
  linkTabSession: vi.fn(),
  setTabTitle: vi.fn(),
  getTab: () => null,
  createTab: vi.fn(),
  closeTab: vi.fn(),
}));

import * as sdkHost from "../chat-backend/sdk-host";

beforeEach(() => {
  h.FakeWorker.instances = [];
  h.FakeWorker.handler = null;
  h.sent.clear();
  // Reset module-level worker/tabs state between tests.
  sdkHost.closeAllSdkSessions();
});

describe("sdk-host routing", () => {
  it("routes tab:rpc-ui-response to kind:ui (not kind:cmd)", () => {
    const id = sdkHost.openSdkSession({ cwd: "C:/x", agentDir: "C:/x/.pi" });
    const w = h.FakeWorker.instances[0]!;
    const ok = sdkHost.sdkUiResponse(id, { id: "abc", value: "yes" });
    expect(ok).toBe(true);
    expect(w.posted.some((m) => m.kind === "ui" && m.tabId === id && (m.response as { value?: string }).value === "yes")).toBe(true);
  });

  it("forwards worker events to the renderer with tabId", () => {
    const id = sdkHost.openSdkSession({ cwd: "C:/x", agentDir: "C:/x/.pi" });
    const w = h.FakeWorker.instances[0]!;
    w.emitMessage({ kind: "evt", tabId: id, event: { type: "agent_start" } });
    const ch = `tab:rpc-event:${id}`;
    expect(h.sent.has(ch)).toBe(true);
    expect((h.sent.get(ch)?.[0] as { type?: string })?.type).toBe("agent_start");
  });

  it("marks tab exited and notifies renderer via tab:rpc-exit on close", () => {
    const id = sdkHost.openSdkSession({ cwd: "C:/x", agentDir: "C:/x/.pi" });
    const w = h.FakeWorker.instances[0]!;
    w.emitMessage({ kind: "opened", tabId: id });
    w.emitMessage({ kind: "closed", tabId: id });
    const ch = `tab:rpc-exit:${id}`;
    expect(h.sent.has(ch)).toBe(true);
    // Input should be disabled: sdkSend now returns false (tab exited).
    expect(sdkHost.sdkSend(id, { type: "get_state" })).toBe(false);
  });

  it("sdkSend returns false for unknown tab", () => {
    expect(sdkHost.sdkSend("nope", { type: "get_state" })).toBe(false);
  });

  it("openSdkSession registers a queryable tab after spawn", () => {
    const id = sdkHost.openSdkSession({ cwd: "C:/y", agentDir: "C:/y/.pi" });
    expect(sdkHost.getSdkTab(id)).not.toBeNull();
    expect(h.FakeWorker.instances.length).toBeGreaterThanOrEqual(1);
  });
});
