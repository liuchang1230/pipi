import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PiProviderModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface PiProviderConfigEntry {
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
  authHeader?: boolean;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
  };
  models: PiProviderModelEntry[];
}

export interface PiModelsFile {
  providers: Record<string, PiProviderConfigEntry>;
}

export type ProjectEntry =
  | { id: string; type: "local"; name: string; cwd: string; createdAt: number; updatedAt: number }
  | { id: string; type: "remote"; name: string; host: string; user: string; port: number; path: string; password?: string; createdAt: number; updatedAt: number }
  | { id: string; type: "wsl"; name: string; distro: string; path: string; createdAt: number; updatedAt: number };

export interface ModelConfigEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
  availableModels?: string[];
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

export function addRemoteProject(remote: { host: string; user: string; port?: number; path: string; password?: string }): ProjectEntry {
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

export function listModels(): ModelConfigEntry[] {
  return readModels().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function addModel(input: { name: string; baseUrl: string; apiKey?: string; model: string; provider?: string; availableModels?: string[] }): ModelConfigEntry {
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
    createdAt: now,
    updatedAt: now,
  };
  models.push(entry);
  writeModels(models);
  return entry;
}

export function deleteModel(id: string): boolean {
  const models = readModels();
  const target = models.find((m) => m.id === id);
  const next = models.filter((m) => m.id !== id);
  if (next.length === models.length) return false;
  writeModels(next);
  if (target?.provider) {
    const piModels = readPiModelsFile();
    delete piModels.providers[target.provider];
    writePiModelsFile(piModels);
  }
  return true;
}

export function syncModelToPi(input: ModelConfigEntry): void {
  const providerId = input.provider?.trim();
  if (!providerId) return;
  const selectedId = input.model.trim();
  const discovered = (input.availableModels ?? []).map((id) => id.trim()).filter(Boolean);
  const modelIds = Array.from(new Set([selectedId, ...discovered]));
  const models = modelIds.map((id) => ({
    id,
    name: id,
    reasoning: /gpt-5|o1|o3|o4|deepseek-r|deepseek-v4|claude|gemini-2\.5/i.test(id),
    input: ["text"] as Array<"text" | "image">,
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const piModels = readPiModelsFile();
  piModels.providers[providerId] = {
    baseUrl: input.baseUrl,
    api: "openai-completions",
    apiKey: input.apiKey || "placeholder",
    authHeader: true,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    },
    models,
  };
  writePiModelsFile(piModels);
  if (input.apiKey?.trim()) {
    const auth = readPiAuthFile();
    auth[providerId] = { type: "api_key", key: input.apiKey.trim() };
    writePiAuthFile(auth);
  }
}

export function checkPiModelSync(providerId: string, modelId: string): { ok: boolean; piModelsPath: string; providerExists: boolean; modelExists: boolean; listModelsContains: boolean; error?: string } {
  const normalizedProvider = providerId.trim();
  const normalizedModel = modelId.trim();
  const piModels = readPiModelsFile();
  const provider = piModels.providers[normalizedProvider];
  const providerExists = !!provider;
  const modelExists = !!provider?.models?.some((m) => m.id === normalizedModel);
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const result = spawnSync("cmd.exe", ["/d", "/c", "pi.cmd", "--list-models"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDir() },
    });
    const stdout = result.stdout || "";
    const listModelsContains = stdout.includes(normalizedProvider) && stdout.includes(normalizedModel);
    return {
      ok: providerExists && modelExists && listModelsContains,
      piModelsPath: piModelsPath(),
      providerExists,
      modelExists,
      listModelsContains,
      error: result.status === 0 ? undefined : (result.stderr || result.error?.message || `exit code ${result.status}`),
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
