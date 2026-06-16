/**
 * OrcaRouter Provider Extension
 *
 * Registers OrcaRouter as a model provider with dynamically fetched models.
 *
 * Setup:
 *   1. Get an API key from https://orcarouter.ai
 *   2. Add to auth.json in the agent config dir (~/.pi/agent/auth.json, or set PI_CODING_AGENT_DIR):
 *      { "orcarouter": { "type": "api_key", "key": "your-key" } }
 *   3. Run /orcarouter-refresh to fetch the latest model catalog
 *   4. Use /model or ctrl+l to select an OrcaRouter model
 *
 * A single endpoint is used to build the model list:
 *   - GET https://api.orcarouter.ai/v1/models  -> full catalog with metadata
 *
 * Raw /v1/models responses are cached at <agentDir>/cache/orcarouter-models.json
 * so the provider assembly can be debugged and re-derived without re-fetching.
 *
 * Startup behavior:
 *   - Missing cache: uses baked-in GENERATED_MODELS (generated via
 *     `npm run generate-models` and committed to the repo).
 *   - Stale cache (>30 days): uses the cached data immediately and triggers a visible refresh
 *     on session_start that shows progress in the UI widget.
 *   - Fresh cache: uses cached data directly, no refresh triggered.
 *
 * Only chat-capable models (those exposing the "openai" endpoint) are registered.
 */

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GENERATED_MODELS } from "./models.generated.ts";
import {
  assembleModels,
  fetchModels,
  ORCAROUTER_BASE,
  type RefreshProgress,
  readCacheState,
  writeCache,
} from "./models.ts";

// --- Registrations ---

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("orcarouter", {
    name: "OrcaRouter",
    baseUrl: `${ORCAROUTER_BASE}/v1`,
    apiKey: "$ORCAROUTER_API_KEY",
    api: "openai-completions",
    models,
  });
}

function renderProgressBar(current: number, total: number, width = 15): string {
  if (total <= 0) return `[${"░".repeat(width)}]`;
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function createRefreshProgressUi(ctx: Pick<ExtensionCommandContext, "ui">) {
  const key = "orcarouter-refresh";
  return {
    update(progress: RefreshProgress) {
      const current = progress.current ?? 0;
      const total = progress.total ?? 0;
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      const stage = progress.stage === "list" ? "Fetching catalog" : "Done";
      const summary = total > 0 ? `${current}/${total} (${percent}%)` : progress.message;
      const line = `🐳 OrcaRouter - ${stage} — ${summary} ${renderProgressBar(current, total)}`;

      ctx.ui.setWorkingMessage(`Refreshing OrcaRouter models - ${stage.toLowerCase()}`);
      ctx.ui.setWidget(key, [line], { placement: "belowEditor" });
    },
    clear() {
      ctx.ui.setWidget(key, undefined);
      ctx.ui.setStatus(key, undefined);
      ctx.ui.setWorkingMessage();
    },
  };
}

async function runRefresh(pi: ExtensionAPI, ctx: Pick<ExtensionCommandContext, "ui">) {
  const progressUi = createRefreshProgressUi(ctx);
  try {
    progressUi.update({ stage: "list", message: "Starting refresh..." });

    const raw = await fetchModels(ctx, (progress) => progressUi.update(progress));
    if (!raw) return false;

    writeCache(raw);
    const newModels = assembleModels(raw);

    registerProvider(pi, newModels);

    ctx.ui.notify(`Registered ${newModels.length} OrcaRouter models`, "info");
    return true;
  } finally {
    progressUi.clear();
  }
}

function registerRefreshCommand(pi: ExtensionAPI) {
  pi.registerCommand("orcarouter-refresh", {
    description: "Refresh OrcaRouter models from the API",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runRefresh(pi, ctx);
    },
  });
}

// --- Main ---

export default async function (pi: ExtensionAPI) {
  const cacheState = readCacheState();
  // Auto-refresh only when the disk cache is stale (>30 days).
  // When cache is missing, GENERATED_MODELS serves as the cache —
  // it is generated via `npm run generate-models` and committed to the repo.
  const needsStartupRefresh = cacheState.status === "stale";
  // GENERATED_MODELS ships with the package. Used when no local cache exists.
  // A fresh user cache from /orcarouter-refresh takes precedence over it.
  const models = cacheState.status === "missing" ? GENERATED_MODELS : assembleModels(cacheState.models);

  registerProvider(pi, models);
  registerRefreshCommand(pi);

  if (needsStartupRefresh) {
    let started = false;
    pi.on("session_start", async (_event, ctx) => {
      if (started) return;
      started = true;
      await runRefresh(pi, ctx);
    });
  }
}
