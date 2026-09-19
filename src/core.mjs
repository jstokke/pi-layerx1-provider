/**
 * Layer X1 provider — core logic (pure, testable, no Pi imports).
 *
 * Layer X1 API contract (https://docs.layerx1.com):
 *   GET  https://api.layerx1.com/v1/models            — live catalog (UNAUTHENTICATED)
 *   POST https://api.layerx1.com/v1/chat/completions  — OpenAI wire
 *   POST https://api.layerx1.com/v1/messages          — Anthropic wire
 *
 * The catalog endpoint is unauthenticated and cacheable
 * (`cache-control: public, max-age=300`), so the model list is available
 * before login. Every entry is self-describing: capabilities, limits, and
 * list pricing ship in the response, so no docs scraping is needed.
 *
 * Invariant: Pi model ids are always Layer X1's canonical catalog ids
 * (e.g. `lx1-glm-5`), verbatim. Every model works on every endpoint —
 * Layer X1's `native_wires` field is informational only — so both
 * providers publish the full catalog and differ only in wire protocol.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ROOT = "https://api.layerx1.com";
/** OpenAI SDK appends /chat/completions to baseUrl. */
export const OPENAI_BASE_URL = `${PROVIDER_ROOT}/v1`;
/** Anthropic SDK appends /v1/messages to baseURL. */
export const ANTHROPIC_BASE_URL = PROVIDER_ROOT;

/**
 * Conservative defaults for fields the catalog may omit.
 * They exist only because Pi's model definition requires them; they are not
 * claims about the models. Override per model via
 * ~/.pi/agent/layerx1-model-overrides.json (see loadModelOverrides())
 * or LAYERX1_DEFAULT_MAX_TOKENS (see getDefaultMaxTokens()).
 *
 * DEFAULT_MAX_TOKENS is set generously to keep reasoning models from being
 * truncated mid-stream (Pi raises "Response was truncated before completion."
 * when finish_reason=length is returned because the cap was too tight for
 * the model's thinking budget).
 */
/**
 * Non-reasoning output ceiling. Layer X1 publishes `max_output` per model
 * (e.g. 32768 for lx1-gpt-oss-120b); this fallback only applies when the
 * catalog omits it.
 */
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const DEFAULT_MAX_TOKENS = 65536;

/**
 * Reasoning-model output ceiling. The auto-bump exists because Pi's
 * truncation error disproportionately hits reasoning models — their
 * thinking budget can consume tens of thousands of tokens before the final
 * answer. Applied only when the catalog omits max_output AND no override /
 * env var is set, so models with a known lower ceiling are never overshot.
 */
export const DEFAULT_MAX_TOKENS_REASONING = 131072;

/**
 * Output-token ceiling enforced per request by Layer X1's Free plan
 * (403 plan_upgrade_required above it). Paid plans accept much larger
 * limits, so this is never published on models — it is only a request-time
 * ceiling once a Free plan is detected (via LAYERX1_PLAN=free,
 * LAYERX1_MAX_TOKENS, or a learned plan_upgrade_required rejection).
 * Also the fallback when the gateway error does not state the limit.
 */
export const FREE_PLAN_MAX_TOKENS = 4096;

/** Startup must stay bounded: single attempt, no meaningful retry delay. */
export const DISCOVERY_TIMEOUT_MS = 8000;

export class DiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * Resolve the Layer X1 API key without ever hardcoding it.
 * Order: LAYERX1_API_KEY env var, then the stored "layerx1"
 * credential in Pi's auth.json (type "api_key").
 */
export function resolveApiKey({ env = process.env, authPath } = {}) {
  const fromEnv = env.LAYERX1_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return readStoredApiKey("layerx1", authPath);
}

export function defaultAuthPath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "auth.json");
}

/**
 * Resolve the global maxTokens default.
 * Order: LAYERX1_DEFAULT_MAX_TOKENS env var (positive integer), else
 * the compile-time DEFAULT_MAX_TOKENS constant. Invalid env values fall
 * back silently — the constant is always the floor.
 */
