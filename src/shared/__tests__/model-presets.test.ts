// MODEL_PRESETS — invariant tests: every preset must be save-ready (the
// dialog's save path requires non-empty name/baseUrl/model/provider and
// unique keys for React), and the two high-confidence domestic specs must
// actually resolve through specForModel (lowercased siliconflow ids).
import { describe, expect, it } from "vitest";
import { MODEL_PRESETS, type ModelPreset } from "../model-presets";
import { specForModel } from "../model-specs";

describe("MODEL_PRESETS", () => {
  it("has unique keys and save-ready fields on every preset", () => {
    const keys = new Set<string>();
    for (const p of MODEL_PRESETS) {
      expect(keys.has(p.key)).toBe(false);
      keys.add(p.key);
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.name.trim().length).toBeGreaterThan(0);
      expect(p.baseUrl.trim().length).toBeGreaterThan(0);
      expect(p.model.trim().length).toBeGreaterThan(0);
      expect(p.provider.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses https endpoints and lists at least the default model", () => {
    for (const p of MODEL_PRESETS) {
      expect(p.baseUrl).toMatch(/^https:\/\/.+\/v1$|^https:\/\/.+\/v4$/);
      expect(p.availableModels ?? []).toContain(p.model);
    }
  });

  it("defaults every preset to the OpenAI-compatible chat completions protocol", () => {
    for (const p of MODEL_PRESETS) {
      expect(p.api ?? "openai-completions").toBe("openai-completions");
    }
  });

  it("covers the four domestic channels from AGENTS.md", () => {
    const keys = MODEL_PRESETS.map((p) => p.key).sort();
    expect(keys).toEqual(["deepseek", "kimi", "siliconflow", "zhipu"]);
  });
});

describe("domestic model specs", () => {
  it("resolves the siliconflow Qwen id through the lowercased spec table", () => {
    const spec = specForModel("Qwen/Qwen2.5-7B-Instruct");
    expect(spec.contextWindow).toBe(32768);
    expect(spec.maxTokens).toBe(8192);
  });

  it("resolves glm-4-flash (zhipu free tier)", () => {
    const spec = specForModel("glm-4-flash");
    expect(spec.contextWindow).toBe(128000);
    expect(spec.maxTokens).toBe(4096);
  });

  it("resolves the deepseek v4 default model from the preset", () => {
    const deepseek = MODEL_PRESETS.find((p) => p.key === "deepseek") as ModelPreset;
    expect(specForModel(deepseek.model).contextWindow).toBe(1_000_000);
  });
});
