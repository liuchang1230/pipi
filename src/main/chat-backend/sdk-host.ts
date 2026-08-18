/**
 * sdk-host.ts — main-process manager for the in-process SDK backend.
 *
 * Owns ONE worker_thread (sdk-worker.ts) which hosts all local SDK sessions.
 * Exposes the same surface as RpcSession (send / request / onExit) so index.ts
 * can route tab:rpc-send to either backend by tab mode.
 *
 * Lifecycle:
 *  - openSession() lazily spawns the worker on first use, then opens a tab.
 *  - Commands route to the tab's session inside the worker; responses and
 *    events come back tagged with tabId and are forwarded to renderers via
 *    the same tab:rpc-event:{tabId} channel used by the RPC backend.
 *  - Worker crash: mark tabs as failed (forward a synthetic exit event) and
 *    respawn an empty worker; sessions live on disk so reopening recovers.
 */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
  closeTab,
  createTab,
  getTab,
  linkTabSession,
  registerExternalTab,
  setTabTitle,
  unregisterExternalTab,
  type CreateTabOptions,
  type RemoteOpts,
  type TabInfo,
  type WslOpts,
} from "../pty";
import type { ExtensionUiRequest } from "../rpc-session";

interface PendingRequest {
  resolve: (r: { id?: string; command: string; success: boolean; data?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SdkTab {
  tabId: string;
  cwd: string;
  sessionPath?: string;
  exited: boolean;
  onExitCbs: Array<(code: number) => void>;
}

const tabs = new Map<string, SdkTab>();
let worker: Worker | null = null;
let pendingRequests = new Map<string, PendingRequest>();
let nextRequestId = 1;
let crashed = false;

function forwardEvent(tabId: string, msg: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(`tab:rpc-event:${tabId}`, msg);
  }
}

function forwardUiRequest(tabId: string, req: ExtensionUiRequest): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(`tab:rpc-ui-request:${tabId}`, req);
  }
}

export let onUiRequest: ((tabId: string, req: ExtensionUiRequest) => void) | null = null;
export function setUiRequestHandler(handler: (tabId: string, req: ExtensionUiRequest) => void): void {
  onUiRequest = handler;
}

/** Pre-warm the worker (SDK import + shared infra) in the background so the
 *  first tab open is fast. Idempotent; safe to call at app startup. */
export function prewarmSdkWorker(agentDir: string): void {
  try {
    const w = ensureWorker();
    // The worker queues this until the SDK module and message loop are ready.
    // This warms ModelRuntime/settings/theme, not just the worker process.
    w.postMessage({ kind: "warm", agentDir });
  } catch (e) {
    console.error("[sdk] prewarm failed:", e instanceof Error ? e.message : String(e));
  }
}

