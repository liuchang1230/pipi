/**
 * MODEL_PRESETS — 一键配置模板（国内合规渠道 + 自定义端点）。
 *
 * 每个模板只填"连接信息"：配置名 / Base URL / Provider / 默认模型 /
 * 常用模型列表 / 可选规格提示。API Key 由用户粘贴（BYOK，app 不代持）。
 * 值来自各厂商官方文档（2026-08 核对）：
 *  - DeepSeek    https://api.deepseek.com/v1（OpenAI 兼容；V4 为新模型，
 *                deepseek-chat/reasoner 已宣布停用）
 *  - 硅基流动    https://api.siliconflow.cn/v1（必须带 /v1；模型名需与
 *                模型广场一致，可用「自动检索」拉取）
 *  - Kimi        https://api.moonshot.cn/v1（海外版 api.moonshot.ai）
 *  - 智谱        https://open.bigmodel.cn/api/paas/v4（GLM 编码套餐有
 *                专属 Coding 端点）
 *
 * 「自定义 OpenAI 兼容端点」不需要模板——现有表单直接支持任意 baseUrl +
 * openai-completions 协议，模板只覆盖常见渠道的填表成本。
 */
import type { ModelEditorSpec, PiApi } from "./model-config-types";

export interface ModelPreset {
  /** 稳定唯一键（测试/未来持久化用）。 */
  key: string;
  /** 芯片显示名。 */
  label: string;
  /** 写入配置的 name（列表显示名）。 */
  name: string;
  baseUrl: string;
  /** 默认模型 ID。 */
  model: string;
  /** /model 显示名。 */
  provider: string;
  api?: PiApi;
  /** 常用模型列表（默认模型 + 备选；「自动检索」可覆盖）。 */
  availableModels?: string[];
  /** 默认模型的高置信规格（无则走 specForModel/网络）。 */
  spec?: ModelEditorSpec;
  /** 芯片 title 提示。 */
  hint?: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    key: "deepseek",
    label: "DeepSeek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    availableModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp", "deepseek-chat", "deepseek-reasoner"],
    hint: "OpenAI 兼容 · V4 为新模型（1M 上下文）；deepseek-chat/reasoner 已宣布停用",
  },
  {
    key: "siliconflow",
    label: "硅基流动",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    provider: "siliconflow",
    availableModels: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen3-32B"],
    hint: "国内直连 · 模型名需与模型广场一致，可用「自动检索」拉取列表",
  },
  {
    key: "kimi",
    label: "Kimi",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3",
    provider: "moonshot",
    availableModels: ["kimi-k3", "moonshot-v1-128k", "moonshot-v1-32k"],
    hint: "kimi-k3 为当前主模型 · 海外版端点 api.moonshot.ai",
  },
  {
    key: "zhipu",
    label: "智谱",
    name: "智谱（Z.ai）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.6",
    provider: "zhipu",
    availableModels: ["glm-4.6", "glm-4-flash", "glm-4.5-air", "glm-4.6v-flash"],
    hint: "glm-4-flash 免费 · GLM 编码套餐需用专属 Coding 端点",
  },
];
