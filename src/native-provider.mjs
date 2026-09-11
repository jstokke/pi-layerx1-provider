/**
 * Native Pi provider wiring for Layer X1.
 *
 * Produces a Provider object suitable for `pi.registerProvider()` that
 * participates in Pi's `/login` and `/logout` flows: masked secret input,
 * `auth.json` persistence, status display in the selector — all handled by
 * Pi itself once we expose the standard `auth.apiKey` block.
 *
 * Pure module: takes dependencies as args so tests can mock HTTP and the
 * auth.json reader. No top-level side effects.
 *
 * Two providers share one credential — both `check()`/`resolve()` read the
 * `layerx1` key from `auth.json`, so logging into either via `/login`
 * authenticates both.
 *
 * The catalog endpoint is unauthenticated, so `refreshModels()` fetches the
 * live list whenever the network is allowed — even before login. The model
 * picker is populated on first launch; the API key is only needed to send
 * requests.
 */

import {
  stream as compatStream,
  streamSimple as compatStreamSimple,
} from "@earendil-works/pi-ai/compat";
import {
  fetchCatalog as defaultFetchCatalog,
  loadModelOverrides as defaultLoadModelOverrides,
  readStoredApiKey,
  toPiModels,
} from "./core.mjs";

/**
 * Shape we expect Pi to pass into `login()` and the credential-related
 * callbacks. Pi's runtime types live in `@earendil-works/pi-ai` and aren't
 * exported as TS interfaces, so we declare what we use.
 *
 * @typedef {object} Interaction
 * @property {(opts: { type: "text" | "secret" | "select"; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> }) => Promise<string>} prompt
 * @property {AbortSignal} [signal]
 *
 * @typedef {{ type: "api_key"; key: string }} ApiKeyCredential
 *
 * @typedef {object} AuthContext
 * @property {(name: string) => Promise<string | undefined>} env
 *
 * @typedef {object} RefreshModelsContext
 * @property {boolean} [allowNetwork]
 * @property {ApiKeyCredential | undefined} credential
 * @property {() => Promise<boolean>} publish
 * @property {{ models?: unknown[] } | undefined} stored
 * @property {AbortSignal} signal
 */

/**
 * Options for `createLayerX1Provider`. All fields are dependency
 * injections for testability.
 *
 * @typedef {object} CreateProviderOptions
 * @property {string} id                       Provider id (e.g. "layerx1")
 * @property {string} name                     Display name shown in Pi UI
 * @property {string} baseUrl                  baseUrl registered with Pi
 * @property {"openai-completions" | "anthropic-messages"} api  wire protocol
 * @property {typeof defaultFetchCatalog} [fetchCatalog]  Catalog fetcher (defaults to core.mjs)
 * @property {typeof defaultLoadModelOverrides} [loadModelOverridesFn]  Per-model overrides loader
 * @property {(id: string, authPath?: string) => string | undefined} [readStoredApiKeyFn]
 *   Auth.json reader (defaults to core.mjs readStoredApiKey)
 * @property {Record<string, string>} [extraHeaders]  Extra headers for every request
 */

/**
 * Resolve the API key for this provider, in the documented order:
 *   1. auth.json credential passed in by Pi (this provider's key)
 *   2. auth.json credential for the shared "layerx1" key (fallback
 *      so logging into the openai provider also unblocks the anthropic
 *      provider and vice versa)
 *   3. LAYERX1_API_KEY env var
 * Returns undefined when no source has a key. Never throws.
 */
function resolveKey(credential, readStoredApiKeyFn) {
  const fromProvider = credential?.key;
  const storedShared =
    !fromProvider && readStoredApiKeyFn
      ? readStoredApiKeyFn("layerx1")
      : undefined;
  const envKey =
    !fromProvider && !storedShared
      ? (process.env.LAYERX1_API_KEY || "").trim()
      : undefined;
  return fromProvider ?? storedShared ?? (envKey || undefined);
}

/**
 * Label the source for `/login`'s status display. Callers only invoke this
 * after resolveKey() returned a key, so the final fallback is unreachable
 * in practice — it exists to keep the return type a plain string.
 */
function resolveSource(credential, readStoredApiKeyFn) {
  if (credential?.key) return "stored credential";
  if (readStoredApiKeyFn && readStoredApiKeyFn("layerx1")) return "stored credential";
  const env = (process.env.LAYERX1_API_KEY || "").trim();
  return env ? "LAYERX1_API_KEY" : "stored credential";
}

/**
 * Creates one Layer X1 provider (one wire protocol). Two of these are
 * registered per extension — one for `openai-completions`, one for
 * `anthropic-messages`. Both share the same `layerx1` auth.json key and
 * publish the same catalog; only the wire metadata differs.
 *
 * The returned object is the runtime `Provider` shape Pi accepts via
 * `registerProvider`. The catalog fetch is lazy — Pi calls
 * `refreshModels()` on first model use and on `/model` refresh, never at
 * extension startup.
 *
 * @param {CreateProviderOptions} options
 */
