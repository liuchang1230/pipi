/**
 * Minimal type stub for `@earendil-works/pi-coding-agent` used ONLY by the
 * app-bundled extension sources (src/main/extensions/). At runtime those
 * files are loaded by pi itself, which resolves the real package from its
 * own install — the app never bundles or imports it.
 *
 * This file is the inventory of the pi surface we admit to depending on:
 * every member here must match the real package (checked against pi
 * 0.85.1's dist/core/extensions/types.d.ts), and a member that is no longer
 * used by any shipped extension should be removed, not kept "just in case".
 */
declare module "@earendil-works/pi-coding-agent" {
  export interface WorkingIndicatorOptions {
    frames?: string[];
    intervalMs?: number;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    /** Working directory of the session (docs/extensions.md 「ctx.cwd」). Used by
     *  the approval gate to spot a write that leaves the project. */
    cwd: string;
    ui: {
      setWorkingIndicator(options?: WorkingIndicatorOptions): void;
      notify(message: string, type?: "info" | "warning" | "error"): Promise<void>;
      /** Dialogs resolve via the extension_ui sub-protocol (rpc.md).
       *
       *  `opts.timeout` (ms) auto-dismisses with a countdown but returns the SAME
       *  value as a user cancel; pass `opts.signal` instead to tell "the user said
       *  no" from "nobody was there" (docs/extensions.md 「Return values on
       *  timeout」). The approval gate needs that distinction, so it uses signal. */
      select(title: string, options: string[]): Promise<string | undefined>;
      /** Text input dialog (docs/extensions.md 「ctx.ui.input」). Resolves
       *  undefined when dismissed — ask_user_question treats that as
       *  "abandon the questionnaire". */
      input(title: string, placeholder?: string): Promise<string | undefined>;
      confirm(title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<boolean>;
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

  /** Subset of pi's ToolDefinition we use (docs/extensions.md 「Custom
   *  Tools」). `parameters` is a plain JSON Schema object: pi-ai's
   *  validateToolArguments explicitly supports schemas without the
   *  TypeBox.Kind symbol (coerceWithJsonSchema branch), and typebox is not
   *  resolvable from this repo, so a TypeBox import would make the shipped
   *  file untestable. execute() receives UNVALIDATED raw args — normalize
   *  and validate before use. */
  export interface ExtensionToolDefinition {
    name: string;
    label?: string;
    description: string;
    /** One-line entry in the system prompt's "Available tools" section. */
    promptSnippet?: string;
    parameters: Record<string, unknown>;
    /** "sequential": must not run concurrently with other tool calls
     *  (docs/extensions.md 「executionMode」). */
    executionMode?: "sequential" | "parallel";
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate:
        | ((content: { type: "text"; text: string; [key: string]: unknown }) => void)
        | undefined,
      ctx: ExtensionContext
    ): Promise<{
      content: Array<{ type: "text"; text: string; [key: string]: unknown }>;
      details?: unknown;
    }>;
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
    /** Tools visible to the LLM, built-in and extension-registered
     *  (docs/extensions.md 「pi.getAllTools()」). ask_user_question reads only
     *  `name` — to decide whether ANOTHER provider already ships the
     *  ask_user_question tool, in which case we stay out of the way. */
    getAllTools(): Array<{ name: string }>;
    registerTool(tool: ExtensionToolDefinition): void;
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
