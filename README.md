# pi-orcarouter

[OrcaRouter](https://orcarouter.ai) provider plugin for [Pi](https://github.com/earendil-works/pi) coding agent.

Registers OrcaRouter as a model provider with dynamically fetched models. OrcaRouter is an OpenAI-compatible gateway that routes to models from Anthropic, OpenAI, Google, xAI, and others through a single API key.

> This project is a fork of [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud) by [@fgrehm](https://github.com/fgrehm), adapted to target OrcaRouter instead of Ollama Cloud. 

## Features

- **Dynamic model discovery** - Fetches the full catalog from `api.orcarouter.ai/v1/models` in a single call. Each entry carries everything needed (name, context length, max tokens, input modalities, pricing), so there is no per-model detail fetch.
- **Real cost tracking** - Per-token pricing from the API is mapped into Pi's cost tracker, so usage and spend are reported accurately. Router models without published pricing (`orcarouter/*`) fall back to zero.
- **Curated thinking levels** - Maps Pi's thinking levels to the OpenAI-compatible `reasoning_effort` parameter via `thinking-levels.ts`. Reasoning-capable models are detected from their id (OrcaRouter does not expose a reasoning capability flag).
- **Baked-in model list** - A generated model list (`models.generated.ts`) ships with the extension so models are available immediately on first launch without any network calls. Updated by running `npm run generate-models` and releasing a new version.
- **Persistent cache** - Running `/orcarouter-refresh` fetches the latest catalog and caches it to `~/.pi/agent/cache/orcarouter-models.json`. On subsequent launches, this disk cache takes precedence over the baked-in list.
- **Auto-refresh on stale cache** - When the disk cache is older than 30 days, the extension uses it immediately and shows a visible refresh progress widget on the next `session_start` to pull in any new models.
- **`/orcarouter-refresh` command** - Re-fetches the catalog and updates the cache and provider registration live (no restart needed).

## Prerequisites

- An [OrcaRouter API key](https://orcarouter.ai)

## Installation

### Option 1: from npm (recommended)

```bash
pi install npm:pi-orcarouter
```

This installs the latest published version from npm. Run `pi update` to get new versions.

### Option 2: from git

```bash
pi install git:github.com/shyim/pi-orcarouter
```

This clones the repo to `~/.pi/agent/git/` and adds it to your settings.

For project-local install (stored in `.pi/git/`):

```bash
pi install git:github.com/shyim/pi-orcarouter --local
```

### Option 3: `-e` flag (try without installing)

```bash
pi -e npm:pi-orcarouter
```

### Option 4: Clone manually (if you want to make changes and "try it live")

Pi auto-discovers subdirectories under `~/.pi/agent/extensions/`:

```bash
git clone git@github.com:shyim/pi-orcarouter.git ~/.pi/agent/extensions/pi-orcarouter
```

## Setup

### 1. Get an API key

Sign up at [orcarouter.ai](https://orcarouter.ai) and generate an API key.

### 2. Configure the API key

The simplest way is the `/login` command inside Pi: run `/login`, choose **Use an API key**, pick **OrcaRouter**, and paste your key. Pi stores it in `~/.pi/agent/auth.json` and `/logout` removes it.

Alternatively, set the `ORCAROUTER_API_KEY` environment variable:

```bash
export ORCAROUTER_API_KEY="your-key"
```

Or add it to `~/.pi/agent/auth.json` by hand:

```json
{
  "orcarouter": {
    "type": "api_key",
    "key": "your-key"
  }
}
```

### 3. Fetch models (optional)

On first launch the plugin uses a baked-in model list shipped with the extension — no network calls needed. If you want the very latest models, run `/orcarouter-refresh` to fetch from the API and cache the result to disk. After that, the disk cache is used on subsequent launches.

If the disk cache is older than 30 days, the extension uses it immediately and runs a visible refresh on the next session start (progress appears in the UI widget). You can also run:

```
/orcarouter-refresh
```

This fetches the full catalog from the OrcaRouter API and overwrites the local cache.

### 4. Select a model

Use `/model` or `Ctrl+L` to switch to an OrcaRouter model. Models appear under the `orcarouter` provider, e.g. `orcarouter/anthropic/claude-opus-4.5` or `orcarouter/openai/gpt-5`.

## How it works

The plugin uses a single OrcaRouter API endpoint to build the model list:

- **`GET https://api.orcarouter.ai/v1/models`** - Returns the full catalog with all metadata.

Only chat-capable models are registered — those exposing the `openai` endpoint in `supported_endpoint_types`. Embeddings, image-generation, and video models are filtered out.

The raw `/v1/models` response is cached at `~/.pi/agent/cache/orcarouter-models.json` with a top-level `timestamp` value. If that local cache is older than 30 days, the plugin keeps using it immediately and runs a visible refresh on `session_start` (progress appears in the UI widget). If the cache is missing, the plugin uses the baked-in model list shipped with the extension (`models.generated.ts`).

Model metadata is derived from the catalog entry:

| Field | Source |
|---|---|
| `name` | `name` from the API (falls back to the model id) |
| `reasoning` | Inferred from the model id (see [`models.ts`](models.ts) `isReasoningModel`) |
| `thinkingLevelMap` | [`thinking-levels.ts`](thinking-levels.ts) with maps DEFAULT, GPT_OSS, OPENAI_REASONING |
| `input` | `["text", "image"]` if `architecture.input_modalities` includes `"image"`, else `["text"]` |
| `contextWindow` | `context_length` (falls back to `top_provider.context_length`, then 128000) |
| `maxTokens` | `max_completion_tokens` (falls back to 32768) |
| `cost` | `pricing.prompt` / `pricing.completion` per token (zero when pricing is absent) |

### Thinking level mapping

Pi's thinking levels are mapped to OrcaRouter's OpenAI-compatible `reasoning_effort` parameter in [`thinking-levels.ts`](thinking-levels.ts). Because OrcaRouter does not advertise reasoning support per model, the plugin infers it from the model id.

| Map | Models | Levels exposed | Notes |
|---|---|---|---|
| `DEFAULT` | Most reasoning models (Claude, Gemini, Grok, DeepSeek, etc.) | off, low, medium, high, xhigh | `minimal` hidden (duplicate of low) |
| `GPT_OSS` | `gpt-oss*` | low, medium, high | Can't disable thinking, no off or xhigh |
| `OPENAI_REASONING` | `gpt-5*`, `gpt-6*`, o-series | minimal, low, medium, high | No "none"; `xhigh` maps to high |

## Commands

| Command | Description |
|---|---|
| `/orcarouter-refresh` | Fetch the catalog from the OrcaRouter API, update cache, and re-register the provider |

## Development

```bash
npm install          # install devDependencies (biome)
npm run check        # lint + format with auto-fix
npm run lint         # lint only (no fixes)
npm run format       # format only
npm run test         # run the test suite
npm run generate-models  # refetch the catalog and rewrite models.generated.ts
```

The project uses [Biome](https://biomejs.dev/) for linting and formatting (2-space indent, line width 120).

## Releasing

Publishing a new version to npm is a two-command process:

```bash
# 1. Bump version and create a git tag in one step
npm version minor   # or patch, or major
# 2. Push the tag to trigger the GitHub Actions publish workflow
git push --tags
```

The tag version must match the version in `package.json` - `npm version` handles this automatically. The workflow at `.github/workflows/publish.yml` verifies the match before publishing to npm.

The workflow uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) - no tokens stored as secrets. To set it up:

1. Go to [npmjs.com](https://www.npmjs.com) → your avatar → **Packages** → `pi-orcarouter` → **Settings** → **Trusted publishing**
2. Click **GitHub Actions** and enter:
   - **Workflow filename**: `publish.yml`
3. Save

Each publish also gets automatic [provenance attestation](https://docs.npmjs.com/generating-provenance-statements).

## Notes

- The fetch timeout is 10 seconds. If the request times out (slow connection), the plugin keeps using the cached or baked-in model list.
- OrcaRouter does not expose cache-read/cache-write pricing, so those cost fields are always zero even when prompt/completion pricing is present.
