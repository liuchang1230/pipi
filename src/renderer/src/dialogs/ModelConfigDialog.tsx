// Model configuration dialog — a deep module extracted from App.tsx (O1).
// One interface: `onClose`. Everything else — the target selection (local /
// WSL / remote, defaulting to the active tab), the form, discovery, verify,
// transplant and delete — is internal state + handlers, mounted fresh each
// open so the form never leaks across sessions.
import { useCallback, useEffect, useState } from "react";
import { useTabsStore } from "../stores/tabsStore";
import { useSessionsStore } from "../stores/sessionsStore";
import { useUiStore } from "../stores/uiStore";
import { formatTokens, specForModel } from "../../../shared/model-specs";
import type { ModelEditorSpec, PiApi, PiInputType, ProviderEditorConfig } from "../../../shared/model-config-types";

interface ModelSpecEdit extends ModelEditorSpec {}

interface ModelConfigItem {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
  availableModels?: string[];
  contextWindow?: number;
  maxTokens?: number;
  providerConfig?: ProviderEditorConfig;
  modelSpecs?: Record<string, ModelEditorSpec>;
  createdAt: number;
  updatedAt: number;
}

type ModelTarget =
  | { kind: "local" }
  | { kind: "remote"; index: number; host: string; user: string; port: number; password?: string; path?: string }
  | { kind: "wsl"; distro: string };

const showToast = (text: string, type: "ok" | "err") => useUiStore.getState().showToast(text, type);

function configuredModelIds(item: ModelConfigItem): string[] {
  return Array.from(new Set([item.model, ...(item.availableModels ?? [])].map((id) => id.trim()).filter(Boolean)));
}

/** The default target follows the active tab (computed synchronously so the
 *  first render shows the right target instead of a flash of "本地电脑"). */
function computeInitialTarget(): ModelTarget {
  const st = useTabsStore.getState();
  const allHistory = useSessionsStore.getState().remoteHistory;
  const active = st.tabs.find((t) => t.id === st.activeTab);
  let target: ModelTarget = { kind: "local" };
  if (active?.isWsl && active.wslDistro) {
    target = { kind: "wsl", distro: active.wslDistro };
  } else if (active?.isRemote && active.remoteHost && active.remoteUser) {
    const rh = allHistory.find(
      (h) => h.host === active.remoteHost && h.user === active.remoteUser && (h.port ?? 22) === (active.remotePort ?? 22),
    );
    if (rh) {
      const idx = allHistory.indexOf(rh);
      target = { kind: "remote", index: idx, host: rh.host, user: rh.user, port: rh.port ?? 22, password: rh.password, path: rh.path };
    }
  }
  return target;
}

