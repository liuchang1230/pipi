/**
 * sdk-worker.ts — in-process pi agent backend (worker_thread).
 *
 * One worker hosts ALL local SDK tabs. The expensive global infrastructure
 * (ModelRuntime / DefaultResourceLoader / SettingsManager — ~1.1s import +
 * model registry) is created ONCE; each tab then only pays for an
 * AgentSessionRuntime (~10-50ms). Compare: RPC backend spawns a full
 * `pi --mode rpc` child per tab (~1.9s).
 *
 * Protocol (parentPort messages):
 *   host → worker:
 *     { kind: "open",  tabId, cwd, agentDir, sessionPath?, continueRecent? }
 *     { kind: "cmd",   tabId, id?, cmd: RpcCommand }
 *     { kind: "ui",    tabId, response }        // extension_ui_response
 *     { kind: "close", tabId }
 *   worker → host:
 *     { kind: "ready" }
 *     { kind: "evt",   tabId, event }           // RPC-shaped event frame
 *     { kind: "resp",  tabId, resp }            // RPC response frame
 *     { kind: "ui",    tabId, req }             // extension_ui_request
 *     { kind: "closed", tabId }
 *
 * Command handling mirrors upstream `runRpcMode`'s handleCommand switch
 * (dist/modes/rpc/rpc-mode.js) so behavior stays identical to the RPC
 * backend; events go through the same `toJsonEvent` mapping.
 */
import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { decideCmdRouting, queueAtCapacity } from "./sdk-queue";

// --- Undici worker polyfill ------------------------------------------------
// undici 8.x (a pi-coding-agent dep) reads `markAsUncloneable` off
// node:worker_threads at load time and assigns it to webidl.util without a
// fallback (undici/lib/web/webidl/index.js). Electron's bundled Node (20.x)
// does not export it, so `new CacheStorage()` throws "markAsUncloneable is
// not a function" and kills the worker. The SDK is imported dynamically BELOW
// so this patch runs first (ESM static imports would evaluate the SDK before
// this block executes).
{
  const require = createRequire(import.meta.url);
  try {
    const wt = require("node:worker_threads") as { markAsUncloneable?: unknown };
    if (typeof wt.markAsUncloneable !== "function") {
      wt.markAsUncloneable = (() => {}) as never;
    }
  } catch {
    // Non-fatal: if the patch fails the worker startup error is more useful.
  }
}

// Dynamic import: the SDK pulls in undici which must see the patched
// worker_threads export above. (electron-vite keeps this as a runtime
// import of the external package.)
const sdk = await import("@earendil-works/pi-coding-agent");
const {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  initTheme,
} = sdk as typeof import("@earendil-works/pi-coding-agent");
type AgentSessionRuntime = import("@earendil-works/pi-coding-agent").AgentSessionRuntime;
type ModelRuntimeT = import("@earendil-works/pi-coding-agent").ModelRuntime;
type SessionManagerT = import("@earendil-works/pi-coding-agent").SessionManager;
type SettingsManagerT = import("@earendil-works/pi-coding-agent").SettingsManager;

/** Strip the `partial` delta from message_update events (mirrors upstream
 *  toJsonEvent so RPC-shaped frames stay byte-identical). */
function toJsonEvent(event: unknown): unknown {
  if ((event as { type?: string }).type !== "message_update") return event;
  const assistantMessageEvent = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
  if (!assistantMessageEvent || !("partial" in (assistantMessageEvent as Record<string, unknown>))) {
    return { type: "message_update", assistantMessageEvent };
  }
  const { partial: _partial, ...deltaEvent } = assistantMessageEvent as Record<string, unknown> & { partial?: unknown };
  return { type: "message_update", assistantMessageEvent: deltaEvent };
}

