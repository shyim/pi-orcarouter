import { afterEach, describe, expect, it } from "vitest";
import { GENERATED_MODELS } from "../models.generated.ts";
import { assembleModels, fetchModelCatalog, isReasoningModel, type OrcaRouterModel } from "../models.ts";
import { resolve } from "../thinking-levels.ts";

// --- Helpers ---

/** Minimal valid /v1/models entry matching the real OrcaRouter API shape. */
function rawModel(overrides: Partial<OrcaRouterModel> = {}): OrcaRouterModel {
  return {
    id: "test/model",
    object: "model",
    owned_by: "test",
    supported_endpoint_types: ["openai"],
    context_length: 128000,
    max_completion_tokens: 32768,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    ...overrides,
  };
}

function catalog(...models: OrcaRouterModel[]): Record<string, OrcaRouterModel> {
  return Object.fromEntries(models.map((m) => [m.id, m]));
}

// ============================================================================
// assembleModels
// ============================================================================

describe("assembleModels", () => {
  it("filters out models without the openai endpoint", () => {
    const raw = catalog(
      rawModel({ id: "embeddings/only", supported_endpoint_types: ["embeddings"] }),
      rawModel({ id: "image/only", supported_endpoint_types: ["image-generation"] }),
      rawModel({ id: "chat/model", supported_endpoint_types: ["openai", "anthropic"] }),
    );
    const models = assembleModels(raw);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("chat/model");
  });

  it("uses the API name when present and falls back to id", () => {
    const raw = catalog(
      rawModel({ id: "anthropic/claude-x", name: "Anthropic: Claude X" }),
      rawModel({ id: "no/name", name: undefined }),
    );
    const models = assembleModels(raw);
    const named = models.find((m) => m.id === "anthropic/claude-x");
    const unnamed = models.find((m) => m.id === "no/name");
    expect(named?.name).toBe("Anthropic: Claude X");
    expect(unnamed?.name).toBe("no/name");
  });

  it("marks reasoning models and assigns a thinking map", () => {
    const models = assembleModels(catalog(rawModel({ id: "anthropic/claude-opus-4.5" })));
    expect(models[0].reasoning).toBe(true);
    expect(models[0].compat?.supportsReasoningEffort).toBe(true);
    expect(models[0].thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("marks non-reasoning models without a thinking map", () => {
    const models = assembleModels(catalog(rawModel({ id: "meta/llama-3-8b" })));
    expect(models[0].reasoning).toBe(false);
    expect(models[0].thinkingLevelMap).toBeUndefined();
    expect(models[0].compat?.supportsReasoningEffort).toBe(false);
  });

  it("defaults input to text-only", () => {
    const models = assembleModels(catalog(rawModel({ architecture: { input_modalities: ["text"] } })));
    expect(models[0].input).toEqual(["text"]);
  });

  it("adds image to input when the image modality is present", () => {
    const models = assembleModels(
      catalog(rawModel({ architecture: { input_modalities: ["text", "image", "file"] } })),
    );
    expect(models[0].input).toEqual(["text", "image"]);
  });

  it("maps per-token pricing into the cost field", () => {
    const models = assembleModels(
      catalog(
        rawModel({
          id: "anthropic/claude-x",
          pricing: { prompt: "0.0000010000", completion: "0.0000050000" },
        }),
      ),
    );
    expect(models[0].cost).toEqual({ input: 0.000001, output: 0.000005, cacheRead: 0, cacheWrite: 0 });
  });

  it("falls back to zero cost when pricing is absent (router models)", () => {
    const models = assembleModels(catalog(rawModel({ id: "orcarouter/fusion", pricing: null })));
    expect(models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("uses context_length, falling back to top_provider then default", () => {
    const withCtx = assembleModels(catalog(rawModel({ context_length: 262144 })));
    expect(withCtx[0].contextWindow).toBe(262144);

    const fromTop = assembleModels(
      catalog(rawModel({ context_length: null, top_provider: { context_length: 200000 } })),
    );
    expect(fromTop[0].contextWindow).toBe(200000);

    const fallback = assembleModels(catalog(rawModel({ context_length: null, top_provider: null })));
    expect(fallback[0].contextWindow).toBe(128000);
  });

  it("uses max_completion_tokens, falling back to default", () => {
    const withMax = assembleModels(catalog(rawModel({ max_completion_tokens: 64000 })));
    expect(withMax[0].maxTokens).toBe(64000);

    const fallback = assembleModels(catalog(rawModel({ max_completion_tokens: null, top_provider: null })));
    expect(fallback[0].maxTokens).toBe(32768);
  });

  it("sets all compat flags explicitly on every model", () => {
    const models = assembleModels(catalog(rawModel({ id: "anthropic/claude-x" })));
    const compat = models[0].compat;

    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsReasoningEffort).toBe(true);
    expect(compat?.thinkingFormat).toBe("openai");
    expect(compat?.supportsStore).toBe(false);
    expect(compat?.maxTokensField).toBe("max_completion_tokens");
    expect(compat?.supportsUsageInStreaming).toBe(true);
    expect(compat?.supportsStrictMode).toBe(false);
    expect(compat?.cacheControlFormat).toBeUndefined();
    expect(compat?.requiresToolResultName).toBe(false);
    expect(compat?.requiresAssistantAfterToolResult).toBe(false);
    expect(compat?.requiresThinkingAsText).toBe(false);
    expect(compat?.requiresReasoningContentOnAssistantMessages).toBe(false);
    expect(compat?.sendSessionAffinityHeaders).toBe(false);
    expect(compat?.supportsLongCacheRetention).toBe(false);
    expect(compat?.zaiToolStream).toBe(false);
    expect(compat?.openRouterRouting).toEqual({});
    expect(compat?.vercelGatewayRouting).toEqual({});
  });
});

// ============================================================================
// GENERATED_MODELS (baked-in cold-start list)
// ============================================================================

describe("GENERATED_MODELS", () => {
  it("ships at least one model", () => {
    expect(GENERATED_MODELS.length).toBeGreaterThan(0);
  });

  it("only ships models with explicit compat shape", () => {
    for (const m of GENERATED_MODELS) {
      expect(m.compat).toMatchObject({
        supportsDeveloperRole: false,
        supportsStore: false,
        maxTokensField: "max_completion_tokens",
        supportsUsageInStreaming: true,
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: false,
        thinkingFormat: "openai",
        supportsStrictMode: false,
        sendSessionAffinityHeaders: false,
        supportsLongCacheRetention: false,
        zaiToolStream: false,
        openRouterRouting: {},
        vercelGatewayRouting: {},
      });
    }
  });
});

// ============================================================================
// isReasoningModel
// ============================================================================

describe("isReasoningModel", () => {
  it("detects known reasoning families", () => {
    for (const id of [
      "anthropic/claude-opus-4.5",
      "openai/gpt-5",
      "openai/o3",
      "openai/gpt-oss-120b",
      "google/gemini-2.5-pro",
      "google/gemini-3-pro",
      "xai/grok-4",
      "deepseek/deepseek-r1",
      "qwen/qwq-32b",
      "moonshot/kimi-k2-thinking",
      "orcarouter/fusion",
    ]) {
      expect(isReasoningModel(id)).toBe(true);
    }
  });

  it("treats plain chat models as non-reasoning", () => {
    for (const id of ["meta/llama-3-8b", "mistral/mistral-large", "google/gemma-2-9b"]) {
      expect(isReasoningModel(id)).toBe(false);
    }
  });
});

// ============================================================================
// resolve (thinking level maps)
// ============================================================================

describe("resolve", () => {
  it("returns undefined for non-reasoning models", () => {
    expect(resolve("meta/llama-3", false)).toBeUndefined();
  });

  it("returns DEFAULT for generic reasoning models", () => {
    expect(resolve("anthropic/claude-opus-4.5", true)).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("returns GPT_OSS for gpt-oss models", () => {
    expect(resolve("openai/gpt-oss-120b", true)).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    });
  });

  it("returns OPENAI_REASONING for gpt-5 and o-series", () => {
    const expected = { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" };
    expect(resolve("openai/gpt-5", true)).toEqual(expected);
    expect(resolve("openai/o3", true)).toEqual(expected);
  });
});

// ============================================================================
// fetchModelCatalog error handling
// ============================================================================

describe("fetchModelCatalog", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws rate limit error on 429", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
    await expect(fetchModelCatalog()).rejects.toThrow("OrcaRouter rate limited");
  });

  it("throws generic error on other failures", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "server error" }), { status: 500 });
    await expect(fetchModelCatalog()).rejects.toThrow("Failed to fetch model list");
  });

  it("returns models keyed by id on success", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ id: "anthropic/claude-x" }, { id: "openai/gpt-5" }] }),
        { status: 200 },
      );
    const models = await fetchModelCatalog();
    expect(Object.keys(models)).toEqual(["anthropic/claude-x", "openai/gpt-5"]);
  });
});
