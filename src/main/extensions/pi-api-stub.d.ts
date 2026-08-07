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
    ui: {
      setWorkingIndicator(options?: WorkingIndicatorOptions): void;
      notify(message: string, type?: "info" | "warning" | "error"): Promise<void>;
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
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    // full context surface (ui etc. covered by ExtensionContext)
  }

  export interface ExtensionAPI {
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>
    ): void;
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
      }
    ): void;
  }
}
