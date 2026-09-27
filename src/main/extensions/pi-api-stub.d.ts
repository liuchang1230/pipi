/**
 * Minimal type stub for `@earendil-works/pi-coding-agent` used ONLY by the
 * app-bundled extension sources (src/main/extensions/). At runtime those
 * files are loaded by pi itself, which resolves the real package from its
 * own install — the app never bundles or imports it.
 */
declare module "@earendil-works/pi-coding-agent" {
  export interface WorkingIndicatorOptions {
    frames?: string[];
    intervalMs?: number;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    ui: {
      setWorkingIndicator(options?: WorkingIndicatorOptions): void;
      notify(message: string, type?: "info" | "warning" | "error"): Promise<void>;
      /** Dialogs resolve via the extension_ui sub-protocol (rpc.md). */
      select(title: string, options: string[]): Promise<string | undefined>;
      confirm(title: string, message: string): Promise<boolean>;
      editor(title: string, prefill?: string): Promise<string | undefined>;
      setStatus(key: string, text: string | undefined): void;
      setWidget(key: string, content: string[] | undefined): void;
      theme: {
        fg(color: string, text: string): string;
        strikethrough(text: string): string;
      };
    };
    /** Model registry facade: ctx.modelRegistry.refresh() re-reads
     *  models.json/auth.json into the RUNNING session (used by
     *  pipi-model-sync; mirrors pi's core ModelRegistry API). */
    modelRegistry: {
      refresh(options?: { allowNetwork?: boolean; providers?: readonly string[]; signal?: AbortSignal }): Promise<{
        aborted: boolean;
        errors: ReadonlyMap<string, Error>;
      }>;
    };
    /** Navigate to a different point in the session tree (TUI /tree action). */
    navigateTree(
      targetId: string,
      options?: {
        summarize?: boolean;
        customInstructions?: string;
        replaceInstructions?: boolean;
        label?: string;
      }
    ): Promise<{ cancelled: boolean }>;
    /** Session store: persisted entries of the current session. */
    sessionManager: {
      getEntries(): Array<Record<string, unknown>>;
    };
  }

  export interface ExtensionAPI {
    /* Events may return control objects (tool_call block, context/before_agent
       start message overrides) — pi reads the awaited result. */
    on<TEvent = any>(
      event: string,
      handler: (event: TEvent, ctx: ExtensionContext) => unknown
    ): void;
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
      }
    ): void;
    registerShortcut(
      shortcut: string,
      options: {
        description?: string;
        handler: (ctx: ExtensionContext) => void | Promise<void>;
      }
    ): void;
    /** pi supports string flags (`--x value`) and boolean flags (`--x`). */
    registerFlag(
      name: string,
      options:
        | { description?: string; type: "string"; default?: string }
        | { description?: string; type: "boolean"; default?: boolean }
    ): void;
    getFlag(name: string): boolean | string | undefined;
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
    appendEntry(customType: string, data?: unknown): void;
    sendMessage(
      message: { customType: string; content: string; display: boolean },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
    ): void;
    sendUserMessage(
      content: string,
      options?: { deliverAs?: "steer" | "followUp" }
    ): void;
  }
}
