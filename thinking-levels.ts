/**
 * Thinking level mapping for OrcaRouter models.
 *
 * Maps Pi's thinking levels to the OpenAI-compatible `reasoning_effort`
 * value forwarded through the gateway. OrcaRouter does not expose a thinking
 * capability flag or per-model effort metadata, so the mapping is inferred
 * from the model id (see isReasoningModel in models.ts).
 *
 * A `null` value means the level is hidden in Pi's UI.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

/** Default reasoning map: off/low/medium/high/xhigh, minimal hidden. */
export const DEFAULT: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

/** GPT-OSS: can't disable thinking, only low/medium/high. */
export const GPT_OSS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
};

/** OpenAI reasoning models (o-series, gpt-5): support minimal, no "none". */
export const OPENAI_REASONING: ThinkingLevelMap = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

/**
 * Resolve the thinking level map for a model.
 *
 * @param id        the model id (provider-prefixed, e.g. "openai/gpt-5")
 * @param reasoning whether the model was detected as reasoning-capable
 */
export function resolve(id: string, reasoning: boolean): ThinkingLevelMap | undefined {
  if (!reasoning) return undefined;

  const lower = id.toLowerCase();
  if (lower.includes("gpt-oss")) return GPT_OSS;
  if (lower.includes("gpt-5") || lower.includes("gpt-6") || /\bo[1-9]\b/.test(lower)) return OPENAI_REASONING;

  return DEFAULT;
}