export function getDefaultMaxTokens({ env = process.env, reasoning = false } = {}) {
  const raw = env.LAYERX1_DEFAULT_MAX_TOKENS;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Reject anything that is not pure digits so "12.5" / "1e3" / "abc"
    // fall back to the per-class default rather than being silently
    // truncated by parseInt.
    if (trimmed !== "" && /^[0-9]+$/.test(trimmed)) {
      const n = Number.parseInt(trimmed, 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  // No env var (or invalid): pick the per-class default. Reasoning models
  // get a higher ceiling because their thinking budget can consume tens of
  // thousands of tokens before the final answer.
  return reasoning ? DEFAULT_MAX_TOKENS_REASONING : DEFAULT_MAX_TOKENS;
}

/** Parse a positive-integer env var; missing or garbage → undefined. */
export function parsePositiveIntEnv(env, name) {
  const raw = env?.[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Explicit per-request output ceiling from LAYERX1_MAX_TOKENS. Unlike
 * LAYERX1_DEFAULT_MAX_TOKENS (a fallback default used only when the
 * catalog omits max_output), this caps every request — the escape hatch
 * for Free-plan keys and for anyone who wants a hard output budget.
 */
export function getExplicitMaxTokens({ env = process.env } = {}) {
  return parsePositiveIntEnv(env, "LAYERX1_MAX_TOKENS");
}

/** True when LAYERX1_PLAN=free (case-insensitive, surrounding space ok). */
export function isFreePlan({ env = process.env } = {}) {
  const raw = env?.LAYERX1_PLAN;
  return typeof raw === "string" && raw.trim().toLowerCase() === "free";
}

/**
 * Effective per-request output ceiling: the lowest of the explicit
 * LAYERX1_MAX_TOKENS, the Free-plan cap (when LAYERX1_PLAN=free), and a
 * previously learned plan cap. Undefined means no ceiling — full catalog
 * limits go out, which is correct for paid plans.
 */
export function resolveOutputCeiling({ env = process.env, learnedCap } = {}) {
  const candidates = [
    getExplicitMaxTokens({ env }),
    isFreePlan({ env }) ? FREE_PLAN_MAX_TOKENS : undefined,
    learnedCap,
  ].filter((v) => v !== undefined);
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

/** Human-readable text out of an error-ish value (Error, string, or Pi's
 * assistant-message object carrying errorMessage). Never includes secrets:
 * callers only pass gateway-shaped failures, which carry none. */
function errorText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const m = value.errorMessage ?? value.message;
    if (typeof m === "string") return m;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** True when the failure is Layer X1's plan-upgrade rejection. */
export function isPlanUpgradeError(value) {
  return errorText(value).includes("plan_upgrade_required");
}

/**
 * Learn the plan's output cap from a plan_upgrade_required failure.
 * Parses "up to N output tokens" from the gateway message so the client
 * tracks the current Free-plan limit without hardcoding it; falls back to
 * FREE_PLAN_MAX_TOKENS when the limit isn't stated. Returns undefined for
 * unrelated errors so callers only ever learn from the real signal.
 */
export function parsePlanCapFromError(value) {
  const text = errorText(value);
  if (!text.includes("plan_upgrade_required")) return undefined;
  const match = text.match(/up to\s+([\d,]+)\s+output tokens/i);
  if (match) {
    const n = Number.parseInt(match[1].replace(/,/g, ""), 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return FREE_PLAN_MAX_TOKENS;
}

/** Lower a maxTokens value down to a ceiling; undefined ceiling (or value)
 * passes through untouched — ceilings only ever shrink, never raise. */
export function applyOutputCeiling(value, ceiling) {
  if (ceiling === undefined || value === undefined) return value;
  return Math.min(value, ceiling);
}

/** Path to the optional per-model override file (see README). */
export function defaultOverridesPath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "layerx1-model-overrides.json");
}

/** Positive integer or undefined; everything else is rejected. */
function validatePositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Clean a single override entry. Returns undefined if no usable fields. */
function normalizeOverride(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const maxTokens = validatePositiveInt(entry.maxTokens);
  const contextWindow = validatePositiveInt(entry.contextWindow);
  if (maxTokens === undefined && contextWindow === undefined) return undefined;
  return { maxTokens, contextWindow };
}

/**
 * Load per-model overrides from JSON. Keys can be exact model ids or
 * normalized display names (whitespace + punctuation stripped, lowercased)
 * so users do not have to match the catalog's name formatting exactly.
 * Id wins on conflict. Missing file → empty Map. Malformed JSON or wrong
 * top-level shape logs one line and returns an empty Map; a single bad
 * entry is silently dropped.
 */
export function loadModelOverrides({
  path = defaultOverridesPath(),
  fsImpl = { readFileSync },
} = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Layer X1: ignoring " + path + ": not valid JSON.");
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("Layer X1: ignoring " + path + ": expected a JSON object at the top level.");
    return new Map();
  }
  const out = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || key.trim() === "") continue;
    const cleaned = normalizeOverride(value);
    if (!cleaned) continue;
    const exact = key.trim();
    if (!out.has(exact)) out.set(exact, cleaned);
    const normalized = exact.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized && !out.has(normalized)) out.set(normalized, cleaned);
  }
  return out;
}
export function readStoredApiKey(providerId, authPath = defaultAuthPath()) {
  try {
    const data = JSON.parse(readFileSync(authPath, "utf8"));
    const cred = data?.[providerId];
    if (cred && cred.type === "api_key" && typeof cred.key === "string" && cred.key !== "") {
      return cred.key;
    }
  } catch {
    // Missing or unreadable auth.json is not fatal; caller reports a
    // missing-key diagnostic instead.
  }
  return undefined;
}

/** A finite non-negative number, or the fallback. Null/missing → fallback. */
function asNonNegativeNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** In-flight default catalog requests shared by both wire providers. */
const inFlightCatalogRequests = new Map();

/**
 * Fetch and parse the live catalog. The endpoint is unauthenticated, so no
 * API key is required (or sent). Throws DiscoveryError with a concise,
 * key-free message on HTTP failure, timeout, or malformed body.
 *
 * Pi registers the OpenAI and Anthropic wires as separate providers and
 * refreshes them concurrently. They use the same catalog, so coalesce only
 * concurrent calls made with the real fetch implementation; injected fetchers
 * remain fully independent for tests and callers that need isolation.
 */
export function fetchCatalog(options = {}) {
  const {
    url = `${PROVIDER_ROOT}/v1/models`,
    timeoutMs = DISCOVERY_TIMEOUT_MS,
    fetchImpl = fetch,
    signal,
  } = options;
  const key = `${url}\u0000${timeoutMs}`;
  if (fetchImpl !== fetch || signal?.aborted) {
    return fetchCatalogOnce({ url, timeoutMs, fetchImpl, signal });
  }

  const existing = inFlightCatalogRequests.get(key);
  if (existing) return existing;

  const request = fetchCatalogOnce({ url, timeoutMs, fetchImpl, signal });
  inFlightCatalogRequests.set(key, request);
  return request.finally(() => {
    if (inFlightCatalogRequests.get(key) === request) inFlightCatalogRequests.delete(key);
  });
}

async function fetchCatalogOnce({ url, timeoutMs, fetchImpl, signal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = timedOut
      ? `request timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new DiscoveryError(`Layer X1: model discovery failed: ${reason}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    throw new DiscoveryError(`Layer X1: model discovery failed: HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new DiscoveryError(
      `Layer X1: model discovery failed: response is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }
  return parseCatalog(payload);
}

/** Validate and normalize the /models payload. Throws on malformed input. */
export function parseCatalog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DiscoveryError("Layer X1: model discovery failed: response is not a JSON object");
  }
  const data = payload.data;
  if (!Array.isArray(data)) {
    throw new DiscoveryError("Layer X1: model discovery failed: response is missing a 'data' array");
  }
  const models = [];
  for (const [index, entry] of data.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DiscoveryError(`Layer X1: model discovery failed: data[${index}] is not an object`);
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new DiscoveryError(`Layer X1: model discovery failed: data[${index}] has no model id`);
    }
    const caps = entry.capabilities && typeof entry.capabilities === "object" ? entry.capabilities : {};
    const pricing = entry.pricing_usd_per_mtok && typeof entry.pricing_usd_per_mtok === "object"
      ? entry.pricing_usd_per_mtok
      : undefined;
    models.push({
      id: entry.id,
      name:
        (typeof entry.display_name === "string" && entry.display_name !== "" ? entry.display_name : undefined) ??
        (typeof entry.name === "string" && entry.name !== "" ? entry.name : undefined),
      ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : undefined,
      contextLength:
        typeof entry.context_window === "number" &&
        Number.isFinite(entry.context_window) &&
        entry.context_window > 0
          ? entry.context_window
          : undefined,
      maxTokens:
        typeof entry.max_output === "number" && Number.isFinite(entry.max_output) && entry.max_output > 0
          ? entry.max_output
          : undefined,
      reasoning: caps.reasoning === true,
      vision: caps.vision === true,
      // List pricing is per million tokens in USD. cached_input null means
      // the model has no cache pricing — map it to 0, never null.
      pricing: pricing
        ? {
            input: asNonNegativeNumber(pricing.input, 0),
            output: asNonNegativeNumber(pricing.output, 0),
            cacheRead: asNonNegativeNumber(pricing.cached_input, 0),
            cacheWrite: 0,
          }
        : undefined,
    });
  }
  if (models.length === 0) {
    throw new DiscoveryError("Layer X1: model discovery failed: catalog is empty");
  }
  return models;
}