export function ModelConfigDialog({ onClose }: { onClose: () => void }) {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTab = useTabsStore((s) => s.activeTab);
  const remoteHistory = useSessionsStore((s) => s.remoteHistory);

  const [models, setModels] = useState<ModelConfigItem[]>([]);
  const [modelName, setModelName] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelIdValue, setModelIdValue] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [modelTarget, setModelTarget] = useState<ModelTarget>(computeInitialTarget);
  const [modelRemoteLoading, setModelRemoteLoading] = useState(false);
  const [wslDistros, setWslDistros] = useState<Array<{ name: string; default: boolean; running: boolean; version: number }>>([]);
  const [editingModel, setEditingModel] = useState<ModelConfigItem | null>(null);
  const [specEdits, setSpecEdits] = useState<Record<string, ModelSpecEdit>>({});
  const [modelApi, setModelApi] = useState<PiApi>("openai-completions");
  const [authHeader, setAuthHeader] = useState(true);
  const [advancedJson, setAdvancedJson] = useState("");

  const resetModelForm = useCallback(() => {
    setModelName("");
    setModelBaseUrl("");
    setModelApiKey("");
    setModelIdValue("");
    setModelProvider("");
    setModelApi("openai-completions");
    setAuthHeader(true);
    setAdvancedJson("");
    setDiscoveredModels([]);
    setEditingModel(null);
    setSpecEdits({});
  }, []);

  const editModel = useCallback((item: ModelConfigItem) => {
    setEditingModel(item);
    setModelName(item.name);
    setModelBaseUrl(item.baseUrl);
    setModelApiKey(item.apiKey && item.apiKey !== "placeholder" ? item.apiKey : "");
    setModelIdValue(item.model);
    setModelProvider(item.provider || "");
    setModelApi(item.providerConfig?.api ?? "openai-completions");
    setAuthHeader(item.providerConfig?.authHeader ?? true);
    setAdvancedJson(JSON.stringify({ provider: item.providerConfig ?? {}, model: item.modelSpecs?.[item.model] ?? {} }, null, 2));
    setDiscoveredModels(item.availableModels || []);
    setSpecEdits(item.modelSpecs ? JSON.parse(JSON.stringify(item.modelSpecs)) : {});
  }, []);

  /** Models shown in the spec-edit block: the selected id + any discovered. */
  const specEditModels = Array.from(new Set([modelIdValue.trim(), ...discoveredModels].map((s) => s.trim()).filter(Boolean)));

  const setSpecEdit = useCallback((id: string, field: "contextWindow" | "maxTokens", raw: string) => {
    setSpecEdits((prev) => {
      const cur = { ...(prev[id] ?? {}) };
      const trimmed = raw.trim();
      if (!trimmed) {
        delete cur[field];
      } else {
        const n = Number(trimmed);
        if (isFinite(n) && n > 0) cur[field] = Math.round(n);
      }
      return { ...prev, [id]: cur };
    });
  }, []);

  /** Per-model capability toggles (image input / reasoning). */
  const toggleSpecFlag = useCallback((id: string, flag: "input" | "reasoning", value: boolean) => {
    setSpecEdits((prev) => {
      const cur = { ...(prev[id] ?? {}) };
      if (flag === "input") {
        const base: PiInputType[] = Array.isArray(cur.input) ? (cur.input as PiInputType[]) : ["text"];
        cur.input = value ? Array.from(new Set([...base, "image" as PiInputType])) : base.filter((t) => t !== "image");
        if ((cur.input ?? []).length === 0) cur.input = ["text"];
      } else {
        if (value) cur.reasoning = true;
        else delete cur.reasoning;
      }
      return { ...prev, [id]: cur };
    });
  }, []);

  const loadModels = useCallback(async () => {
    try {
      setModels(await window.api.model.list());
    } catch {
      setModels([]);
    }
  }, []);

  const loadRemoteModels = useCallback(async (target: Extract<ModelTarget, { kind: "remote" }>) => {
    setModelRemoteLoading(true);
    try {
      setModels(await window.api.model.listRemote({ host: target.host, user: target.user, port: target.port, password: target.password, path: target.path }));
    } catch (error) {
      setModels([]);
      showToast(error instanceof Error ? error.message : "读取远程配置失败", "err");
    } finally {
      setModelRemoteLoading(false);
    }
  }, []);

  // Load the matching model list once; pre-fetch WSL distros for the dropdown.
  useEffect(() => {
    window.api.wsl.listDistros().then(setWslDistros).catch(() => setWslDistros([]));
    void (modelTarget.kind === "remote" ? loadRemoteModels(modelTarget) : loadModels());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDiscoverModels = useCallback(async () => {
    if (!modelBaseUrl.trim()) {
      showToast("请先填写 Base URL", "err");
      return;
    }
    setDiscoveringModels(true);
    try {
      let list: string[];
      if (modelTarget.kind === "remote") {
        list = await window.api.model.discoverRemote({
          remote: { host: modelTarget.host, user: modelTarget.user, port: modelTarget.port, password: modelTarget.password, path: modelTarget.path },
          baseUrl: modelBaseUrl,
          apiKey: modelApiKey,
        });
      } else {
        list = await window.api.model.discover({ baseUrl: modelBaseUrl, apiKey: modelApiKey });
      }
      setDiscoveredModels(list);
      if (list.length > 0 && !list.includes(modelIdValue)) {
        setModelIdValue(list[0]);
      }
      showToast(list.length > 0 ? `已检索到 ${list.length} 个模型${modelTarget.kind === "remote" ? "（远程）" : ""}` : "未检索到模型", list.length > 0 ? "ok" : "err");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "模型检索失败", "err");
    } finally {
      setDiscoveringModels(false);
    }
  }, [modelApiKey, modelBaseUrl, modelIdValue, modelTarget]);

  const onModelTargetChange = useCallback(
    (value: string) => {
      if (value === "local") {
        setModelTarget({ kind: "local" });
        void loadModels();
        resetModelForm();
        return;
      }
      if (value.startsWith("wsl:")) {
        const distro = value.slice(4);
        setModelTarget({ kind: "wsl", distro });
        resetModelForm();
        return;
      }
      const idx = Number(value.replace(/^remote:/, ""));
      const rh = remoteHistory[idx];
      if (!rh) return;
      const target: Extract<ModelTarget, { kind: "remote" }> = {
        kind: "remote",
        index: idx,
        host: rh.host,
        user: rh.user,
        port: rh.port ?? 22,
        password: rh.password,
        path: rh.path,
      };
      setModelTarget(target);
      void loadRemoteModels(target);
      resetModelForm();
    },
    [remoteHistory, loadModels, loadRemoteModels, resetModelForm],
  );

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">模型配置</div>
        <div className="dialog-body">
          {/* 配置目标 */}
          <div className="dialog-target-row">
            <select
              className="dialog-input"
              value={modelTarget.kind === "remote" ? `remote:${modelTarget.index}` : modelTarget.kind === "wsl" ? `wsl:${modelTarget.distro}` : "local"}
              onChange={(e) => onModelTargetChange(e.target.value)}
            >
              <option value="local">本地电脑</option>
              {wslDistros.map((d) => (
                <option key={`wsl-${d.name}`} value={`wsl:${d.name}`}>
                  🐧 {d.name} (WSL)
                </option>
              ))}
              {remoteHistory.map((h, i) => (
                <option key={h.id} value={`remote:${i}`}>
                  {h.user}@{h.host}:{h.port ?? 22}
                </option>
              ))}
            </select>
            <span className="dialog-hint">
              {modelTarget.kind === "remote"
                ? `写入 ${modelTarget.user}@${modelTarget.host} 的 ~/.pi/agent/`
                : modelTarget.kind === "wsl"
                ? `写入 WSL ${modelTarget.distro} 的 ~/.pi/agent/`
                : "写入本机 ~/.pi/agent/"}
            </span>
            {editingModel && <span className="dialog-hint editing-note">正在编辑：{editingModel.provider || editingModel.name}</span>}
          </div>

          {/* Provider 连接 */}
          <div className="dialog-section">
            <div className="section-title">Provider 连接</div>
            <div className="form-grid-2">
              <label>
                配置名称
                <input className="dialog-input" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="例如：OpenAI 兼容" autoFocus />
              </label>
              <label>
                API 协议
                <select className="dialog-input" value={modelApi} onChange={(e) => setModelApi(e.target.value as PiApi)}>
                  <option value="openai-completions">OpenAI Chat Completions</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                  <option value="google-generative-ai">Google Generative AI</option>
                </select>
              </label>
            </div>
            <label>
              Base URL
              <input className="dialog-input" value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </label>
            <div className="form-grid-2">
              <label>
                API Key
                <input className="dialog-input" value={modelApiKey} onChange={(e) => setModelApiKey(e.target.value)} placeholder="sk-..." type="password" />
              </label>
              <label>
                Provider <span className="dialog-hint">（/model 显示名）</span>
                <input className="dialog-input" value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} placeholder="my-openai" />
              </label>
            </div>
            <label className="dialog-checkbox-row">
              <input type="checkbox" checked={authHeader} onChange={(e) => setAuthHeader(e.target.checked)} />
              自动发送 Authorization Bearer Header
            </label>
            <div className="model-discover-row">
              <button className="btn" onClick={() => void handleDiscoverModels()} disabled={discoveringModels}>
                {discoveringModels ? "检索中…" : "🔍 自动检索模型"}
              </button>
              {discoveredModels.length > 0 && <span className="model-discover-hint">已发现 {discoveredModels.length} 个模型</span>}
            </div>
          </div>

          {/* 模型 */}
          <div className="dialog-section">
            <div className="section-title">
              模型 <span className="dialog-hint">（○ 设为默认；上下文/输出自动获取，可手改）</span>
            </div>
            <input
              className="dialog-input model-add-input"
              value={modelIdValue}
              onChange={(e) => setModelIdValue(e.target.value)}
              placeholder="输入或选择模型 ID，如 gpt-4o-mini"
            />
            {specEditModels.length > 0 && (
              <div className="model-edit-list">
                {specEditModels.map((id) => {
                  const isPrimary = id === modelIdValue.trim();
                  return (
                    <div key={id} className={isPrimary ? "model-edit-card primary" : "model-edit-card"}>
                      <div className="model-edit-head">
                        <input type="radio" name="primary-model" checked={isPrimary} onChange={() => setModelIdValue(id)} title="设为默认模型" />
                        <span className="model-edit-id" title={id}>{id}</span>
                        {isPrimary && <span className="model-chip primary">默认</span>}
                      </div>
                      <div className="model-edit-grid">
                        <label>
                          上下文
                          <input
                            className="dialog-input"
                            inputMode="numeric"
                            value={specEdits[id]?.contextWindow ?? specForModel(id).contextWindow}
                            onChange={(e) => setSpecEdit(id, "contextWindow", e.target.value)}
                          />
                        </label>
                        <label>
                          最大输出
                          <input
                            className="dialog-input"
                            inputMode="numeric"
                            value={specEdits[id]?.maxTokens ?? specForModel(id).maxTokens}
                            onChange={(e) => setSpecEdit(id, "maxTokens", e.target.value)}
                          />
                        </label>
                        <label className="dialog-checkbox-row">
                          <input type="checkbox" checked={specEdits[id]?.input?.includes("image") ?? false} onChange={(e) => toggleSpecFlag(id, "input", e.target.checked)} />
                          图像输入
                        </label>
                        <label className="dialog-checkbox-row">
                          <input type="checkbox" checked={specEdits[id]?.reasoning ?? false} onChange={(e) => toggleSpecFlag(id, "reasoning", e.target.checked)} />
                          Reasoning
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <details className="advanced-json-wrap">
              <summary>高级 JSON（headers / compat / samplingParams / cost / thinkingLevelMap）</summary>
              <textarea className="dialog-input model-advanced-json" value={advancedJson} onChange={(e) => setAdvancedJson(e.target.value)} placeholder='{"provider":{"compat":{}},"model":{"samplingParams":{}}}' />
            </details>
          </div>

          {/* 已有配置 */}
          <div className="dialog-section">
            <div className="section-title">已有配置</div>
            <div className="model-list">
            {modelRemoteLoading ? <div className="placeholder">（读取远程配置…）</div> : models.length === 0 ? <div className="placeholder">（暂无模型配置）</div> : models.map((item) => (
              <div key={item.id} className="model-row">
                <div className="model-row-main">
                  <div className="model-row-title">{item.name}</div>
                  <div className="model-row-meta">
                    {item.provider ? `${item.provider} · ` : ""}{item.baseUrl}
                    {item.contextWindow ? ` · ${formatTokens(item.contextWindow)} ctx` : ""}
                    {item.maxTokens ? ` · ${formatTokens(item.maxTokens)} out` : ""}
                  </div>
                  <div className="model-row-models">
                    {configuredModelIds(item).map((modelId) => (
                      <span key={modelId} className={modelId === item.model ? "model-chip primary" : "model-chip"}>{modelId}</span>
                    ))}
                  </div>
                </div>
                <div className="model-row-actions">
                  <button className="btn" onClick={() => editModel(item)} title="编辑配置">编辑</button>
                  {modelTarget.kind === "local" && (
                    <button
                      className="btn"
                      onClick={async () => {
                        const result = await window.api.model.checkSync({ provider: item.provider || "", model: item.model });
                        showToast(
                          result.ok
                            ? `Pi 已识别：${item.provider}/${item.model}`
                            : `Pi 未完全识别：provider=${result.providerExists ? "✓" : "✗"} model=${result.modelExists ? "✓" : "✗"} list=${result.listModelsContains ? "✓" : "✗"}`,
                          result.ok ? "ok" : "err",
                        );
                      }}
                      title="检查是否已同步到 Pi"
                    >验证</button>
                  )}
                  <button
                    className="row-delete"
                    onClick={async () => {
                      if (modelTarget.kind === "remote") {
                        await window.api.model.deleteRemote({
                          remote: { host: modelTarget.host, user: modelTarget.user, port: modelTarget.port, password: modelTarget.password, path: modelTarget.path },
                          provider: item.provider || "",
                        });
                        await loadRemoteModels(modelTarget);
                      } else {
                        await window.api.model.delete(item.id);
                        await loadModels();
                      }
                    }}
                    title="删除配置"
                  >×</button>
                </div>
              </div>
            ))}
          </div>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={editingModel ? resetModelForm : onClose}>{editingModel ? "取消编辑" : "关闭"}</button>
          {(modelTarget.kind === "wsl" || modelTarget.kind === "remote") && (
            <button
              className="btn"
              onClick={async () => {
                try {
                  let result: { ok: boolean; error?: string; copied: string[] };
                  if (modelTarget.kind === "wsl") {
                    result = await window.api.model.transplantToWsl(modelTarget.distro);
                  } else {
                    result = await window.api.model.transplantToRemote({
                      host: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).host,
                      user: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).user,
                      port: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).port,
                      password: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).password,
                      path: (modelTarget as Extract<ModelTarget, { kind: "remote" }>).path,
                    });
                  }
                  const label = modelTarget.kind === "wsl" ? modelTarget.distro : `${(modelTarget as any).user}@${(modelTarget as any).host}`;
                  showToast(result.ok ? `已移植 ${result.copied.join(", ")} 到 ${label}` : `移植失败: ${result.error}`, result.ok ? "ok" : "err");
                } catch (err) {
                  showToast(`移植失败: ${err instanceof Error ? err.message : String(err)}`, "err");
                }
              }}
            >📋 从本机移植配置</button>
          )}
          <button
            className="btn btn-primary"
            onClick={async () => {
              const normalizedBaseUrl = modelBaseUrl.trim();
              const normalizedModelId = modelIdValue.trim();
              const normalizedProvider = modelProvider.trim();
              if (!normalizedBaseUrl || !normalizedModelId || !normalizedProvider) {
                showToast(`请填写 Base URL、Provider 和模型 ID（当前: baseUrl=${normalizedBaseUrl ? "✓" : "✗"}, provider=${normalizedProvider ? "✓" : "✗"}, model=${normalizedModelId ? "✓" : "✗"}）`, "err");
                return;
              }
              try {
                const targetKindWsl = modelTarget.kind === "wsl";
                // Only explicitly-set specs travel with the save; unset
                // fields fall through to existing-pi / network / table.
                let advanced: { provider?: ProviderEditorConfig; model?: ModelEditorSpec } = {};
                if (advancedJson.trim()) {
                  try {
                    advanced = JSON.parse(advancedJson) as typeof advanced;
                  } catch {
                    showToast("高级 JSON 格式不正确", "err");
                    return;
                  }
                }
                const modelSpecs: Record<string, ModelEditorSpec> = {};
                for (const id of specEditModels) {
                  const v = specEdits[id];
                  if (id === normalizedModelId) {
                    // Primary model: JSON supplies non-form fields, form
                    // controls (spec table / toggles) win for the rest.
                    const entry: ModelEditorSpec = { ...(advanced.model ?? {}) };
                    delete (entry as { input?: unknown }).input;
                    delete (entry as { reasoning?: unknown }).reasoning;
                    if (v?.contextWindow) entry.contextWindow = v.contextWindow;
                    if (v?.maxTokens) entry.maxTokens = v.maxTokens;
                    if (Array.isArray(v?.input)) entry.input = v.input;
                    if (v?.reasoning) entry.reasoning = v.reasoning;
                    if (Object.keys(entry).length > 0) modelSpecs[id] = entry;
                  } else if (v && Object.keys(v).length > 0) {
                    // Other models: keep everything the user touched (edit
                    // pre-fills them from existing pi config).
                    modelSpecs[id] = { ...v };
                  }
                }
                const payload = {
                  name: modelName.trim(),
                  baseUrl: normalizedBaseUrl,
                  apiKey: modelApiKey.trim(),
                  model: normalizedModelId,
                  provider: normalizedProvider,
                  availableModels: discoveredModels,
                  providerConfig: {
                    ...(advanced.provider ?? {}),
                    api: modelApi,
                    authHeader,
                  },
                  modelSpecs,
                };
                if (modelTarget.kind === "remote") {
                  const remote = { host: modelTarget.host, user: modelTarget.user, port: modelTarget.port, password: modelTarget.password, path: modelTarget.path };
                  await window.api.model.addRemote({
                    remote,
                    baseUrl: payload.baseUrl,
                    apiKey: payload.apiKey,
                    model: payload.model,
                    provider: payload.provider,
                    availableModels: payload.availableModels,
                    providerConfig: payload.providerConfig,
                    modelSpecs: payload.modelSpecs,
                  });
                  const oldProvider = editingModel?.provider?.trim();
                  if (oldProvider && oldProvider !== payload.provider) {
                    await window.api.model.deleteRemote({ remote, provider: oldProvider });
                  }
                  await loadRemoteModels(modelTarget);
                } else {
                  if (editingModel) {
                    await window.api.model.update(editingModel.id, payload);
                  } else {
                    await window.api.model.add(payload);
                  }
                  await loadModels();
                }
                resetModelForm();
                if (targetKindWsl) {
                  showToast(`已保存到本机。点击「📋 从本机移植配置」同步到 WSL`, "ok");
                } else if (modelTarget.kind === "remote") {
                  showToast(`模型配置已保存（${modelTarget.user}@${modelTarget.host}）`, "ok");
                } else {
                  showToast("模型配置已保存（本地）", "ok");
                }
              } catch (error) {
                showToast(error instanceof Error ? `保存失败：${error.message}` : "保存失败", "err");
              }
            }}
          >{editingModel ? "更新" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}
