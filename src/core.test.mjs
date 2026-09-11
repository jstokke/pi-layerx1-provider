/**
 * Unit tests for the Layer X1 extension's core logic.
 * Run: node --test
 * All HTTP is mocked; the live API is never contacted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTHROPIC_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TOKENS_REASONING,
  DISCOVERY_TIMEOUT_MS,
  OPENAI_BASE_URL,
  DiscoveryError,
  defaultAuthPath,
  defaultOverridesPath,
  fetchCatalog,
  getDefaultMaxTokens,
  loadModelOverrides,
  parseCatalog,
  readStoredApiKey,
  resolveApiKey,
  toPiModel,
  toPiModels,
} from "./core.mjs";

function okFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function representativeCatalog() {
  return {
    object: "list",
    data: [
      {
        id: "lx1-gpt-oss-120b",
        object: "model",
        created: 1735689600,
        owned_by: "sideren",
        delivery: "exact",
        aliases: ["gpt-oss-120b"],
        tier: "workhorse",
        context_window: 131072,
        max_output: 32768,
        capabilities: { tools: true, reasoning: false, vision: false, documents: false },
        pricing_usd_per_mtok: { input: 0.05, output: 0.35, cached_input: null },
      },
      {
        id: "lx1-glm-5",
        object: "model",
        created: 1735689600,
        owned_by: "layerx1",
        tier: "coding",
        context_window: 1000000,
        max_output: 65536,
        capabilities: { tools: true, reasoning: true, vision: false, documents: false },
        pricing_usd_per_mtok: { input: 1.4, output: 4.4, cached_input: 0.14 },
      },
      {
        id: "lx1-fable-5",
        object: "model",
        created: 1735689600,
        owned_by: "layerx1",
        tier: "frontier",
        context_window: 1000000,
        max_output: 32768,
        capabilities: { tools: true, reasoning: true, vision: true, documents: false },
        pricing_usd_per_mtok: { input: 10, output: 50, cached_input: null },
      },
    ],
  };
}

// ---------- /models response parsing ----------

test("parses a representative /v1/models response", () => {
  const models = parseCatalog(representativeCatalog());
  assert.equal(models.length, 3);
  const fast = models.find((m) => m.id === "lx1-gpt-oss-120b");
  assert.equal(fast.contextLength, 131072);
  assert.equal(fast.maxTokens, 32768);
  assert.equal(fast.ownedBy, "sideren");
  assert.equal(fast.reasoning, false);
  assert.equal(fast.vision, false);
  assert.deepEqual(fast.pricing, { input: 0.05, output: 0.35, cacheRead: 0, cacheWrite: 0 });
});

test("reasoning and vision flags come from capabilities", () => {
  const models = parseCatalog(representativeCatalog());
  const coding = models.find((m) => m.id === "lx1-glm-5");
  assert.equal(coding.reasoning, true);
  assert.equal(coding.vision, false);
  const frontier = models.find((m) => m.id === "lx1-fable-5");
  assert.equal(frontier.reasoning, true);
  assert.equal(frontier.vision, true);
});

test("cached_input pricing maps to cacheRead", () => {
  const models = parseCatalog(representativeCatalog());
  const coding = models.find((m) => m.id === "lx1-glm-5");
  assert.equal(coding.pricing.cacheRead, 0.14);
  assert.equal(coding.pricing.cacheWrite, 0);
});

test("exact model IDs are preserved verbatim", () => {
  const pi = toPiModels(parseCatalog(representativeCatalog()));
  const ids = pi.map((m) => m.id);
  assert.deepEqual(ids, ["lx1-gpt-oss-120b", "lx1-glm-5", "lx1-fable-5"]);
});

test("missing optional metadata does not crash and falls back to defaults", () => {
  const models = parseCatalog({ data: [{ id: "lx1-new-thing" }] });
  assert.equal(models.length, 1);
  assert.equal(models[0].reasoning, false);
  assert.equal(models[0].vision, false);
  assert.equal(models[0].pricing, undefined);
  const pi = toPiModel(models[0]);
  assert.equal(pi.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(pi.maxTokens, DEFAULT_MAX_TOKENS);
  assert.deepEqual(pi.input, ["text"]);
  assert.deepEqual(pi.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("vision models advertise image input", () => {
  const pi = toPiModels(parseCatalog(representativeCatalog()));
  const frontier = pi.find((m) => m.id === "lx1-fable-5");
  assert.deepEqual(frontier.input, ["text", "image"]);
  const fast = pi.find((m) => m.id === "lx1-gpt-oss-120b");
  assert.deepEqual(fast.input, ["text"]);
});

test("reasoning models get the higher maxTokens fallback when max_output is missing", () => {
  const models = parseCatalog({
    data: [
      { id: "lx1-thinker", capabilities: { reasoning: true } },
      { id: "lx1-plain", capabilities: { reasoning: false } },
    ],
  });
  assert.equal(toPiModel(models[0]).maxTokens, DEFAULT_MAX_TOKENS_REASONING);
  assert.equal(toPiModel(models[1]).maxTokens, DEFAULT_MAX_TOKENS);
});

test("catalog max_output wins; overrides only raise", () => {
  const [model] = parseCatalog(representativeCatalog());
  // model.maxTokens is 32768 here.
  const raised = toPiModel(model, new Map([["lx1-gpt-oss-120b", { maxTokens: 65536 }]]));
  assert.equal(raised.maxTokens, 65536);
  const lowered = toPiModel(model, new Map([["lx1-gpt-oss-120b", { maxTokens: 1024 }]]));
  assert.equal(lowered.maxTokens, 32768);
});

test("malformed payloads throw DiscoveryError", () => {
  for (const bad of [null, [], {}, { data: "nope" }, { data: [] }, { data: [{}] }, { data: [{ id: "" }] }]) {
    assert.throws(() => parseCatalog(bad), DiscoveryError);
  }
});

// ---------- fetchCatalog (unauthenticated) ----------

test("fetchCatalog sends no Authorization header", async () => {
  let seenHeaders;
  const models = await fetchCatalog({
    fetchImpl: async (_url, opts) => {
      seenHeaders = opts.headers;
      return { ok: true, status: 200, json: async () => representativeCatalog() };
    },
  });
  assert.equal(models.length, 3);
  assert.ok(!("Authorization" in (seenHeaders ?? {})));
  assert.ok(!("authorization" in (seenHeaders ?? {})));
});

test("fetchCatalog hits the Layer X1 catalog URL by default", async () => {
  let seenUrl;
  await fetchCatalog({
    fetchImpl: async (url, _opts) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => representativeCatalog() };
    },
  });
  assert.equal(seenUrl, "https://api.layerx1.com/v1/models");
});

test("fetchCatalog throws DiscoveryError on HTTP failure without leaking a key", async () => {
  await assert.rejects(
    fetchCatalog({ fetchImpl: okFetch({}) }).then(
      () => { throw new Error("should have thrown"); },
      (err) => {
        assert.ok(err instanceof DiscoveryError);
        assert.ok(!String(err.message).includes("lx1_"));
        throw err;
      }
    ),
    DiscoveryError
  );
  await assert.rejects(
    fetchCatalog({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }),
    DiscoveryError
  );
});

// ---------- base URLs ----------

test("base URLs match the documented gateway shape", () => {
  assert.equal(OPENAI_BASE_URL, "https://api.layerx1.com/v1");
  assert.equal(ANTHROPIC_BASE_URL, "https://api.layerx1.com");
  assert.ok(DISCOVERY_TIMEOUT_MS > 0);
});

// ---------- api key resolution ----------

test("resolveApiKey prefers env over stored credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "lx1-auth-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ layerx1: { type: "api_key", key: "lx1_stored" } }));
  assert.equal(
    resolveApiKey({ env: { LAYERX1_API_KEY: "lx1_env" }, authPath }),
    "lx1_env"
  );
  assert.equal(resolveApiKey({ env: {}, authPath }), "lx1_stored");
  assert.equal(resolveApiKey({ env: {}, authPath: join(dir, "missing.json") }), undefined);
});

test("readStoredApiKey ignores wrong shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lx1-auth2-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ layerx1: { type: "other", key: "lx1_x" } }));
  assert.equal(readStoredApiKey("layerx1", authPath), undefined);
});

test("default paths live under the Pi agent dir", () => {
  assert.ok(defaultAuthPath({ env: {} }).endsWith("auth.json"));
  assert.ok(defaultOverridesPath({ env: {} }).endsWith("layerx1-model-overrides.json"));
  assert.ok(
    defaultAuthPath({ env: { PI_CODING_AGENT_DIR: "/tmp/x" } }).startsWith("/tmp/x")
  );
});

// ---------- maxTokens defaults ----------

test("getDefaultMaxTokens honors LAYERX1_DEFAULT_MAX_TOKENS and rejects garbage", () => {
  assert.equal(getDefaultMaxTokens({ env: { LAYERX1_DEFAULT_MAX_TOKENS: "12345" } }), 12345);
  assert.equal(getDefaultMaxTokens({ env: { LAYERX1_DEFAULT_MAX_TOKENS: "12.5" } }), DEFAULT_MAX_TOKENS);
  assert.equal(getDefaultMaxTokens({ env: { LAYERX1_DEFAULT_MAX_TOKENS: "abc" } }), DEFAULT_MAX_TOKENS);
  assert.equal(getDefaultMaxTokens({ env: {}, reasoning: true }), DEFAULT_MAX_TOKENS_REASONING);
});

// ---------- overrides ----------

test("loadModelOverrides matches by id and normalized name", () => {
  const dir = mkdtempSync(join(tmpdir(), "lx1-ov-"));
  const p = join(dir, "overrides.json");
  writeFileSync(p, JSON.stringify({ "lx1-glm-5": { maxTokens: 131072 }, "Fable 5": { contextWindow: 500000 } }));
  const map = loadModelOverrides({ path: p });
  assert.equal(map.get("lx1-glm-5").maxTokens, 131072);
  const [model] = parseCatalog({ data: [{ id: "lx1-glm-5" }] });
  assert.equal(toPiModel(model, map).maxTokens, 131072);
});

test("loadModelOverrides returns an empty map for missing or malformed files", () => {
  assert.equal(loadModelOverrides({ path: "/nonexistent/lx1.json" }).size, 0);
  const dir = mkdtempSync(join(tmpdir(), "lx1-ov2-"));
  const p = join(dir, "bad.json");
  writeFileSync(p, "not json");
  assert.equal(loadModelOverrides({ path: p }).size, 0);
});

// ---------- pi model meta ----------

test("toPiModel stamps provider meta when given", () => {
  const [model] = parseCatalog(representativeCatalog());
  const pi = toPiModel(model, undefined, undefined, {
    provider: "layerx1",
    api: "openai-completions",
    baseUrl: OPENAI_BASE_URL,
  });
  assert.equal(pi.provider, "layerx1");
  assert.equal(pi.api, "openai-completions");
  assert.equal(pi.baseUrl, OPENAI_BASE_URL);
});
