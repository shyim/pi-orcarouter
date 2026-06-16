import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { resolve as resolveThinkingLevelMap } from "./thinking-levels.ts";
import { fetchJsonWithTimeout } from "./utils.ts";

// --- Constants ---
const CACHE_DIR = join(getAgentDir(), "cache");
const CACHE_FILE = join(CACHE_DIR, "orcarouter-models.json");
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

export const ORCAROUTER_BASE = (process.env.ORCAROUTER_API_BASE || "https://api.orcarouter.ai").replace(/\/+$/, "");

// --- Raw API types ---
/**
 * A single entry from GET /v1/models. OrcaRouter returns the full catalog in
 * one call, so there is no per-model detail fetch.
 *
 * Fields are widely optional: router models (orcarouter/*) omit pricing, and
 * many models omit architecture, context_length, or max_completion_tokens.
 */
export interface OrcaRouterModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  /** e.g. ["openai", "openai-response", "anthropic", "gemini", "embeddings", "image-generation"] */
  supported_endpoint_types?: string[] | null;
  name?: string;
  description?: string;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  architecture?: {
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  } | null;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  } | null;
  /** Per-token pricing in USD. Strings like "0.0000010000" (per-token) and per-million variants. */
  pricing?: {
    prompt?: string;
    completion?: string;
    prompt_per_million?: string;
    completion_per_million?: string;
    /** Flat per-request fee in USD, when present. */
    request?: string;
  } | null;
}

/** On-disk cache: raw /v1/models entries keyed by model ID. */
interface CachedData {
  /** Unix epoch milliseconds used to decide when the cached metadata is stale. */
  timestamp?: number;
  models: Record<string, OrcaRouterModel>;
}

type RefreshProgressStage = "list" | "done";

export interface RefreshProgress {
  stage: RefreshProgressStage;
  current?: number;
  total?: number;
  message: string;
}

// --- Capability detection ---

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 32768;

/**
 * Endpoint types that indicate a chat-completions-capable model.
 * The provider is registered with api: "openai-completions", so we require
 * the "openai" endpoint. Embeddings / image-generation / video models are
 * filtered out because they cannot be driven as chat models.
 */
function isChatModel(model: OrcaRouterModel): boolean {
  const endpoints = model.supported_endpoint_types ?? [];
  if (!endpoints.includes("openai")) return false;
  // Exclude models that are *only* non-chat endpoints (defensive; the openai
  // check above already excludes pure embeddings/image models in practice).
  const chatLike = endpoints.some((e) => e === "openai" || e === "openai-response" || e === "anthropic");
  return chatLike;
}

/** Resolve the input modalities Pi understands ("text" | "image"). */
function resolveInput(model: OrcaRouterModel): ("text" | "image")[] {
  const modalities = model.architecture?.input_modalities ?? ["text"];
  const input: ("text" | "image")[] = ["text"];
  if (modalities.includes("image")) input.push("image");
  return input;
}

/**
 * OrcaRouter does not expose a reasoning/thinking capability flag, so we infer
 * it from the model id. Reasoning families accept OpenAI-compatible
 * `reasoning_effort`; everything else is treated as non-reasoning.
 */
export function isReasoningModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes("claude") ||
    /\bo[1-9]\b/.test(lower) ||
    lower.includes("gpt-5") ||
    lower.includes("gpt-6") ||
    lower.includes("gpt-oss") ||
    lower.includes("gemini-2.5") ||
    lower.includes("gemini-3") ||
    lower.includes("grok-3") ||
    lower.includes("grok-4") ||
    lower.includes("deepseek-r") ||
    lower.includes("deepseek-v3") ||
    lower.includes("qwq") ||
    lower.includes("thinking") ||
    lower.includes("reasoner") ||
    lower.includes("minimax") ||
    lower.includes("glm-4.6") ||
    lower.includes("glm-4.5") ||
    lower.includes("kimi") ||
    lower.includes("fusion")
  );
}

// --- Pricing ---

/** Parse a USD-per-token price string into a number; returns 0 on absent/invalid. */
function parsePrice(value: string | undefined): number {
  if (typeof value !== "string") return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Build Pi's per-token cost object from OrcaRouter pricing.
 * Pi expects USD per token (the same unit OrcaRouter's `prompt`/`completion`
 * fields use). Router models without pricing fall back to zero.
 * OrcaRouter does not expose cache-read/cache-write pricing, so those stay 0.
 */
function buildCost(model: OrcaRouterModel): NonNullable<ProviderModelConfig["cost"]> {
  const pricing = model.pricing;
  if (!pricing) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: parsePrice(pricing.prompt),
    output: parsePrice(pricing.completion),
    cacheRead: 0,
    cacheWrite: 0,
  };
}

// --- Assembly: raw API data -> ProviderModelConfig[] ---

/**
 * Build an explicit OpenAICompletionsCompat for an OrcaRouter model.
 * OrcaRouter is an OpenAI-compatible gateway, so it follows standard
 * OpenAI Chat Completions semantics for the fields below.
 *
 * pi type definition: https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts
 */
