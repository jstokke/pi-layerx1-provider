/**
 * Unit tests for the native Pi provider wiring.
 *
 * Verifies the auth flow (login / check / resolve), the lazy catalog
 * fetch in refreshModels (unauthenticated — works before login), and the
 * integration with Pi's credential semantics.
 *
 * Run: node --test
 * All HTTP, auth.json reads, and refreshModels.publish() are mocked.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createLayerX1Provider } from "./native-provider.mjs";
import { parseCatalog } from "./core.mjs";

const SECRET = "lx1_test_0123456789abcdef";

/** Minimal catalog exercising reasoning + vision flags. */
function representativeCatalog() {
  return {
    data: [
      {
        id: "lx1-gpt-oss-120b",
        context_window: 131072,
        max_output: 32768,
        capabilities: { tools: true, reasoning: false, vision: false },
        pricing_usd_per_mtok: { input: 0.05, output: 0.35, cached_input: null },
      },
      {
        id: "lx1-fable-5",
        context_window: 1000000,
        max_output: 32768,
        capabilities: { tools: true, reasoning: true, vision: true },
        pricing_usd_per_mtok: { input: 10, output: 50, cached_input: null },
      },
    ],
  };
}

/** Parse the representative through the real catalog parser. */
function parsedRepresentative() {
  return parseCatalog(representativeCatalog());
}

/** Build a fake Pi AuthInteraction that resolves prompts to `answer`. */
function fakeInteraction(answer = SECRET) {
  const prompts = [];
  return {
    signal: undefined,
    prompt: async (opts) => {
      prompts.push(opts);
      return answer;
    },
    _prompts: prompts,
  };
}

/** Build a refreshModels context with a stubbed publish(). */
function fakeRefreshContext({ apiKey, allowNetwork = true, stored } = {}) {
  const state = { published: 0, persisted: 0, lastUpdate: null };
  const controller = new AbortController();
  return {
    ctx: {
      allowNetwork,
      credential: apiKey != null ? { type: "api_key", key: apiKey } : undefined,
      stored,
      signal: controller.signal,
      publish: async (opts) => {
        if (opts.update) {
          state.lastUpdate = opts.update;
          state.lastUpdate();
        }
        if (opts.persist !== undefined) state.persisted++;
        state.published++;
        return true;
      },
      _stats: {
        get published() { return state.published; },
        get persisted() { return state.persisted; },
        get lastUpdate() { return state.lastUpdate; },
      },
    },
    controller,
  };
}