function ensureWorker(): Worker {
  if (worker && !crashed) return worker;
  crashed = false;
  const w = new Worker(new URL("./sdk-worker.js", import.meta.url), {
    workerData: {},
  });
  worker = w;
  w.on("message", (msg) => {
    switch (msg.kind) {
      case "opened": {
        const tab = tabs.get(msg.tabId);
        if (!tab) return;
        if (msg.error) {
          console.error(`[sdk] tab ${msg.tabId} open failed:`, msg.error);
          markExited(msg.tabId, -1);
          return;
        }
        // Session file created by pi — link it for title/sidebar sync, and
        // FORWARD the get_state response so the renderer's onRpcEvent handler
        // sees it (RPC backend forwards every response; SDK mode must too).
        void sdkRequest(msg.tabId, { type: "get_state" }).then((res) => {
          const data = res.data as { sessionFile?: string; sessionName?: string } | undefined;
          if (res.success && data) {
            if (data.sessionFile) linkTabSession(msg.tabId, data.sessionFile);
            if (data.sessionName) setTabTitle(msg.tabId, data.sessionName);
          }
          // Mirror createRpcTab's state_ready handshake so the chat view
          // boots (model/name/steering fields) without depending on the
          // renderer's own get_state request racing the subscription.
          if (res.success && res.data) {
            const d = res.data as Record<string, unknown>;
            forwardEvent(msg.tabId, {
              type: "state_ready",
              model: (d.model as never) ?? null,
              sessionName: (d.sessionName as string | null) ?? null,
              thinkingLevel: (d.thinkingLevel as string | null) ?? null,
              steeringMode: d.steeringMode,
              followUpMode: d.followUpMode,
              autoCompactionEnabled: d.autoCompactionEnabled,
            });
          }
          forwardEvent(msg.tabId, res as never);
        });
        return;
      }
      case "evt":
        forwardEvent(msg.tabId, msg.event);
        return;
      case "resp": {
        const req = pendingRequests.get(msg.resp.id);
        if (req) {
          pendingRequests.delete(msg.resp.id);
          clearTimeout(req.timer);
          req.resolve(msg.resp);
        }
        // Also forward as a generic event so renderer onRpcEvent handlers
        // that consume responses by command name keep working.
        forwardEvent(msg.tabId, msg.resp);
        return;
      }
      case "ui": {
        const tab = tabs.get(msg.tabId);
        if (!tab) return;
        if (onUiRequest) onUiRequest(msg.tabId, msg.req);
        else forwardUiRequest(msg.tabId, msg.req);
        return;
      }
      case "closed":
        markExited(msg.tabId, 0);
        return;
    }
  });
  w.on("error", (err) => {
    console.error("[sdk] worker error:", err);
  });
  w.on("exit", (code) => {
    // Only handle the CURRENT worker's exit — a stale worker terminated by
    // closeAllSdkSessions must not orphan a freshly spawned replacement.
    if (worker !== w) return;
    console.log(`[sdk] worker exited: ${code}`);
    worker = null;
    crashed = code !== 0;
    // Flush in-flight requests with a crash error instead of letting them
    // hang to the 15s timeout with a misleading "timeout".
    for (const [, req] of pendingRequests) {
      clearTimeout(req.timer);
      req.resolve({ id: undefined, command: "", success: false, error: "sdk worker exited" });
    }
    pendingRequests = new Map();
    for (const tab of [...tabs.values()]) markExited(tab.tabId, code ?? -1);
  });
  return w;
}

function markExited(tabId: string, code: number): void {
  const tab = tabs.get(tabId);
  if (!tab || tab.exited) return;
  tab.exited = true;
  // Mirror RpcSession.emitExit so the renderer marks the tab exited (input
  // disabled, "pi 已退出" banner) and tab:alive goes false.
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(`tab:rpc-exit:${tabId}`, code);
  }
  for (const cb of tab.onExitCbs) cb(code);
  tab.onExitCbs = [];
}

export function getSdkTab(id: string): SdkTab | null {
  return tabs.get(id) ?? null;
}

export function listSdkTabs(): SdkTab[] {
  return [...tabs.values()];
}

/** Spawn-or-reuse worker, open a session, register the tab record. */
export function openSdkSession(opts: CreateTabOptions & { id?: string; agentDir: string }): string {
  const id = opts.id ?? `sdk-${randomUUID().slice(0, 8)}`;
  // Spawn the worker FIRST: a spawn failure throws here (before any tab is
  // registered) so no ghost tab appears in tab:list.
  const w = ensureWorker();
  const tab: TabInfo = {
    id,
    cwd: opts.cwd,
    sessionPath: opts.sessionPath,
    title: opts.title || opts.cwd.replace(/\\/g, "/").split("/").pop() || opts.cwd,
    cols: 80,
    rows: 24,
    createdAt: Date.now(),
  };
  registerExternalTab(tab);
  tabs.set(id, { tabId: id, cwd: opts.cwd, sessionPath: opts.sessionPath, exited: false, onExitCbs: [] });
  w.postMessage({
    kind: "open",
    tabId: id,
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    sessionPath: opts.sessionPath,
    continueRecent: opts.continueRecent,
  });
  return id;
}

/** Send a command (fire-and-forget). Returns false if tab/worker gone. */
export function sdkSend(tabId: string, cmd: Record<string, unknown>): boolean {
  const tab = tabs.get(tabId);
  if (!tab || tab.exited || !worker) return false;
  worker.postMessage({ kind: "cmd", tabId, cmd });
  return true;
}