function buildCompat(reasoning: boolean): ProviderModelConfig["compat"] {
  return {
    // OpenAI-compatible gateway uses the standard "developer"/"system" handling.
    supportsDeveloperRole: false,
    // reasoning_effort is forwarded for reasoning-capable models.
    supportsReasoningEffort: reasoning,
    // "store" is not part of the chat-completions passthrough.
    supportsStore: false,
    // Standard OpenAI chat completions field.
    maxTokensField: "max_completion_tokens",
    // stream_options.include_usage is supported.
    supportsUsageInStreaming: true,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: "openai",
    // tool_choice strict mode is not guaranteed across all routed providers.
    supportsStrictMode: false,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: false,
    zaiToolStream: false,
    // Explicitly undefined: JSON.stringify drops undefined values, keeping
    // models.generated.ts structurally consistent with assembleModels() output.
    cacheControlFormat: undefined,
    openRouterRouting: {},
    vercelGatewayRouting: {},
  };
}

export function assembleModels(raw: Record<string, OrcaRouterModel>): ProviderModelConfig[] {
  return Object.entries(raw)
    .filter(([, data]) => isChatModel(data))
    .map(([id, data]) => {
      const reasoning = isReasoningModel(id);
      return {
        id,
        name: data.name ?? id,
        reasoning,
        thinkingLevelMap: resolveThinkingLevelMap(id, reasoning),
        input: resolveInput(data),
        cost: buildCost(data),
        contextWindow: data.context_length ?? data.top_provider?.context_length ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: data.max_completion_tokens ?? data.top_provider?.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
        compat: buildCompat(reasoning),
      };
    });
}

// --- Cache I/O ---
type CacheState =
  | { status: "fresh"; models: Record<string, OrcaRouterModel> }
  | { status: "stale"; models: Record<string, OrcaRouterModel> }
  | { status: "missing" };

function createCacheData(models: Record<string, OrcaRouterModel>, now = new Date()): CachedData {
  return { timestamp: now.getTime(), models };
}

function readCacheData(path: string): CachedData | null {
  try {
    const data: CachedData = JSON.parse(readFileSync(path, "utf-8"));
    if (!data.models || Object.keys(data.models).length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

function isFreshCache(data: CachedData): boolean {
  if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) return false;
  return Date.now() - data.timestamp <= CACHE_MAX_AGE_MS;
}

export function readCacheState(): CacheState {
  if (!existsSync(CACHE_FILE)) return { status: "missing" };

  const data = readCacheData(CACHE_FILE);
  if (!data) {
    try {
      rmSync(CACHE_FILE, { force: true });
    } catch {
      // Ignore cache delete errors.
    }
    return { status: "missing" };
  }

  return isFreshCache(data) ? { status: "fresh", models: data.models } : { status: "stale", models: data.models };
}

export function writeCache(models: Record<string, OrcaRouterModel>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(createCacheData(models), null, 2));
  } catch {
    // Ignore cache write errors
  }
}

// --- Fetch Models ---

/**
 * Fetch the full catalog from GET /v1/models, keyed by model ID.
 * OrcaRouter returns all metadata in this one call.
 */
export async function fetchModelCatalog(timeoutMs = FETCH_TIMEOUT_MS): Promise<Record<string, OrcaRouterModel>> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.ORCAROUTER_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetchJsonWithTimeout<{ data: OrcaRouterModel[] }>(
    `${ORCAROUTER_BASE}/v1/models`,
    { headers },
    timeoutMs,
  );

  if (res.status === 429) {
    throw new Error("OrcaRouter rate limited. Try again shortly.");
  }
  if (!res.ok || !res.data) {
    throw new Error(`Failed to fetch model list: ${res.status}${res.error ? ` - ${res.error}` : ""}`);
  }

  const models: Record<string, OrcaRouterModel> = {};
  for (const model of res.data.data ?? []) {
    if (model?.id) models[model.id] = model;
  }
  return models;
}

export async function refreshOrcaRouterModels(params: {
  notify?: (message: string, level?: "info" | "error") => void;
  onProgress?: (progress: RefreshProgress) => void;
}): Promise<Record<string, OrcaRouterModel>> {
  const notify = params.notify ?? (() => undefined);
  const onProgress = params.onProgress ?? (() => undefined);

  onProgress({ stage: "list", message: "Fetching model catalog..." });
  const models = await fetchModelCatalog();
  const total = Object.keys(models).length;
  if (total === 0) throw new Error("OrcaRouter returned an empty model catalog");

  const chatCount = assembleModels(models).length;
  notify(`Fetched ${total} models (${chatCount} usable as chat models)`, "info");
  onProgress({ stage: "done", current: total, total, message: "Done" });
  return models;
}

export async function fetchModels(
  ctx: Pick<ExtensionCommandContext, "ui">,
  onProgress?: (progress: RefreshProgress) => void,
): Promise<Record<string, OrcaRouterModel> | null> {
  try {
    return await refreshOrcaRouterModels({
      notify: (message, level) => ctx.ui.notify(message, level),
      onProgress,
    });
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return null;
  }
}
