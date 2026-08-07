export type PiApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type PiInputType = "text" | "image";

export interface PiCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<{
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }>;
}

export interface ModelEditorSpec {
  name?: string;
  api?: PiApi;
  reasoning?: boolean;
  input?: PiInputType[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  samplingParams?: Record<string, unknown>;
  cost?: PiCost;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ProviderEditorConfig {
  api?: PiApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  oauth?: string;
  compat?: Record<string, unknown>;
}