/**
 * Look up a per-model override by exact id, then by normalized display
 * name. Returns undefined when no override applies.
 */
function lookupOverride(overrides, model) {
  if (!(overrides instanceof Map) || overrides.size === 0) return undefined;
  const byId = overrides.get(model.id);
  if (byId) return byId;
  const normalized = String(model.name ?? model.id).toLowerCase().replace(/[^a-z0-9]/g, "");
  return overrides.get(normalized);
}

/**
 * Resolve a numeric cap (maxTokens / contextWindow):
 *   1. Catalog value is authoritative on the LOW end (Layer X1 knows
 *      its own model's hard ceiling).
 *   2. Per-model override may raise the cap if larger.
 *   3. Else the per-class fallback — DEFAULT_MAX_TOKENS_REASONING (131072)
 *      when model.reasoning is true, DEFAULT_MAX_TOKENS (65536) otherwise.
 *      LAYERX1_DEFAULT_MAX_TOKENS overrides both uniformly.
 */
function pickCap({ fromApi, overrideEntry, field, fallback }) {
  if (fromApi !== undefined) {
    const raised = overrideEntry ? overrideEntry[field] : undefined;
    return raised !== undefined && raised > fromApi ? raised : fromApi;
  }
  const raised = overrideEntry ? overrideEntry[field] : undefined;
  return raised !== undefined ? raised : fallback;
}

