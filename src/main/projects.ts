import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { specForModel } from "../shared/model-specs";
import type { SpecHints } from "./specs-lookup";
import type { ModelEditorSpec, PiApi, ProviderEditorConfig } from "../shared/model-config-types";

export interface PiProviderModelEntry extends ModelEditorSpec {
  id: string;
}

export interface PiProviderConfigEntry extends ProviderEditorConfig {
  baseUrl: string;
  api: PiApi;
  apiKey?: string;
  models: PiProviderModelEntry[];
}

export interface PiModelsFile {
  providers: Record<string, PiProviderConfigEntry>;
}

export type ProjectEntry =
  | { id: string; type: "local"; name: string; cwd: string; createdAt: number; updatedAt: number }
  | { id: string; type: "remote"; name: string; host: string; user: string; port: number; path: string; password?: string; agentDir?: string; createdAt: number; updatedAt: number }
  | { id: string; type: "wsl"; name: string; distro: string; path: string; createdAt: number; updatedAt: number };

export interface ModelConfigEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
  availableModels?: string[];
  /** Primary model's spec — auto-filled from the spec table / existing pi
   *  config so the UI can show what pi will use. */
  contextWindow?: number;
  maxTokens?: number;
  /** Provider-level Pi settings. */
  providerConfig?: ProviderEditorConfig;
  /** Per-model Pi settings, including input capabilities. */
  modelSpecs?: Record<string, ModelEditorSpec>;
  createdAt: number;
  updatedAt: number;
}

function projectsPath(): string {
  return join(app.getPath("userData"), "projects.json");
}

function modelsPath(): string {
  return join(app.getPath("userData"), "models.json");
}

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(app.getPath("home"), ".pi", "agent");
}

function piModelsPath(): string {
  return join(piAgentDir(), "models.json");
}

function readProjects(): ProjectEntry[] {
  const file = projectsPath();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeProjects(projects: ProjectEntry[]): void {
  const file = projectsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(projects, null, 2), "utf8");
}

function readModels(): ModelConfigEntry[] {
  const file = modelsPath();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeModels(models: ModelConfigEntry[]): void {
  const file = modelsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(models, null, 2), "utf8");
}

function readPiModelsFile(): PiModelsFile {
  const file = piModelsPath();
  if (!existsSync(file)) return { providers: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object"
      ? raw as PiModelsFile
      : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

function writePiModelsFile(config: PiModelsFile): void {
  const file = piModelsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
}

function piAuthPath(): string {
  return join(piAgentDir(), "auth.json");
}

function readPiAuthFile(): Record<string, { type: string; key?: string; env?: Record<string, string> }> {
  const file = piAuthPath();
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw as Record<string, { type: string; key?: string; env?: Record<string, string> }> : {};
  } catch {
    return {};
  }
}

function writePiAuthFile(auth: Record<string, { type: string; key?: string; env?: Record<string, string> }>): void {
  const file = piAuthPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(auth, null, 2), "utf8");
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

function projectNameFromPath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/$/, "");
  return clean.split("/").pop() || clean;
}

export function listProjects(): ProjectEntry[] {
  return readProjects().sort((a, b) => a.name.localeCompare(b.name));
}

export function addLocalProject(cwd: string): ProjectEntry {
  const projects = readProjects();
  const now = Date.now();
  const existing = projects.find((p) => p.type === "local" && p.cwd === cwd);
  if (existing) return existing;
  const entry: ProjectEntry = {
    id: `local-${now}`,
    type: "local",
    name: projectNameFromPath(cwd),
    cwd,
    createdAt: now,
    updatedAt: now,
  };
  projects.push(entry);
  writeProjects(projects);
  return entry;
}

export function addRemoteProject(remote: { host: string; user: string; port?: number; path: string; password?: string; agentDir?: string }): ProjectEntry {
  const projects = readProjects();
  const now = Date.now();
  const port = remote.port ?? 22;
  const existing = projects.find((p) => p.type === "remote" && p.host === remote.host && p.user === remote.user && p.port === port && p.path === remote.path);
  if (existing) return existing;
  const entry: ProjectEntry = {
    id: `remote-${now}`,
    type: "remote",
    name: projectNameFromPath(remote.path),
    host: remote.host,
    user: remote.user,
    port,
    path: remote.path,
    password: remote.password,
    agentDir: remote.agentDir,
    createdAt: now,
    updatedAt: now,
  };
  projects.push(entry);
  writeProjects(projects);
  return entry;
}