interface OpenRequest {
  kind: "open";
  tabId: string;
  cwd: string;
  agentDir: string;
  sessionPath?: string;
  continueRecent?: boolean;
}
interface CmdRequest {
  kind: "cmd";
  tabId: string;
  cmd: Record<string, unknown>;
}
interface UiResponseRequest {
  kind: "ui";
  tabId: string;
  response: Record<string, unknown>;
}
interface CloseRequest {
  kind: "close";
  tabId: string;
}
interface WarmRequest {
  kind: "warm";
  agentDir: string;
}
type HostMessage = OpenRequest | CmdRequest | UiResponseRequest | CloseRequest | WarmRequest;

// --- Shared global infrastructure (created once) ---------------------------

const runtimes = new Map<string, ModelRuntimeT>();
const initPromises = new Map<string, Promise<void>>();

function encodeCwd(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${stripped}--`;
}

async function ensureSharedInfra(agentDir: string): Promise<void> {
  let initPromise = initPromises.get(agentDir);
  if (!initPromise) {
    initPromise = (async () => {
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        modelsStorePath: join(agentDir, "models-store.json"),
      });
      runtimes.set(agentDir, runtime);
      // Warm the model registry so get_available_models is instant later.
      void runtime.refresh({ signal: AbortSignal.timeout(15_000) }).catch(() => {});
      // Theme singleton: extensions (e.g. pi-rewind's ui helpers) call
      // theme.fg(...) via the global Proxy, which throws "Cannot read
      // properties of undefined (reading 'fg')" unless initTheme() ran.
      // RPC mode gets this from main.js; the SDK worker must do it itself.
      const settings = SettingsManager.create(process.cwd(), agentDir);
      try {
        initTheme(settings.getTheme());
      } catch (e) {
        console.error("[sdk-worker] initTheme failed:", e instanceof Error ? e.message : String(e));
      }
    })().catch((e) => {
      // Failed infra must not poison every later open: reset so the next
      // open retries instead of failing forever.
      runtimes.delete(agentDir);
      // Allow a later tab to retry after a transient initialization failure.
      if (initPromises.get(agentDir) === initPromise) initPromises.delete(agentDir);
      throw e;
    });
    initPromises.set(agentDir, initPromise);
  }
  await initPromise;
}

// --- Per-tab session --------------------------------------------------------

interface TabSession {
  tabId: string;
  runtime: AgentSessionRuntime;
  session: AgentSessionRuntime["session"];
  unsubscribe: () => void;
  pendingUi: Map<string, (r: Record<string, unknown>) => void>;
  closing: boolean;
}

const tabs = new Map<string, TabSession>();

/** Commands that arrived while a tab was still opening (boot-time
 *  get_messages/get_state from the renderer, or an early user prompt).
 *  Replayed FIFO once the session is registered — without this the worker
 *  answers "Tab session not found" and the first prompt is silently lost. */
const openingCmds = new Map<string, HostMessage[]>();

function post(m: unknown): void {
  parentPort?.postMessage(m);
}

/** Replicate upstream createExtensionUIContext (rpc-mode.js). */
function createExtensionUIContext(ts: TabSession) {
  const dialog = (opts: { signal?: AbortSignal; timeout?: number } | undefined, defaultValue: unknown, request: Record<string, unknown>, parse: (r: Record<string, unknown>) => unknown) => {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = randomUUID();
    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        ts.pendingUi.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      ts.pendingUi.set(id, (response) => {
        cleanup();
        resolve(parse(response));
      });
      post({ kind: "ui", tabId: ts.tabId, req: { type: "extension_ui_request", id, ...request } });
    });
  };
  return {
    get theme() {
      // Extensions read ctx.ui.theme (e.g. pi-rewind: theme.fg(...)). initTheme
      // stores the resolved theme on globalThis under this symbol; return it
      // so extensions see the SAME theme instance the worker initialized.
      const t = (globalThis as Record<symbol, unknown>)[
        Symbol.for("@earendil-works/pi-coding-agent:theme")
      ] as Record<string, unknown> | undefined;
      if (t) return t;
      // Fallback: never throw — a permissive identity-ish shim keeps extension
      // startup alive even if initTheme failed.
      return new Proxy({}, { get: () => (s: string) => s });
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching not supported in SDK backend" }),
    select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialog(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
        "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
      ),
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialog(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
        "cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
      ),
    input: (title: string, placeholder: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialog(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
        "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
      ),
    notify: (message: string, type?: string) => {
      post({ kind: "ui", tabId: ts.tabId, req: { type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type } });
    },
    onTerminalInput: () => () => {},
    setStatus: (key: string, text: string) => {
      post({ kind: "ui", tabId: ts.tabId, req: { type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text } });
    },
    setTitle: (title: string) => {
      post({ kind: "ui", tabId: ts.tabId, req: { type: "extension_ui_request", id: randomUUID(), method: "setTitle", title } });
    },
    editor: (title: string, prefill: string) =>
      dialog(undefined, undefined, { method: "editor", title, prefill }, (r) =>
        "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
      ),
    setEditorText: (text: string) => {
      post({ kind: "ui", tabId: ts.tabId, req: { type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text } });
    },
    pasteToEditor: (text: string) => {
      post({ kind: "ui", tabId: ts.tabId, req: { type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text } });
    },
    getEditorText: () => "",
    custom: async () => undefined,
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key: string, content: unknown, options?: Record<string, unknown>) => {
      if (content === undefined || Array.isArray(content)) {
        post({ kind: "ui", tabId: ts.tabId, req: { type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: key, widgetContent: content, ...(options ?? {}) } });
      }
    },
    setToolStatus: () => {},
    setToolsExpanded: () => {},
    getToolsExpanded: () => false,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
  };
}

async function rebindSession(ts: TabSession): Promise<void> {
  const session = ts.runtime.session;
  // NOTE: the event subscription was already installed by openTab before
  // opened was signaled; re-binding must NOT re-subscribe (that would leak
  // the previous subscription and double-post every frame).
  if (ts.session !== session) {
    ts.unsubscribe();
    ts.session = session;
    ts.unsubscribe = session.subscribe((event) => {
      try {
        post({ kind: "evt", tabId: ts.tabId, event: toJsonEvent(event) });
      } catch (e) {
        // A non-cloneable or malformed event must not kill the worker (and with
        // it every local tab). RPC mode isolates per tab; here log and drop.
        console.error(`[sdk-worker] event post failed for ${ts.tabId}:`, e instanceof Error ? e.message : String(e));
      }
    });
  }
  await session.bindExtensions({
    uiContext: createExtensionUIContext(ts) as never,
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async (options?: { parentSession?: string }) => ts.runtime.newSession(options),
      fork: async (entryId: string, forkOptions?: { position?: "at" | "after" }) => {
        const result = await ts.runtime.fork(entryId, forkOptions);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId: string, options?: { summarize?: string; customInstructions?: string; replaceInstructions?: string; label?: string }) => {
        const result = (await session.navigateTree(targetId, {
          summarize: options?.summarize,
          customInstructions: options?.customInstructions,
          replaceInstructions: options?.replaceInstructions,
          label: options?.label,
        })) as { cancelled?: boolean };
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath: string, options?: Record<string, unknown>) => ts.runtime.switchSession(sessionPath, options),
      reload: async () => {
        await session.reload();
      },
    },
    shutdownHandler: () => {
      // Not used: app owns shutdown per-tab via "close".
    },
    onError: (err: { extensionPath?: string; event?: string; error?: string }) => {
      post({ kind: "evt", tabId: ts.tabId, event: { type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error } });
    },
  });
}

// --- Command handling (mirrors upstream rpc-mode.js handleCommand) ----------

interface RpcResp {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

function success(id: string | undefined, command: string, data?: unknown): RpcResp {
  return data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data };
}
function error(id: string | undefined, command: string, message: string): RpcResp {
  return { id, type: "response", command, success: false, error: message };
}

async function handleCommand(ts: TabSession, command: Record<string, unknown>): Promise<RpcResp | undefined> {
  const id = command.id as string | undefined;
  const session = ts.session;
  switch (command.type) {
    case "prompt": {
      let preflightSucceeded = false;
      void session
        .prompt(command.message as string, {
          images: command.images as never,
          streamingBehavior: command.streamingBehavior as never,
          source: "rpc",
          preflightResult: (didSucceed: boolean) => {
            if (didSucceed) {
              preflightSucceeded = true;
              post({ kind: "resp", tabId: ts.tabId, resp: success(id, "prompt") });
            }
          },
        })
        .catch((e: Error) => {
          if (!preflightSucceeded) {
            post({ kind: "resp", tabId: ts.tabId, resp: error(id, "prompt", e.message) });
          }
        });
      return undefined;
    }
    case "steer":
      await session.steer(command.message as string, command.images as never);
      return success(id, "steer");
    case "follow_up":
      await session.followUp(command.message as string, command.images as never);
      return success(id, "follow_up");
    case "abort":
      await session.abort();
      return success(id, "abort");
    case "new_session": {
      const options = command.parentSession ? { parentSession: command.parentSession as string } : undefined;
      const result = await ts.runtime.newSession(options);
      if (!result.cancelled) await rebindSession(ts);
      return success(id, "new_session", result);
    }
    case "get_state":
      return success(id, "get_state", {
        model: session.model,
        thinkingLevel: session.thinkingLevel,
        isStreaming: session.isStreaming,
        isCompacting: session.isCompacting,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
        sessionFile: session.sessionFile,
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        autoCompactionEnabled: session.autoCompactionEnabled,
        messageCount: session.messages.length,
        pendingMessageCount: session.pendingMessageCount,
      });
    case "set_model": {
      const models = session.modelRuntime.getAvailableSnapshot();
      const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
      if (!model) return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
      await session.setModel(model);
      return success(id, "set_model", model);
    }
    case "cycle_model": {
      const result = await session.cycleModel();
      return success(id, "cycle_model", result ?? null);
    }
    case "get_available_models":
      return success(id, "get_available_models", { models: session.modelRuntime.getAvailableSnapshot() });
    case "set_thinking_level":
      session.setThinkingLevel(command.level as never);
      return success(id, "set_thinking_level");
    case "cycle_thinking_level": {
      const level = session.cycleThinkingLevel();
      return success(id, "cycle_thinking_level", level ? { level } : null);
    }
    case "get_available_thinking_levels":
      return success(id, "get_available_thinking_levels", { levels: session.getAvailableThinkingLevels() });
    case "set_steering_mode":
      session.setSteeringMode(command.mode as never);
      return success(id, "set_steering_mode");
    case "set_follow_up_mode":
      session.setFollowUpMode(command.mode as never);
      return success(id, "set_follow_up_mode");
    case "compact": {
      const result = await session.compact(command.customInstructions as string | undefined);
      return success(id, "compact", result);
    }
    case "set_auto_compaction":
      session.setAutoCompactionEnabled(command.enabled as boolean);
      return success(id, "set_auto_compaction");
    case "set_auto_retry":
      session.setAutoRetryEnabled(command.enabled as boolean);
      return success(id, "set_auto_retry");
    case "abort_retry":
      session.abortRetry();
      return success(id, "abort_retry");
    case "bash": {
      const eventResult = await session.extensionRunner.emitUserBash({
        type: "user_bash",
        command: command.command as string,
        excludeFromContext: (command.excludeFromContext as boolean) ?? false,
        cwd: session.sessionManager.getCwd(),
      });
      if (eventResult?.result) {
        session.recordBashResult(command.command as string, eventResult.result, { excludeFromContext: command.excludeFromContext as boolean | undefined });
        return success(id, "bash", eventResult.result);
      }
      const result = await session.executeBash(command.command as string, undefined, {
        excludeFromContext: command.excludeFromContext as boolean | undefined,
        id,
        operations: eventResult?.operations,
      });
      return success(id, "bash", result);
    }
    case "abort_bash":
      session.abortBash();
      return success(id, "abort_bash");
    case "get_session_stats":
      return success(id, "get_session_stats", session.getSessionStats());
    case "export_html": {
      const path = await session.exportToHtml(command.outputPath as string | undefined);
      return success(id, "export_html", { path });
    }
    case "switch_session": {
      const result = await ts.runtime.switchSession(command.sessionPath as string);
      if (!result.cancelled) await rebindSession(ts);
      return success(id, "switch_session", result);
    }
    case "fork": {
      const result = await ts.runtime.fork(command.entryId as string);
      if (!result.cancelled) await rebindSession(ts);
      return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
    }
    case "clone": {
      const leafId = session.sessionManager.getLeafId();
      if (!leafId) return error(id, "clone", "Cannot clone session: no current entry selected");
      const result = await ts.runtime.fork(leafId, { position: "at" });
      if (!result.cancelled) await rebindSession(ts);
      return success(id, "clone", { cancelled: result.cancelled });
    }
    case "get_fork_messages":
      return success(id, "get_fork_messages", { messages: session.getUserMessagesForForking() });
    case "get_entries": {
      const sessionManager = session.sessionManager;
      let entries = sessionManager.getEntries();
      if (command.since !== undefined) {
        const sinceIndex = entries.findIndex((e) => e.id === command.since);
        if (sinceIndex === -1) return error(id, "get_entries", `Entry not found: ${command.since}`);
        entries = entries.slice(sinceIndex + 1);
      }
      return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
    }
    case "get_tree":
      return success(id, "get_tree", { tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() });
    // Native session-tree navigation. Equivalent to the /tree extension
    // bridge (ctx.navigateTree) but WITHOUT routing through the prompt
    // channel: navigateTree() is an internal session operation, so nothing
    // is recorded as a user message and no agent turn is started — the
    // chat just lands at the target position and waits for user input.
    case "navigate_tree": {
      const entryId = command.entryId as string | undefined;
      if (!entryId) return error(id, "navigate_tree", "entryId is required");
      try {
        const result = await session.navigateTree(entryId, {
          summarize: command.summarize as boolean | undefined,
          customInstructions: command.customInstructions as string | undefined,
          replaceInstructions: command.replaceInstructions as boolean | undefined,
          label: command.label as string | undefined,
        });
        return success(id, "navigate_tree", result);
      } catch (e) {
        return error(id, "navigate_tree", e instanceof Error ? e.message : String(e));
      }
    }
    case "get_last_assistant_text":
      return success(id, "get_last_assistant_text", { text: session.getLastAssistantText() });
    case "set_session_name": {
      const name = (command.name as string).trim();
      if (!name) return error(id, "set_session_name", "Session name cannot be empty");
      session.setSessionName(name);
      return success(id, "set_session_name");
    }
    case "get_messages":
      return success(id, "get_messages", { messages: session.messages });
    case "get_commands": {
      const commands: Array<Record<string, unknown>> = [];
      for (const command of session.extensionRunner.getRegisteredCommands()) {
        commands.push({ name: command.invocationName, description: command.description, source: "extension", sourceInfo: command.sourceInfo });
      }
      for (const template of session.promptTemplates) {
        commands.push({ name: template.name, description: template.description, source: "prompt", sourceInfo: template.sourceInfo });
      }
      for (const skill of session.resourceLoader.getSkills().skills) {
        commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo });
      }
      return success(id, "get_commands", { commands });
    }
    case "reload": {
      await session.reload();
      return success(id, "reload");
    }
    default:
      return error(id, String(command.type ?? "unknown"), `Unknown command: ${command.type}`);
  }
}

// --- Open / close -----------------------------------------------------------

// Tabs being opened right now (registered only after infra init completes).
// A "close" arriving while an open is in flight sets a tombstone so the open
// disposes its session instead of leaking a live runtime that cross-wires
// ghost events if the tabId is reused.
const opening = new Map<string, { cancelled: boolean }>();

async function openTab(req: OpenRequest): Promise<void> {
  const startedAt = performance.now();
  const inflight = { cancelled: false };
  opening.set(req.tabId, inflight);
  try {
    const infraStartedAt = performance.now();
    await ensureSharedInfra(req.agentDir);
    const infraMs = performance.now() - infraStartedAt;

    const sessionStartedAt = performance.now();
    // SessionManager defaults to ~/.pi/agent/sessions. Pass the profile's
    // session directory explicitly so SDK tabs do not resume another profile.
    const sessionDir = join(req.agentDir, "sessions", encodeCwd(req.cwd));
    const sessionManager = req.sessionPath
      ? SessionManager.open(req.sessionPath, sessionDir, req.cwd)
      : req.continueRecent
        ? SessionManager.continueRecent(req.cwd, sessionDir)
        : SessionManager.create(req.cwd, sessionDir);
    const sessionMs = performance.now() - sessionStartedAt;

    const servicesStartedAt = performance.now();
    const createRuntime = async ({ cwd, agentDir, sessionManager: sm }: { cwd: string; agentDir: string; sessionManager: SessionManagerT }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime: runtimes.get(agentDir)!,
        // ModelRuntime is cached per agentDir so models/auth never cross profiles.
        // NOTE: agent-session-services creates its own per-cwd DefaultResource
        // Loader (the resourceLoader key is not honored) — that is correct for
        // project-scoped skills/prompts/settings, so we only share ModelRuntime.
      });
      const created = await createAgentSessionFromServices({ services, sessionManager: sm });
      return { ...created, services, diagnostics: services.diagnostics };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: req.cwd,
      agentDir: req.agentDir,
      sessionManager,
    });
    const servicesMs = performance.now() - servicesStartedAt;

    if (inflight.cancelled) {
      // Closed while opening: dispose immediately, don't register.
      try {
        await runtime.dispose();
      } catch {
        /* best effort */
      }
      post({ kind: "closed", tabId: req.tabId });
      return;
    }

    const ts: TabSession = {
      tabId: req.tabId,
      runtime,
      session: runtime.session,
      unsubscribe: () => {},
      pendingUi: new Map(),
      closing: false,
    };
    tabs.set(req.tabId, ts);
    const bindStartedAt = performance.now();
    // Fast path: install the event subscription synchronously (no extension
    // loading) and signal opened IMMEDIATELY so history renders while
    // extensions bind in the background. bindExtensions is safe to defer:
    // prompt() works without it (extensions only add tools/handlers) and the
    // session_start frames now flow through the already-installed subscription.
    ts.unsubscribe = ts.session.subscribe((event) => {
      try {
        post({ kind: "evt", tabId: ts.tabId, event: toJsonEvent(event) });
      } catch (e) {
        console.error(`[sdk-worker] event post failed for ${ts.tabId}:`, e instanceof Error ? e.message : String(e));
      }
    });
    // Replay commands that arrived while this tab was still opening (an
    // early prompt must not be lost; the renderer's boot-time get_messages
    // also benefits). Runs AFTER the event subscription is installed so a
    // replayed prompt's streamed events reach the renderer. handleCommand is
    // async but each replays independently, like normal post-registration
    // traffic.
    const queued = openingCmds.get(req.tabId);
    if (queued) {
      openingCmds.delete(req.tabId);
      for (const q of queued) {
        if (q.kind !== "cmd") continue;
        void handleCommand(ts, q.cmd)
          .then((resp) => {
            if (resp) post({ kind: "resp", tabId: req.tabId, resp });
          })
          .catch((e: Error) => {
            post({ kind: "resp", tabId: req.tabId, resp: error(q.cmd.id as string | undefined, String(q.cmd.type ?? "unknown"), e.message) });
          });
      }
    }
    void (async () => {
      try {
        await rebindSession(ts);
      } catch (e) {
        console.error(`[sdk-worker] background bind failed for ${ts.tabId}:`, e instanceof Error ? e.message : String(e));
        post({ kind: "evt", tabId: ts.tabId, event: { type: "extension_error", extensionPath: undefined, event: "bind", error: e instanceof Error ? e.message : String(e) } });
      }
    })();
    const bindMs = performance.now() - bindStartedAt;
    console.info(`[sdk/open] tab=${req.tabId} total=${(performance.now() - startedAt).toFixed(0)}ms infra=${infraMs.toFixed(0)}ms session=${sessionMs.toFixed(0)}ms runtime-services=${servicesMs.toFixed(0)}ms bind-queued=${bindMs.toFixed(0)}ms`);
    post({ kind: "opened", tabId: req.tabId });
  } finally {
    opening.delete(req.tabId);
    // The open was cancelled/failed — the tab never registered. Fail any
    // queued commands honestly instead of leaving them hanging forever.
    const queued = openingCmds.get(req.tabId);
    if (queued) {
      openingCmds.delete(req.tabId);
      for (const q of queued) {
        if (q.kind !== "cmd") continue;
        post({ kind: "resp", tabId: req.tabId, resp: error(q.cmd.id as string | undefined, String(q.cmd.type ?? "unknown"), "Tab session not found") });
      }
    }
  }
}

async function closeTab(tabId: string): Promise<void> {
  const inflight = opening.get(tabId);
  if (inflight) {
    inflight.cancelled = true;
    return;
  }
  const ts = tabs.get(tabId);
  if (!ts) return;
  ts.closing = true;
  try {
    ts.unsubscribe();
    await ts.runtime.dispose();
  } catch {
    /* best effort */
  }
  tabs.delete(tabId);
  post({ kind: "closed", tabId });
}

// --- Message loop -----------------------------------------------------------

parentPort?.on("message", (msg: HostMessage) => {
  if (msg.kind === "warm") {
    void ensureSharedInfra(msg.agentDir).catch((e) => {
      console.error("[sdk-worker] warm failed:", e instanceof Error ? e.message : String(e));
    });
    return;
  }
  if (msg.kind === "open") {
    void openTab(msg).catch((e) => post({ kind: "opened", tabId: msg.tabId, error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  if (msg.kind === "close") {
    void closeTab(msg.tabId);
    return;
  }
  if (msg.kind === "ui") {
    const ts = tabs.get(msg.tabId);
    const pending = ts?.pendingUi.get((msg.response as { id?: string }).id ?? "");
    if (pending) {
      ts!.pendingUi.delete((msg.response as { id?: string }).id ?? "");
      pending(msg.response);
    }
    return;
  }
  if (msg.kind === "cmd") {
    const ts = tabs.get(msg.tabId);
    const route = decideCmdRouting({
      registered: !!ts,
      closing: !!ts?.closing,
      opening: opening.has(msg.tabId),
    });
    if (route === "queue") {
      // Tab still opening — queue instead of dropping (the renderer's
      // boot-time get_messages/get_state and an early prompt would
      // otherwise be lost to "Tab session not found").
      const list = openingCmds.get(msg.tabId);
      if (list) {
        if (queueAtCapacity(list.length)) {
          post({ kind: "resp", tabId: msg.tabId, resp: error(msg.cmd.id as string | undefined, String(msg.cmd.type ?? "unknown"), "command queue overflow") });
        } else {
          list.push(msg);
        }
      } else {
        openingCmds.set(msg.tabId, [msg]);
      }
      return;
    }
    if (route === "drop") {
      post({ kind: "resp", tabId: msg.tabId, resp: error(msg.cmd.id as string | undefined, String(msg.cmd.type ?? "unknown"), "Tab session not found") });
      return;
    }
    // route === "run" ⇒ the tab is registered and not closing; the routing
    // helper can't narrow `ts` for us (separate function call), assert here.
    const tsRegistered = ts!;
    void handleCommand(tsRegistered, msg.cmd)
      .then((resp) => {
        if (resp) post({ kind: "resp", tabId: msg.tabId, resp });
      })
      .catch((e: Error) => {
        post({ kind: "resp", tabId: msg.tabId, resp: error(msg.cmd.id as string | undefined, String(msg.cmd.type ?? "unknown"), e.message) });
      });
    return;
  }
});

// Signal readiness as soon as the script is loaded (infra init is async and
// reported via the first "opened" — SdkHost waits for that before routing).
post({ kind: "ready" });
