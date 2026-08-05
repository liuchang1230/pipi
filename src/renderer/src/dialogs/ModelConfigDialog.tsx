// Model configuration dialog — a deep module extracted from App.tsx (O1).
// One interface: `onClose`. Everything else — the target selection (local /
// WSL / remote, defaulting to the active tab), the form, discovery, verify,
// transplant and delete — is internal state + handlers, mounted fresh each
// open so the form never leaks across sessions.
import { useCallback, useEffect, useState } from "react";
import { useTabsStore } from "../stores/tabsStore";
import { useSessionsStore } from "../stores/sessionsStore";
import { useUiStore } from "../stores/uiStore";

interface ModelConfigItem {
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

type ModelTarget =
  | { kind: "local" }
  | { kind: "remote"; index: number; host: string; user: string; port: number; password?: string; path?: string }
  | { kind: "wsl"; distro: string };

const showToast = (text: string, type: "ok" | "err") => useUiStore.getState().showToast(text, type);

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
        setDiscoveredModels([]);
        setModelIdValue("");
        return;
      }
      if (value.startsWith("wsl:")) {
        const distro = value.slice(4);
        setModelTarget({ kind: "wsl", distro });
        setDiscoveredModels([]);
        setModelIdValue("");
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
      setDiscoveredModels([]);
      setModelIdValue("");
    },
    [remoteHistory, loadModels, loadRemoteModels],
  );

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">模型配置</div>
        <div className="dialog-body">
          <label>
            配置目标
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
          </label>
          <label>
            配置名称
            <input className="dialog-input" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="例如：OpenAI 兼容" autoFocus />
          </label>
          <label>
            Base URL
            <input className="dialog-input" value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            API Key
            <input className="dialog-input" value={modelApiKey} onChange={(e) => setModelApiKey(e.target.value)} placeholder="sk-..." type="password" />
          </label>
          <label>
            模型 ID
            {discoveredModels.length > 0 ? (
              <select className="dialog-input" value={modelIdValue} onChange={(e) => setModelIdValue(e.target.value)}>
                {discoveredModels.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            ) : (
              <input className="dialog-input" value={modelIdValue} onChange={(e) => setModelIdValue(e.target.value)} placeholder="gpt-4o-mini" />
            )}
          </label>
          <label>
            Provider <span className="dialog-hint">（必填，用于 /model 显示 provider 名称）</span>
            <input className="dialog-input" value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} placeholder="例如 my-openai" />
          </label>
          <div className="model-discover-row">
            <button className="btn" onClick={() => void handleDiscoverModels()} disabled={discoveringModels}>
              {discoveringModels ? "检索中…" : "自动检索模型"}
            </button>
            {discoveredModels.length > 0 && <span className="model-discover-hint">已发现 {discoveredModels.length} 个模型</span>}
          </div>
          <div className="model-list">
            {modelRemoteLoading ? <div className="placeholder">（读取远程配置…）</div> : models.length === 0 ? <div className="placeholder">（暂无模型配置）</div> : models.map((item) => (
              <div key={item.id} className="model-row">
                <div className="model-row-main">
                  <div className="model-row-title">{item.name}</div>
                  <div className="model-row-meta">{item.model} · {item.baseUrl}{item.availableModels?.length ? ` · ${item.availableModels.length} 个模型` : ""}</div>
                </div>
                <div className="model-row-actions">
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
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>关闭</button>
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
                if (modelTarget.kind === "remote") {
                  await window.api.model.addRemote({
                    remote: { host: modelTarget.host, user: modelTarget.user, port: modelTarget.port, password: modelTarget.password, path: modelTarget.path },
                    baseUrl: normalizedBaseUrl,
                    apiKey: modelApiKey.trim(),
                    model: normalizedModelId,
                    provider: normalizedProvider,
                    availableModels: discoveredModels,
                  });
                  await loadRemoteModels(modelTarget);
                } else {
                  await window.api.model.add({
                    name: modelName.trim(),
                    baseUrl: normalizedBaseUrl,
                    apiKey: modelApiKey.trim(),
                    model: normalizedModelId,
                    provider: normalizedProvider,
                    availableModels: discoveredModels,
                  });
                  await loadModels();
                }
                setModelName("");
                setModelBaseUrl("");
                setModelApiKey("");
                setModelIdValue("");
                setModelProvider("");
                setDiscoveredModels([]);
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
          >保存</button>
        </div>
      </div>
    </div>
  );
}