/** Fresh factory wiring with every external dependency mocked. */
function makeProvider(opts = {}) {
  return createLayerX1Provider({
    id: "layerx1",
    name: "Layer X1",
    baseUrl: "https://api.layerx1.com/v1",
    api: "openai-completions",
    fetchCatalog: async () => parsedRepresentative(),
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => undefined,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// auth.apiKey shape
// ---------------------------------------------------------------------------

test("provider exposes auth.apiKey with name, login, check, resolve", () => {
  const p = makeProvider();
  assert.equal(typeof p.auth, "object");
  assert.equal(typeof p.auth.apiKey, "object");
  assert.equal(p.auth.apiKey.name, "Layer X1");
  assert.equal(typeof p.auth.apiKey.login, "function");
  assert.equal(typeof p.auth.apiKey.check, "function");
  assert.equal(typeof p.auth.apiKey.resolve, "function");
});

test("provider exposes id, name, baseUrl, getModels, refreshModels, stream", () => {
  const p = makeProvider({ id: "layerx1", api: "openai-completions" });
  assert.equal(p.id, "layerx1");
  assert.equal(p.name, "Layer X1");
  assert.equal(p.baseUrl, "https://api.layerx1.com/v1");
  assert.equal(typeof p.getModels, "function");
  assert.equal(typeof p.refreshModels, "function");
  assert.equal(typeof p.stream, "function");
  assert.equal(typeof p.streamSimple, "function");
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

test("login accepts an lx1_ key and rejects empty input", async () => {
  const p = makeProvider();
  const cred = await p.auth.apiKey.login(fakeInteraction(SECRET));
  assert.deepEqual(cred, { type: "api_key", key: SECRET });
  await assert.rejects(p.auth.apiKey.login(fakeInteraction("   ")), /empty API key/);
});

test("login rejects keys without the lx1_ prefix", async () => {
  const p = makeProvider();
  await assert.rejects(p.auth.apiKey.login(fakeInteraction("sk-bogus")), /lx1_/);
});

test("login prompts with a secret input", async () => {
  const p = makeProvider();
  const interaction = fakeInteraction(SECRET);
  await p.auth.apiKey.login(interaction);
  assert.equal(interaction._prompts.length, 1);
  assert.equal(interaction._prompts[0].type, "secret");
});

// ---------------------------------------------------------------------------
// check / resolve
// ---------------------------------------------------------------------------

test("check returns undefined without any key source", async () => {
  const p = makeProvider();
  assert.equal(await p.auth.apiKey.check({ ctx: {}, credential: undefined }), undefined);
});

test("check prefers the Pi credential, then stored, then env", async () => {
  const viaCredential = makeProvider({ readStoredApiKeyFn: () => "lx1_stored" });
  const hit = await viaCredential.auth.apiKey.check({ ctx: {}, credential: { type: "api_key", key: SECRET } });
  assert.deepEqual(hit, { type: "api_key", source: "stored credential" });

  const viaStored = makeProvider({ readStoredApiKeyFn: () => "lx1_stored" });
  const hit2 = await viaStored.auth.apiKey.check({ ctx: {}, credential: undefined });
  assert.deepEqual(hit2, { type: "api_key", source: "stored credential" });
});

test("resolve returns auth payload with the resolved key", async () => {
  const p = makeProvider();
  const out = await p.auth.apiKey.resolve({ ctx: {}, credential: { type: "api_key", key: SECRET } });
  assert.equal(out.auth.apiKey, SECRET);
  assert.equal(typeof out.source, "string");
  assert.equal(await p.auth.apiKey.resolve({ ctx: {}, credential: undefined }), undefined);
});

// ---------------------------------------------------------------------------
// refreshModels
// ---------------------------------------------------------------------------

test("refreshModels fetches without a key (catalog is unauthenticated)", async () => {
  const p = makeProvider();
  const { ctx } = fakeRefreshContext({});
  await p.refreshModels(ctx);
  const models = p.getModels();
  assert.equal(models.length, 2);
  assert.ok(models.every((m) => m.provider === "layerx1"));
  assert.ok(models.every((m) => m.api === "openai-completions"));
});

test("both wires publish the full catalog with their own meta", async () => {
  const openai = makeProvider({ id: "layerx1", api: "openai-completions", baseUrl: "https://api.layerx1.com/v1" });
  const anthropic = makeProvider({ id: "layerx1-anthropic", api: "anthropic-messages", baseUrl: "https://api.layerx1.com" });
  await openai.refreshModels(fakeRefreshContext({}).ctx);
  await anthropic.refreshModels(fakeRefreshContext({}).ctx);
  assert.deepEqual(openai.getModels().map((m) => m.id).sort(), ["lx1-fable-5", "lx1-gpt-oss-120b"]);
  assert.deepEqual(anthropic.getModels().map((m) => m.id).sort(), ["lx1-fable-5", "lx1-gpt-oss-120b"]);
  assert.ok(openai.getModels().every((m) => m.api === "openai-completions"));
  assert.ok(anthropic.getModels().every((m) => m.api === "anthropic-messages"));
});

test("refreshModels restores the persisted snapshot when offline", async () => {
  let fetched = false;
  const p = makeProvider({
    fetchCatalog: async () => { fetched = true; return parsedRepresentative(); },
  });
  const stored = {
    models: [{ id: "lx1-gpt-oss-120b", name: "cached", provider: "layerx1" }],
  };
  const { ctx } = fakeRefreshContext({ allowNetwork: false, stored });
  await p.refreshModels(ctx);
  assert.equal(fetched, false);
  assert.equal(p.getModels().length, 1);
  assert.equal(p.getModels()[0].id, "lx1-gpt-oss-120b");
});

test("refreshModels drops persisted entries from other providers", async () => {
  const p = makeProvider();
  const stored = { models: [{ id: "other-model", provider: "someone-else" }] };
  const { ctx } = fakeRefreshContext({ allowNetwork: false, stored });
  await p.refreshModels(ctx);
  assert.equal(p.getModels().length, 0);
});

test("refreshModels keeps the restored snapshot when the live fetch fails", async () => {
  const p = makeProvider({
    fetchCatalog: async () => { throw new Error("boom"); },
  });
  const stored = { models: [{ id: "lx1-gpt-oss-120b", provider: "layerx1" }] };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    await p.refreshModels(fakeRefreshContext({ stored }).ctx);
  } finally {
    console.error = orig;
  }
  assert.equal(p.getModels().length, 1);
  assert.ok(errors.some((e) => e.includes("catalog fetch failed")));
  assert.ok(errors.every((e) => !e.includes(SECRET)));
});
