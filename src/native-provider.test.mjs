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

// ---------------------------------------------------------------------------
// Free-plan output-cap relay (stream / streamSimple)
// ---------------------------------------------------------------------------

const PLAN_ERROR =
  'Error: 403: {"type":"plan_upgrade_required","message":"Free supports up to 4,096 output tokens per request"}';

function planErrorEvent() {
  return { type: "error", reason: "error", error: { errorMessage: PLAN_ERROR } };
}

function doneEvent() {
  return { type: "done", reason: "stop", message: { role: "assistant", stopReason: "stop" } };
}

/** Fake inner wire stream: yields `events`, then result() resolves to `final`. */
function fakeStream(events, final) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          if (i < events.length) return Promise.resolve({ value: events[i++], done: false });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    result: async () => final,
  };
}

/** Drain a relayed stream: all events plus the final result. */
async function collect(stream) {
  const events = [];
  for await (const e of stream) events.push(e);
  return { events, final: await stream.result() };
}

/** Run fn with LAYERX1_* env vars pinned, restoring afterwards. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Silence console.error during fn, returning the captured lines. */
async function muteConsole(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const out = await fn();
    return { out, lines };
  } finally {
    console.error = orig;
  }
}

const BIG_MODEL = { id: "lx1-gpt-oss-120b", provider: "layerx1", maxTokens: 32768 };

test("stream passes full limits through when no ceiling applies", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: undefined, LAYERX1_PLAN: undefined }, async () => {
    const calls = [];
    const p = makeProvider({
      streamImpl: (model, context, options) => {
        calls.push({ model, options });
        return fakeStream([{ type: "start" }, { type: "text_start" }, doneEvent()], doneEvent().message);
      },
    });
    const { events, final } = await collect(p.stream(BIG_MODEL, { messages: [] }, {}));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model.maxTokens, 32768);
    assert.ok(events.some((e) => e.type === "done"));
    assert.ok(!events.some((e) => e.type === "error"));
    assert.equal(final.stopReason, "stop");
  });
});

test("stream transparently retries a Free-plan 403 before any content", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: undefined, LAYERX1_PLAN: undefined }, async () => {
    const calls = [];
    const p = makeProvider({
      streamImpl: (model, context, options) => {
        calls.push({ model: { ...model }, options: { ...(options ?? {}) } });
        if (calls.length === 1) {
          return fakeStream([{ type: "start" }, planErrorEvent()], { errorMessage: PLAN_ERROR });
        }
        return fakeStream([{ type: "start" }, { type: "text_start" }, doneEvent()], doneEvent().message);
      },
    });
    const { out, lines } = await muteConsole(() =>
      collect(p.stream(BIG_MODEL, { messages: [] }, { maxTokens: 32768 }))
    );
    assert.equal(calls.length, 2);
    // Retry goes out at the learned free cap — both model and options.
    assert.equal(calls[1].model.maxTokens, 4096);
    assert.equal(calls[1].options.maxTokens, 4096);
    // Caller never sees the 403.
    assert.ok(!out.events.some((e) => e.type === "error"));
    assert.ok(out.events.some((e) => e.type === "done"));
    assert.equal(out.final.stopReason, "stop");
    assert.ok(lines.some((l) => l.includes("plan output cap detected")));
    assert.ok(lines.every((l) => !l.includes(SECRET)));
  });
});

test("learned cap applies to later requests without another 403", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: undefined, LAYERX1_PLAN: undefined }, async () => {
    const calls = [];
    const p = makeProvider({
      streamImpl: (model) => {
        calls.push(model.maxTokens);
        if (calls.length === 1) {
          return fakeStream([planErrorEvent()], { errorMessage: PLAN_ERROR });
        }
        return fakeStream([doneEvent()], doneEvent().message);
      },
    });
    await muteConsole(() => collect(p.stream(BIG_MODEL, {}, {})));
    assert.deepEqual(calls, [32768, 4096]);
    await collect(p.stream(BIG_MODEL, {}, {}));
    assert.deepEqual(calls, [32768, 4096, 4096]);
  });
});

test("stream does not retry once content has flowed", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: undefined, LAYERX1_PLAN: undefined }, async () => {
    let calls = 0;
    const p = makeProvider({
      streamImpl: () => {
        calls++;
        return fakeStream(
          [{ type: "start" }, { type: "text_start" }, planErrorEvent()],
          { errorMessage: PLAN_ERROR }
        );
      },
    });
    const { events } = await muteConsole(() => collect(p.stream(BIG_MODEL, {}, {}))).then((r) => r.out);
    assert.equal(calls, 1);
    assert.ok(events.some((e) => e.type === "error"));
  });
});

test("stream does not retry non-plan errors", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: undefined, LAYERX1_PLAN: undefined }, async () => {
    let calls = 0;
    const p = makeProvider({
      streamImpl: () => {
        calls++;
        const err = { type: "error", reason: "error", error: { errorMessage: "Error: 429: rate limited" } };
        return fakeStream([err], { errorMessage: "Error: 429: rate limited" });
      },
    });
    const { events } = await collect(p.stream(BIG_MODEL, {}, {}));
    assert.equal(calls, 1);
    assert.ok(events.some((e) => e.type === "error"));
  });
});

test("LAYERX1_PLAN=free clamps the first attempt", async () => {
  await withEnv({ LAYERX1_PLAN: "free", LAYERX1_MAX_TOKENS: undefined }, async () => {
    const calls = [];
    const p = makeProvider({
      streamImpl: (model) => {
        calls.push(model.maxTokens);
        return fakeStream([doneEvent()], doneEvent().message);
      },
    });
    await collect(p.stream(BIG_MODEL, {}, {}));
    assert.deepEqual(calls, [4096]);
  });
});

test("LAYERX1_MAX_TOKENS clamps every request", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: "2048", LAYERX1_PLAN: undefined }, async () => {
    const calls = [];
    const p = makeProvider({
      streamImpl: (model, context, options) => {
        calls.push({ model: model.maxTokens, options: options?.maxTokens });
        return fakeStream([doneEvent()], doneEvent().message);
      },
    });
    await collect(p.stream(BIG_MODEL, {}, { maxTokens: 32768 }));
    assert.deepEqual(calls, [{ model: 2048, options: 2048 }]);
  });
});

test("stream skips retry when the request was aborted", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: undefined, LAYERX1_PLAN: undefined }, async () => {
    let calls = 0;
    const p = makeProvider({
      streamImpl: () => {
        calls++;
        return fakeStream([planErrorEvent()], { errorMessage: PLAN_ERROR });
      },
    });
    const controller = new AbortController();
    controller.abort();
    const { events } = await muteConsole(() =>
      collect(p.stream(BIG_MODEL, {}, { signal: controller.signal }))
    ).then((r) => r.out);
    assert.equal(calls, 1);
    assert.ok(events.some((e) => e.type === "error"));
  });
});

test("streamSimple gets the same Free-plan relay", async () => {
  await withEnv({ LAYERX1_MAX_TOKENS: undefined, LAYERX1_PLAN: undefined }, async () => {
    const calls = [];
    const p = makeProvider({
      streamSimpleImpl: (model) => {
        calls.push(model.maxTokens);
        if (calls.length === 1) {
          return fakeStream([planErrorEvent()], { errorMessage: PLAN_ERROR });
        }
        return fakeStream([doneEvent()], doneEvent().message);
      },
    });
    const { out } = await muteConsole(() => collect(p.streamSimple(BIG_MODEL, {}, {})));
    assert.deepEqual(calls, [32768, 4096]);
    assert.ok(out.events.some((e) => e.type === "done"));
  });
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
