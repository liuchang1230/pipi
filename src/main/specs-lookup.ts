/**
 * Model-spec lookup over the network (best-effort).
 *
 * OpenAI-compatible `/models` endpoints do not report context length, but
 * OpenRouter's public model catalog does (free, no API key). We query it for
 * model ids the local spec table / existing config doesn't cover, cache the
 * whole catalog for 24h, and fail silently offline — saving never blocks on
 * the network beyond a short timeout.
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface SpecHints {
  contextWindow?: number;
  maxTokens?: number;
}

interface OpenRouterModel {
  id?: string;
  context_length?: number;
  max_completion_tokens?: number;
  top_provider?: { max_completion_tokens?: number };
}

interface CacheShape {
  fetchedAt: number;
  models: Record<string, SpecHints>;
}

let cache: { fetchedAt: number; entries: Map<string, SpecHints> } | null = null;

function cachePath(): string {
  return join(app.getPath("userData"), "openrouter-models-cache.json");
}

function loadCache(): { fetchedAt: number; entries: Map<string, SpecHints> } {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as CacheShape;
    if (raw && typeof raw.fetchedAt === "number" && raw.models && typeof raw.models === "object") {
      cache = { fetchedAt: raw.fetchedAt, entries: new Map(Object.entries(raw.models)) };
      return cache;
    }
  } catch {
    /* first run / corrupt cache */
  }
  cache = { fetchedAt: 0, entries: new Map() };
  return cache;
}

function persistCache(c: { fetchedAt: number; entries: Map<string, SpecHints> }): void {
  try {
    const file = cachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ fetchedAt: c.fetchedAt, models: Object.fromEntries(c.entries) }, null, 2), "utf8");
  } catch {
    /* best effort */
  }
}

async function refreshCatalog(c: { fetchedAt: number; entries: Map<string, SpecHints> }): Promise<void> {
  if (Date.now() - c.fetchedAt < CACHE_TTL_MS) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const payload = (await res.json()) as { data?: OpenRouterModel[] };
    for (const model of payload.data ?? []) {
      if (!model?.id) continue;
      const hints: SpecHints = {};
      if (typeof model.context_length === "number" && model.context_length > 0) hints.contextWindow = model.context_length;
      // OpenRouter moved max output into top_provider; older field as fallback.
      const maxTokens = model.top_provider?.max_completion_tokens ?? model.max_completion_tokens;
      if (typeof maxTokens === "number" && maxTokens > 0) hints.maxTokens = maxTokens;
      if (Object.keys(hints).length > 0) c.entries.set(model.id, hints);
    }
    c.fetchedAt = Date.now();
    persistCache(c);
  } catch {
    /* offline / blocked — fall back to local spec table */
  }
}

function matchEntry(entries: Map<string, SpecHints>, id: string): SpecHints | undefined {
  const exact = entries.get(id);
  if (exact) return exact;
  // OpenRouter ids carry a provider prefix (openai/gpt-4o, z-ai/glm-4.5);
  // users type bare ids. Match by suffix, e.g. "gpt-4o" → "openai/gpt-4o".
  for (const [key, hints] of entries) {
    if (key.endsWith(`/${id}`)) return hints;
  }
  return undefined;
}

/** Best-effort lookup for model ids; only ids missing from cache trigger a
 *  refresh. Never throws. */
export async function lookupModelSpecs(ids: string[], timeoutMs = FETCH_TIMEOUT_MS): Promise<Record<string, SpecHints>> {
  const c = loadCache();
  const missing = ids.filter((id) => id && !c.entries.has(id));
  if (missing.length > 0) await refreshCatalog(c);
  const result: Record<string, SpecHints> = {};
  for (const id of ids) {
    const hints = matchEntry(c.entries, id);
    if (hints) result[id] = hints;
  }
  return result;
}