export function createLayerX1Provider(options) {
  const {
    id,
    name,
    baseUrl,
    api,
    fetchCatalog = defaultFetchCatalog,
    loadModelOverridesFn = defaultLoadModelOverrides,
    readStoredApiKeyFn = readStoredApiKey,
    extraHeaders,
  } = options;

  // Per-model overrides are read once at provider creation; Pi passes the
  // same Map across refreshModels calls in the same session.
  const modelOverrides = loadModelOverridesFn();

  // Per-provider catalog. Empty until the first `refreshModels()` restores
  // the persisted snapshot or a live fetch publishes one.
  let models = [];

  /** Provider-scoped metadata stamped onto every model we publish. */
  const modelMeta = { provider: id, api, baseUrl };

  /**
   * Normalize a persisted model entry for this provider. Legacy entries
   * (written before provider/api/baseUrl were stamped) are backfilled; an
   * entry claiming a different provider is dropped rather than cross-wired.
   */
  function normalizeStoredModel(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === "") return undefined;
    if (entry.provider !== undefined && entry.provider !== id) return undefined;
    return {
      ...entry,
      provider: id,
      api: entry.api ?? api,
      baseUrl: entry.baseUrl ?? baseUrl,
    };
  }

  /**
   * Build the `auth.apiKey` block. Both providers expose this so `/login`
   * shows both in the selector and either login authenticates both via the
   * shared `layerx1` auth.json key.
   */
  function buildAuthMethod() {
    return {
      name,
      async login(interaction) {
        const entered = (
          await interaction.prompt({
            type: "secret",
            message: `${name} API key`,
            placeholder: "lx1_…",
          })
        ).trim();
        if (!entered) {
          throw new Error(`${name}: empty API key — login cancelled.`);
        }
        // No live validation: GET /v1/models is unauthenticated, so a
        // catalog fetch cannot tell a good key from a bad one. The key is
        // verified on first use; a bad key surfaces as a 401 there.
        // Basic shape check catches paste mistakes early without network.
        if (!/^lx1_/.test(entered)) {
          throw new Error(`${name}: that does not look like a Layer X1 key (expected to start with "lx1_").`);
        }
        return { type: "api_key", key: entered };
      },
      async check({ ctx, credential }) {
        const key = resolveKey(credential, readStoredApiKeyFn);
        void ctx;
        return key ? { type: "api_key", source: resolveSource(credential, readStoredApiKeyFn) } : undefined;
      },
      async resolve({ ctx, credential }) {
        const key = resolveKey(credential, readStoredApiKeyFn);
        void ctx;
        if (!key) return undefined;
        return {
          auth: { apiKey: key, ...(extraHeaders ? { headers: extraHeaders } : {}) },
          source: resolveSource(credential, readStoredApiKeyFn),
        };
      },
    };
  }

  return {
    id,
    name,
    baseUrl,
    api,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
    auth: {
      apiKey: buildAuthMethod(),
    },
    getModels: () => models,
    // Native providers without a models.json overlay are used raw by Pi's
    // model runtime, so stream dispatch must live here. The compat
    // streamers pick the wire implementation from model.api (which every
    // published model carries) and receive the resolved apiKey/headers
    // through `options`.
    stream: (model, context, options) => compatStream(model, context, options),
    streamSimple: (model, context, options) => compatStreamSimple(model, context, options),
    async refreshModels(context) {
      // Offline restore first: Pi runs a cache-only refresh phase at
      // startup (before login and before any network access). Republishing
      // the persisted catalog keeps /model populated even when the network
      // phase is skipped or fails — matching pi's own remote catalog and
      // llama.cpp providers.
      const storedModels = Array.isArray(context.stored?.models) ? context.stored.models : [];
      if (storedModels.length > 0) {
        const restored = storedModels.map(normalizeStoredModel).filter((m) => m !== undefined);
        if (restored.length > 0) {
          const ok = await context.publish({
            update: () => {
              models = restored;
            },
          });
          if (!ok) return;
        }
      }

      if (!context.allowNetwork) return;
      if (context.signal.aborted) return;

      // The catalog is unauthenticated: fetch it even before login so the
      // /model picker is useful on first launch. Failures keep the
      // restored snapshot; the next refresh retries.
      let catalog;
      try {
        catalog = await fetchCatalog({ signal: context.signal });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`Layer X1: ${id} catalog fetch failed: ${reason}`);
        return;
      }

      if (context.signal.aborted) return;

      // Every model works on every endpoint (native_wires is informational),
      // so both providers publish the full catalog with their own wire meta.
      const filtered = toPiModels(catalog, modelOverrides, undefined, modelMeta);

      // Pi's publish() can return false (e.g. when cancelled mid-update);
      // only persist when it succeeds so we don't write a stale snapshot.
      const published = await context.publish({
        update: () => {
          models = filtered;
        },
      });
      if (!published) return;

      await context.publish({
        persist: { models: filtered, checkedAt: Date.now() },
      });

      models = filtered;
    },
  };
}
