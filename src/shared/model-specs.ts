/**
 * MODEL_SPECS — default context-window / max-tokens hints for known models.
 *
 * The OpenAI-compatible `/models` endpoint does NOT report context length, so
 * "auto" here means: (1) look up a well-known model by id, (2) fall back to a
 * conservative default. Real configured values in ~/.pi/agent/models.json are
 * ALWAYS preserved on save (see syncModelToPi) — this table only fills gaps.
 *
 * Values: high-confidence public specs + specs verified in the wild. When in
 * doubt we stay conservative (128K/16K) rather than inventing big numbers —
 * pi uses these for token accounting.
 */

export interface ModelSpec {
  contextWindow: number;
  maxTokens: number;
}

export const DEFAULT_MODEL_SPEC: ModelSpec = { contextWindow: 128000, maxTokens: 16384 };

/** Exact-id lookups (lowercased keys). */
const MODEL_SPECS: Record<string, ModelSpec> = {
  // OpenAI public (128k context / 16k output)
  "gpt-4o": { contextWindow: 128000, maxTokens: 16384 },
  "gpt-4o-mini": { contextWindow: 128000, maxTokens: 16384 },
  "gpt-4.1": { contextWindow: 1000000, maxTokens: 32768 },
  // gpt-5 line — endpoint-dependent; use verified common values
  "gpt-5.5": { contextWindow: 200000, maxTokens: 64003 },
  "gpt-5.4": { contextWindow: 128000, maxTokens: 16384 },
  "gpt-5.3-codex": { contextWindow: 128000, maxTokens: 16384 },
  "gpt-5.2": { contextWindow: 128000, maxTokens: 16384 },
  // DeepSeek official
  "deepseek-chat": { contextWindow: 128000, maxTokens: 8192 },
  "deepseek-reasoner": { contextWindow: 128000, maxTokens: 8192 },
  "deepseek-v4-flash": { contextWindow: 1000000, maxTokens: 384000 },
  "deepseek-v4-pro": { contextWindow: 1000000, maxTokens: 384000 },
  // Anthropic public (200k context / 64k output)
  "claude-opus-4-6": { contextWindow: 200000, maxTokens: 64000 },
  "claude-opus-4-7": { contextWindow: 200000, maxTokens: 64000 },
  "claude-opus-4-8": { contextWindow: 200000, maxTokens: 64000 },
  "claude-sonnet-4-6": { contextWindow: 200000, maxTokens: 64000 },
};

/** Family prefixes — only for families whose values are uniform. */
const FAMILY_PREFIX_SPECS: Array<[string, ModelSpec]> = [
  ["claude-", { contextWindow: 200000, maxTokens: 64000 }],
];

export function specForModel(modelId: string): ModelSpec {
  const key = modelId.trim().toLowerCase();
  if (!key) return DEFAULT_MODEL_SPEC;
  const exact = MODEL_SPECS[key];
  if (exact) return exact;
  for (const [prefix, spec] of FAMILY_PREFIX_SPECS) {
    if (key.startsWith(prefix)) return spec;
  }
  return DEFAULT_MODEL_SPEC;
}

/** 128000 → "128K", 1000000 → "1M", 0/undefined → "?" */
export function formatTokens(n?: number): string {
  if (!n || n <= 0) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}