/**
 * Convert one normalized catalog entry into a Pi model definition.
 *
 * `overrides` (optional Map from loadModelOverrides) raises maxTokens or
 * contextWindow above whatever the catalog reports. `defaultMaxTokens`
 * (optional) pins the fallback for tests; otherwise
 * getDefaultMaxTokens({ reasoning }) selects the per-class default
 * (131072 reasoning, 65536 non-reasoning), unless
 * LAYERX1_DEFAULT_MAX_TOKENS is set.
 */
export function toPiModel(model, overrides, defaultMaxTokens, meta) {
  const hit = lookupOverride(overrides, model);
  const reasoning = model.reasoning === true;
  // Resolve the fallback once per model. Tests can pin `defaultMaxTokens`
  // to bypass both the env var and the reasoning-aware constant.
  const fallbackMax = defaultMaxTokens ?? getDefaultMaxTokens({ reasoning });
  return {
    id: model.id, // Layer X1's exact catalog ID is preserved verbatim.
    name: model.name ?? model.id,
    // `meta` is stamped by native-provider.mjs when converting a live
    // catalog (or restoring a persisted one); tests may omit it.
    ...(meta ? { provider: meta.provider, api: meta.api, baseUrl: meta.baseUrl } : {}),
    reasoning,
    input: model.vision === true ? ["text", "image"] : ["text"],
    // Pricing comes from the catalog when available; 0 avoids fabricating
    // costs for models the catalog does not price.
    cost: model.pricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: pickCap({
      fromApi: model.contextLength,
      overrideEntry: hit,
      field: "contextWindow",
      fallback: DEFAULT_CONTEXT_WINDOW,
    }),
    maxTokens: pickCap({
      fromApi: model.maxTokens,
      overrideEntry: hit,
      field: "maxTokens",
      fallback: fallbackMax,
    }),
  };
}

export function toPiModels(models, overrides, defaultMaxTokens, meta) {
  return models.map((m) => toPiModel(m, overrides, defaultMaxTokens, meta));
}
