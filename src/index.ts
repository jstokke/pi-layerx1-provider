/**
 * Layer X1 — dynamic custom provider for Pi.
 *
 * Registers two native providers backed by the same Layer X1 account:
 *
 *   layerx1             → OpenAI Chat Completions wire (openai-completions)
 *   layerx1-anthropic   → Anthropic Messages wire (anthropic-messages)
 *
 * Auth is handled by Pi's `/login` flow. The extension exposes an
 * `auth.apiKey` block on each provider; Pi prompts with a masked secret
 * input, persists to `auth.json`, and surfaces the credential's source
 * ("stored credential" or "LAYERX1_API_KEY") in the selector. The
 * `LAYERX1_API_KEY` env var is still honored as a fallback for headless
 * setups.
 *
 * The catalog is fetched lazily — Pi calls `refreshModels()` on first model
 * use and on `/model` refresh, never at extension startup. GET /v1/models
 * is unauthenticated, so the picker is populated even before login; the
 * key is only needed to send requests.
 *
 * Per-model maxTokens / contextWindow overrides live in
 * ~/.pi/agent/layerx1-model-overrides.json (see core.mjs and README).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ANTHROPIC_BASE_URL, OPENAI_BASE_URL, readStoredApiKey } from "./core.mjs";
import { createLayerX1Provider } from "./native-provider.mjs";

export default async function (pi: ExtensionAPI) {
  // Two providers, same credential, different wire protocols. Both expose
  // auth.apiKey so /login shows both in the selector; logging into either
  // authenticates both via the shared "layerx1" auth.json key.
  const layerx1 = createLayerX1Provider({
    id: "layerx1",
    name: "Layer X1",
    baseUrl: OPENAI_BASE_URL,
    api: "openai-completions",
  });

  const layerx1Anthropic = createLayerX1Provider({
    id: "layerx1-anthropic",
    name: "Layer X1 (Anthropic)",
    baseUrl: ANTHROPIC_BASE_URL,
    api: "anthropic-messages",
  });

  pi.registerProvider(layerx1);
  pi.registerProvider(layerx1Anthropic);

  // Best-effort startup hint. The /login selector is the primary setup
  // path now; we log here so first-time users see *something* instead of
  // an empty `/model` picker. The actual credential check is cheap
  // (process.env + one auth.json read). Only warn when BOTH sources are
  // missing — a stored auth.json credential is a perfectly valid setup
  // and must not produce a scary warning on every launch.
  const hasEnv = (process.env.LAYERX1_API_KEY || "").trim() !== "";
  const hasStored = readStoredApiKey("layerx1") !== undefined;
  if (!hasEnv && !hasStored) {
    console.error(
      "Layer X1: no API key found. Run `/login layerx1` in Pi (the key is saved to ~/.pi/agent/auth.json), or set the LAYERX1_API_KEY env var before launching."
    );
  }
}