export function addWslProject(distro: string, path: string): ProjectEntry {
  const projects = readProjects();
  const now = Date.now();
  const resolvedPath = path || "~";
  const existing = projects.find((p) => p.type === "wsl" && p.distro === distro && p.path === resolvedPath);
  if (existing) return existing;
  const name = distro === resolvedPath || resolvedPath === "~" ? distro : `${distro}:${projectNameFromPath(resolvedPath)}`;
  const entry: ProjectEntry = {
    id: `wsl-${now}`,
    type: "wsl",
    name,
    distro,
    path: resolvedPath,
    createdAt: now,
    updatedAt: now,
  };
  projects.push(entry);
  writeProjects(projects);
  return entry;
}

export function deleteProject(id: string): boolean {
  const projects = readProjects();
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return false;
  writeProjects(next);
  return true;
}

function piProviderToModelEntry(provider: string, cfg: PiProviderConfigEntry, existing?: ModelConfigEntry): ModelConfigEntry | null {
  const modelIds = (cfg.models ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (!cfg.baseUrl && modelIds.length === 0) return null;
  const now = existing?.updatedAt ?? existing?.createdAt ?? 0;
  // models.json may hold a "placeholder" sentinel for keyless entries; the
  // real key lives in auth.json (if any). Never surface the sentinel.
  const auth = readPiAuthFile();
  const realKey = auth[provider]?.key;
  const cfgKey = cfg.apiKey && cfg.apiKey !== "placeholder" ? cfg.apiKey : undefined;
  const primaryId = existing?.model || modelIds[0] || "";
  const primaryCfg = cfg.models?.find((m) => m.id === primaryId);
  const primarySpec = specForModel(primaryId);
  const modelSpecs: Record<string, { contextWindow?: number; maxTokens?: number }> = {};
  for (const model of cfg.models ?? []) {
    if (!model?.id) continue;
    // Only explicitly-configured values go here; unset fields stay undefined
    // so the dialog's auto-fill (spec table / network) still applies on save.
    const entry: ModelEditorSpec = { ...model };
    delete (entry as { id?: string }).id;
    if (Object.keys(entry).length === 0) continue;
    if (Object.keys(entry).length > 0) modelSpecs[model.id] = entry;
  }
  return {
    id: existing?.id ?? `pi-${provider}`,
    name: existing?.name || provider,
    baseUrl: existing?.baseUrl || cfg.baseUrl || "",
    apiKey: existing?.apiKey ?? realKey ?? cfgKey,
    model: primaryId,
    provider,
    availableModels: Array.from(new Set([...(existing?.availableModels ?? []), ...modelIds].map((id) => id.trim()).filter(Boolean))),
    contextWindow: existing?.contextWindow ?? primaryCfg?.contextWindow ?? (primaryId ? primarySpec.contextWindow : undefined),
    maxTokens: existing?.maxTokens ?? primaryCfg?.maxTokens ?? (primaryId ? primarySpec.maxTokens : undefined),
    providerConfig: {
      api: cfg.api,
      headers: cfg.headers,
      authHeader: cfg.authHeader,
      oauth: cfg.oauth,
      compat: cfg.compat,
    },
    modelSpecs: { ...modelSpecs, ...(existing?.modelSpecs ?? {}) },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function listModels(): ModelConfigEntry[] {
  const appModels = readModels();
  const byProvider = new Map(appModels.map((m) => [m.provider?.trim() || "", m]));
  const merged = [...appModels];
  const piModels = readPiModelsFile();
  for (const [provider, cfg] of Object.entries(piModels.providers)) {
    const existing = byProvider.get(provider);
    const entry = piProviderToModelEntry(provider, cfg, existing);
    if (!entry) continue;
    if (existing) {
      Object.assign(existing, entry);
    } else {
      merged.push(entry);
    }
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt || (a.provider || a.name).localeCompare(b.provider || b.name));
}

export function addModel(input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }): ModelConfigEntry {
  const models = readModels();
  const now = Date.now();
  const normalizedBaseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const normalizedModel = input.model.trim();
  const normalizedName = input.name.trim() || normalizedModel;
  const existing = models.find((m) => m.baseUrl === normalizedBaseUrl && m.model === normalizedModel && (m.provider || "") === (input.provider || ""));
  if (existing) {
    existing.name = normalizedName;
    existing.apiKey = input.apiKey;
    existing.availableModels = input.availableModels;
    existing.providerConfig = input.providerConfig;
    existing.modelSpecs = input.modelSpecs;
    existing.updatedAt = now;
    writeModels(models);
    return existing;
  }
  const entry: ModelConfigEntry = {
    id: `model-${now}`,
    name: normalizedName,
    baseUrl: normalizedBaseUrl,
    apiKey: input.apiKey,
    model: normalizedModel,
    provider: input.provider?.trim() || undefined,
    availableModels: input.availableModels,
    providerConfig: input.providerConfig,
    modelSpecs: input.modelSpecs,
    createdAt: now,
    updatedAt: now,
  };
  models.push(entry);
  writeModels(models);
  return entry;
}

export function updateModel(id: string, input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[]; providerConfig?: ProviderEditorConfig; modelSpecs?: Record<string, ModelEditorSpec> }): ModelConfigEntry {
  const models = readModels();
  let target = models.find((m) => m.id === id);
  // Pi-native providers live only in ~/.pi/agent/models.json — import them
  // into the app cache on first edit so update/sync work uniformly.
  if (!target && id.startsWith("pi-")) {
    const providerName = id.slice(3);
    const piModels = readPiModelsFile();
    const cfg = piModels.providers[providerName];
    const imported = cfg ? piProviderToModelEntry(providerName, cfg) : null;
    if (imported) {
      target = { ...imported, id };
      models.push(target);
    }
  }
  if (!target) throw new Error("模型配置不存在");
  const oldProvider = target.provider?.trim();
  const normalizedBaseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const normalizedModel = input.model.trim();
  const normalizedProvider = input.provider?.trim() || undefined;
  if (!normalizedBaseUrl) throw new Error("Base URL 必填");
  if (!normalizedModel) throw new Error("模型 ID 必填");
  const duplicate = models.find((m) => m.id !== id && m.baseUrl === normalizedBaseUrl && m.model === normalizedModel && (m.provider || "") === (normalizedProvider || ""));
  if (duplicate) throw new Error("已有相同模型配置");
  target.name = input.name.trim() || normalizedModel;
  target.baseUrl = normalizedBaseUrl;
  target.apiKey = input.apiKey;
  target.model = normalizedModel;
  target.provider = normalizedProvider;
  target.availableModels = input.availableModels;
  target.providerConfig = input.providerConfig;
  target.modelSpecs = input.modelSpecs;
  target.updatedAt = Date.now();
  writeModels(models);
  if (oldProvider && oldProvider !== normalizedProvider) {
    const piModels = readPiModelsFile();
    delete piModels.providers[oldProvider];
    writePiModelsFile(piModels);
  }
  return target;
}

export function deleteModel(id: string): boolean {
  const models = readModels();
  const target = models.find((m) => m.id === id);
  const next = models.filter((m) => m.id !== id);
  if (next.length === models.length) {
    // Pi-native provider not in the app cache — remove it from pi's models
    // file directly so the list refresh picks up the deletion.
    if (id.startsWith("pi-")) {
      const piModels = readPiModelsFile();
      const providerName = id.slice(3);
      if (piModels.providers[providerName]) {
        delete piModels.providers[providerName];
        writePiModelsFile(piModels);
        return true;
      }
    }
    return false;
  }
  writeModels(next);
  if (target?.provider) {
    const piModels = readPiModelsFile();
    delete piModels.providers[target.provider];
    writePiModelsFile(piModels);
  }
  return true;
}

export function syncModelToPi(input: ModelConfigEntry, overrides?: Record<string, SpecHints>): void {
  const providerId = input.provider?.trim();
  if (!providerId) return;
  const selectedId = input.model.trim();
  const discovered = (input.availableModels ?? []).map((id) => id.trim()).filter(Boolean);
  const modelIds = Array.from(new Set([selectedId, ...discovered]));
  const piModels = readPiModelsFile();
  // Preserve existing per-model fields (contextWindow/maxTokens/cost/...) so
  // an edit never downgrades what pi already had; network-overridden specs
  // and the local table fill gaps only.
  const prevModels = piModels.providers[providerId]?.models ?? [];
  const models = modelIds.map((id) => {
    const prev = prevModels.find((m) => m.id === id);
    const spec = specForModel(id);
    const override = overrides?.[id];
    const manual = input.modelSpecs?.[id];
    return {
      ...prev,
      id,
      name: manual?.name ?? prev?.name ?? id,
      reasoning: manual?.reasoning ?? prev?.reasoning ?? /gpt-5|o1|o3|o4|deepseek-r|deepseek-v4|claude|gemini-2\.5/i.test(id),
      ...(manual?.thinkingLevelMap
        ? { thinkingLevelMap: manual.thinkingLevelMap }
        : prev?.thinkingLevelMap
        ? { thinkingLevelMap: prev.thinkingLevelMap }
        : /deepseek-v4-(flash|pro)/i.test(id)
        ? { thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", max: "max" } }
        : {}),
      input: manual?.input ?? prev?.input ?? ["text"] as Array<"text" | "image">,
      contextWindow: manual?.contextWindow ?? prev?.contextWindow ?? override?.contextWindow ?? spec.contextWindow,
      maxTokens: manual?.maxTokens ?? prev?.maxTokens ?? override?.maxTokens ?? spec.maxTokens,
      cost: manual?.cost ?? prev?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });
  piModels.providers[providerId] = {
    ...piModels.providers[providerId],
    baseUrl: input.baseUrl,
    api: input.providerConfig?.api ?? piModels.providers[providerId]?.api ?? "openai-completions",
    apiKey: input.apiKey || "placeholder",
    authHeader: input.providerConfig?.authHeader ?? piModels.providers[providerId]?.authHeader ?? true,
    ...(input.providerConfig?.headers ? { headers: input.providerConfig.headers } : {}),
    ...(input.providerConfig?.oauth ? { oauth: input.providerConfig.oauth } : {}),
    ...(input.providerConfig?.compat ? { compat: input.providerConfig.compat } : {}),
    models,
  };
  writePiModelsFile(piModels);
  const trimmedKey = input.apiKey?.trim();
  if (trimmedKey && trimmedKey !== "placeholder") {
    const auth = readPiAuthFile();
    auth[providerId] = { type: "api_key", key: trimmedKey };
    writePiAuthFile(auth);
  }
}

/** Ask pi whether it recognises the provider/model. The old spawnSync of
 *  `pi.cmd --list-models` blocked the main thread ~1s on every 验证 click —
 *  async now (with a 15s cap so a hung pi never leaks an in-flight call). */
export async function checkPiModelSync(providerId: string, modelId: string): Promise<{ ok: boolean; piModelsPath: string; providerExists: boolean; modelExists: boolean; listModelsContains: boolean; error?: string }> {
  const normalizedProvider = providerId.trim();
  const normalizedModel = modelId.trim();
  const piModels = readPiModelsFile();
  const provider = piModels.providers[normalizedProvider];
  const providerExists = !!provider;
  const modelExists = !!provider?.models?.some((m) => m.id === normalizedModel);
  try {
    const { stdout, stderr, code, error } = await new Promise<{ stdout: string; stderr: string; code: number | string | null; error?: Error }>((resolve) => {
      execFile(
        "cmd.exe",
        ["/d", "/c", "pi.cmd", "--list-models"],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDir() },
          timeout: 15000,
        },
        (err, out, errOut) => {
          resolve({
            stdout: out ?? "",
            stderr: errOut ?? "",
            code: err ? (err as { code?: number | null }).code ?? null : 0,
            error: err ?? undefined,
          });
        },
      );
    });
    const listModelsContains = stdout.includes(normalizedProvider) && stdout.includes(normalizedModel);
    return {
      ok: providerExists && modelExists && listModelsContains,
      piModelsPath: piModelsPath(),
      providerExists,
      modelExists,
      listModelsContains,
      error: code === 0 ? undefined : (stderr || error?.message || `exit code ${code}`),
    };
  } catch (error) {
    return {
      ok: providerExists && modelExists,
      piModelsPath: piModelsPath(),
      providerExists,
      modelExists,
      listModelsContains: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