/** Deliver an extension_ui_response to the worker (dialog answers). */
export function sdkUiResponse(tabId: string, response: Record<string, unknown>): boolean {
  const tab = tabs.get(tabId);
  if (!tab || tab.exited || !worker) return false;
  worker.postMessage({ kind: "ui", tabId, response });
  return true;
}

/** One-shot request/response with timeout. */
export function sdkRequest(
  tabId: string,
  cmd: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<{ id?: string; command: string; success: boolean; data?: unknown; error?: string }> {
  const id = (cmd.id as string) ?? `sdk-${nextRequestId++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve({ id, command: cmd.type as string, success: false, error: "timeout" });
    }, timeoutMs);
    pendingRequests.set(id, { resolve, timer });
    if (!sdkSend(tabId, { ...cmd, id })) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      resolve({ id, command: cmd.type as string, success: false, error: "tab unavailable" });
    }
  });
}

export function sdkOnExit(tabId: string, cb: (code: number) => void): () => void {
  const tab = tabs.get(tabId);
  if (!tab) return () => {};
  if (tab.exited) {
    cb(-1);
    return () => {};
  }
  tab.onExitCbs.push(cb);
  return () => {
    const i = tab.onExitCbs.indexOf(cb);
    if (i !== -1) tab.onExitCbs.splice(i, 1);
  };
}

export function closeSdkTab(id: string): boolean {
  const tab = tabs.get(id);
  if (!tab) return false;
  if (!tab.exited && worker) worker.postMessage({ kind: "close", tabId: id });
  tabs.delete(id);
  unregisterExternalTab(id);
  return true;
}

export function closeAllSdkSessions(): void {
  for (const id of [...tabs.keys()]) closeSdkTab(id);
  worker?.terminate().catch(() => {});
  worker = null;
  pendingRequests = new Map();
}

/** pty → SDK fallback (local tabs): kill the pty pi and respawn it as an
 *  in-process SDK session for the SAME tab id (mirrors switchTerminalToRpc
 *  in rpc-session.ts, but for the SDK backend). The chat view is opt-in;
 *  this is what the TabBar「聊天视图」button uses on local tabs. */
export function switchTerminalToSdk(id: string, agentDir: string): string | null {
  const t = getTab(id);
  if (!t || !t.pty) return null;
  const { cwd, sessionPath, title } = t;
  closeTab(id);
  try {
    return openSdkSession({ id, cwd, sessionPath, continueRecent: sessionPath ? undefined : true, title, agentDir });
  } catch (e) {
    // Worker spawn failed (e.g. build artifact missing) — the pty was already
    // closed; restore it so the user is not left with a dead tab.
    console.error(`[sdk] switchTerminalToSdk failed — restoring pty tab ${id}:`, e);
    try {
      return createTab({ id, cwd, sessionPath, continueRecent: sessionPath ? undefined : true, title });
    } catch {
      return null;
    }
  }
}

/** SDK → pty fallback (local tabs): kill the in-process session and respawn
 *  pi's TUI in a pty for the SAME tab id (the reverse of switchTerminalToSdk;
 *  mirrors switchRpcToTerminal). */
export function switchSdkToTerminal(id: string, agentDir: string): string | null {
  const tab = tabs.get(id);
  if (!tab) return null;
  const t = getTab(id);
  const { cwd, sessionPath } = tab;
  const title = t?.title ?? (cwd.replace(/\\/g, "/").split("/").pop() || cwd);
  closeSdkTab(id);
  try {
    return createTab({ id, cwd, sessionPath, continueRecent: sessionPath ? undefined : true, title });
  } catch (e) {
    // pty spawn failed (pi binary missing etc.) — reopen the SDK session so
    // the chat tab survives the failed switch.
    console.error(`[sdk] switchSdkToTerminal failed — restoring SDK tab ${id}:`, e);
    try {
      return openSdkSession({ id, cwd, sessionPath, continueRecent: sessionPath ? undefined : true, title, agentDir });
    } catch {
      return null;
    }
  }
}
