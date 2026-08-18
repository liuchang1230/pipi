/**
 * Ambient declarations for @earendil-works/pi-coding-agent (SDK backend).
 *
 * The package ships .d.ts files whose internal imports use `.ts` specifiers;
 * under tsconfig's `composite` mode those resolve to missing files and the
 * whole package looks like it has no exports. We only touch a small, stable
 * slice of the SDK here, so declare it explicitly instead of fighting the
 * package's declaration graph.
 */
declare module "@earendil-works/pi-coding-agent" {
  export class ModelRuntime {
    static create(): Promise<ModelRuntime>;
    modelRegistry: unknown;
    refresh(opts: { signal: AbortSignal }): Promise<unknown>;
    getAvailableSnapshot(): Array<{ id: string; provider: string; name?: string; [k: string]: unknown }>;
  }

  export class DefaultResourceLoader {
    constructor(opts: { cwd: string; agentDir: string; modelRegistry?: unknown; settingsManager?: SettingsManager });
    reload(): Promise<void>;
    getSkills(): { skills: Array<{ name: string; description?: string; sourceInfo?: unknown }> };
    getPrompts(): { prompts: Array<{ name: string; description?: string; sourceInfo?: unknown }> };
    getExtensions(): { extensions: Array<unknown>; errors: Array<{ path?: string; error?: string }> };
  }

  export class SettingsManager {
    static create(cwd: string, agentDir?: string): SettingsManager;
    getTheme(): string | undefined;
  }

  export class SessionManager {
    static create(cwd: string, sessionDir?: string): SessionManager;
    static continueRecent(cwd: string, sessionDir?: string): SessionManager;
    static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
    getCwd(): string;
    getLeafId(): string | null;
    getEntries(): Array<{ id: string; [k: string]: unknown }>;
    getTree(): Array<unknown>;
    buildSessionContext(): { messages: Array<unknown> };
  }

  export interface AgentSessionServices {
    cwd: string;
    agentDir: string;
    modelRuntime: ModelRuntime;
    settingsManager: SettingsManager;
    resourceLoader: DefaultResourceLoader;
    diagnostics: Array<{ type: string; message: string }>;
  }

  export interface AgentSessionRuntime {
    session: AgentSession;
    services: AgentSessionServices;
    dispose(): Promise<void>;
    newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }>;
    switchSession(sessionPath: string, options?: Record<string, unknown>): Promise<{ cancelled: boolean }>;
    fork(entryId: string, options?: { position?: "at" | "after" }): Promise<{ cancelled: boolean; selectedText?: string }>;
    setRebindSession(cb: (session: AgentSession) => Promise<void>): void;
  }

  export interface AgentSession {
    id: string;
    model: { id: string; provider: string; name?: string; [k: string]: unknown } | null;
    thinkingLevel: string | null;
    isStreaming: boolean;
    isCompacting: boolean;
    steeringMode: string;
    followUpMode: string;
    sessionFile: string | null;
    sessionId: string;
    sessionName: string | null;
    autoCompactionEnabled: boolean;
    messages: Array<unknown>;
    pendingMessageCount: number;
    promptTemplates: Array<{ name: string; description?: string; sourceInfo?: unknown }>;
    modelRuntime: ModelRuntime;
    sessionManager: SessionManager;
    resourceLoader: DefaultResourceLoader;
    extensionRunner: {
      getRegisteredCommands(): Array<{ invocationName: string; description?: string; sourceInfo?: unknown }>;
      emitUserBash(opts: unknown): Promise<{ result?: unknown; operations?: unknown } | undefined>;
    };
    subscribe(cb: (event: unknown) => void): () => void;
    bindExtensions(bindings: Record<string, unknown>): Promise<void>;
    prompt(message: string, opts?: Record<string, unknown>): Promise<unknown>;
    steer(message: string, images?: unknown): Promise<unknown>;
    followUp(message: string, images?: unknown): Promise<unknown>;
    abort(): Promise<unknown>;
    setModel(model: unknown): Promise<unknown>;
    cycleModel(): Promise<unknown>;
    setThinkingLevel(level: string): void;
    cycleThinkingLevel(): string | null;
    getAvailableThinkingLevels(): Array<string>;
    setSteeringMode(mode: string): void;
    setFollowUpMode(mode: string): void;
    compact(customInstructions?: string): Promise<unknown>;
    setAutoCompactionEnabled(enabled: boolean): void;
    setAutoRetryEnabled(enabled: boolean): void;
    abortRetry(): void;
    executeBash(command: string, cwd?: string, opts?: Record<string, unknown>): Promise<unknown>;
    abortBash(): void;
    getSessionStats(): unknown;
    exportToHtml(outputPath?: string): Promise<string>;
    getUserMessagesForForking(): Array<unknown>;
    getLastAssistantText(): string;
    setSessionName(name: string): void;
    waitForIdle(): Promise<unknown>;
    navigateTree(targetId: string, opts?: Record<string, unknown>): Promise<unknown>;
    reload(): Promise<unknown>;
    recordBashResult(command: string, result: unknown, opts?: Record<string, unknown>): void;
  }

  export function createAgentSessionServices(options: Record<string, unknown>): Promise<AgentSessionServices>;
  export function createAgentSessionFromServices(options: Record<string, unknown>): Promise<{ session: AgentSession; extensionsResult: unknown; modelFallbackMessage?: string }>;
  export function initTheme(themeName?: string, enableWatcher?: boolean): void;
  export function createAgentSessionRuntime(
    factory: (opts: { cwd: string; agentDir: string; sessionManager: SessionManager }) => Promise<{
      session: AgentSession;
      services: AgentSessionServices;
      diagnostics: Array<{ type: string; message: string }>;
    }>,
    opts: { cwd: string; agentDir: string; sessionManager: SessionManager },
  ): Promise<AgentSessionRuntime>;
}
