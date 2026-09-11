# pi-layerx1-provider

A Pi extension that registers [Layer X1](https://layerx1.com) as a dynamic model provider.

I built it because I subscribe to Layer X1 and got tired of maintaining a `models.json` by hand — every time they added or removed a model, I'd have to update mine and restart Pi. This extension pulls Layer X1's live catalog, so new models just show up.

It exposes two providers backed by the same key, both participating in Pi's built-in `/login` flow:

| Provider ID | Display Name | Wire Protocol |
| :--- | :--- | :--- |
| `layerx1` | Layer X1 | OpenAI Chat Completions |
| `layerx1-anthropic` | Layer X1 (Anthropic) | Anthropic Messages |

Layer X1 serves every model on every endpoint, so both providers publish the full catalog — only the wire protocol differs. Pricing and capability metadata come straight from the catalog endpoint, which is unauthenticated: the `/model` picker works even before you log in.

---

## Quickstart (Baby Steps)

Setting this up takes three simple steps:

### Step 1: Install the extension

Run this single command in your terminal:

```bash
pi install git:github.com/jstokke/pi-layerx1-provider
```

To pin a specific release, add the tag:

```bash
pi install git:github.com/jstokke/pi-layerx1-provider@v0.1.0
```

*(The HTTPS form works too: `pi install https://github.com/jstokke/pi-layerx1-provider`)*

That's it! Pi downloads the extension, registers it in `~/.pi/agent/settings.json`, and loads it automatically whenever you run `pi`.

### Step 2: Log in with your API key

Start Pi (or run this inside an existing Pi session):

```text
/login layerx1
```

When prompted, paste your Layer X1 API key (grab one from the Layer X1 dashboard under `/dashboard/keys` — keys start with `lx1_`).

- Pi prompts with a masked secret input and securely saves it to `~/.pi/agent/auth.json`.
- **You only need to do this once.** Both `layerx1` and `layerx1-anthropic` share the same credential, so logging into either one authenticates both.

### Step 3: Pick a model and start coding

In Pi, open the model picker:

```text
/model
```

You'll see the live Layer X1 catalog (e.g. `layerx1/lx1-gpt-oss-120b`, `layerx1/lx1-glm-5`, or the `layerx1-anthropic/...` equivalents).

Pick any model, press Enter, and start coding!

---

## Managing the Extension

### Updating

Whenever updates or fixes are released, update your installed Pi extensions with:

```bash
pi update --extensions
```

*(Or `pi update --all` to update both Pi and all packages.)*

### Uninstalling

If you ever want to remove the extension:

```bash
pi remove git:github.com/jstokke/pi-layerx1-provider
```

---

## Alternative Setup Methods

### Headless / CI (Environment Variable)

For headless servers, scripts, or CI environments where an interactive `/login` prompt isn't possible, set the environment variable:

```bash
export LAYERX1_API_KEY="lx1_your_key"
```

The extension checks `LAYERX1_API_KEY` first before falling back to `auth.json`.

### Local Development / Contributing

If you want to clone this repository and hack on the code directly:

```bash
# 1. Clone the repository
git clone https://github.com/jstokke/pi-layerx1-provider.git
cd pi-layerx1-provider

# 2. Install the local directory into Pi
pi install .
```

*Tip for live development:* If you want Pi to reflect edits immediately without reinstalling, symlink `src/` into your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/src" ~/.pi/agent/extensions/layerx1
```

---

## How It Works

### Endpoints

| Purpose | URL |
| :--- | :--- |
| Catalog (unauthenticated) | `GET https://api.layerx1.com/v1/models` |
| OpenAI Chat Completions | `POST https://api.layerx1.com/v1/chat/completions` |
| Anthropic Messages | `POST https://api.layerx1.com/v1/messages` |

The OpenAI provider registers `https://api.layerx1.com/v1` as its base URL (the SDK appends `/chat/completions`); the Anthropic provider registers `https://api.layerx1.com` (the SDK appends `/v1/messages`).

### Catalog & Metadata

`GET /v1/models` is unauthenticated and cacheable (`max-age=300`), and every entry is self-describing:

```json
{
  "id": "lx1-gpt-oss-120b",
  "context_window": 131072,
  "max_output": 32768,
  "capabilities": { "tools": true, "reasoning": false, "vision": false, "documents": false },
  "pricing_usd_per_mtok": { "input": 0.05, "output": 0.35, "cached_input": null }
}
```

The extension maps these directly onto Pi models: `context_window` → `contextWindow`, `max_output` → `maxTokens`, `capabilities.reasoning` → `reasoning`, `capabilities.vision` → image input, and `pricing_usd_per_mtok` → `cost` (`cached_input` becomes `cacheRead`; there is no separate cache-write price, so `cacheWrite` is 0). No docs scraping, no TTL cache file — the live endpoint is the single source of truth.

The catalog is fetched lazily inside Pi's `refreshModels()` callback (on first model use or `/model` refresh, bounded to 8s). If the gateway is unreachable, Pi keeps the previously persisted snapshot and retries on the next refresh.

### Avoiding "Response was truncated" (`maxTokens`)

When an LLM response cuts off with `finish_reason="length"`, Pi raises `Response was truncated before completion.` This often happens on reasoning models because hidden reasoning tokens consume part of the output budget.

Per model, `maxTokens` is resolved in order (raise-only):

1. **`max_output` from the catalog**: The floor set by Layer X1.
2. **Per-model override**: From `~/.pi/agent/layerx1-model-overrides.json` (can raise, never lower).
3. **`LAYERX1_DEFAULT_MAX_TOKENS`**: Global env var override.
4. **Compile-time defaults**: `131072` (128k) for reasoning models, `65536` (64k) otherwise.

To raise the global default:

```bash
export LAYERX1_DEFAULT_MAX_TOKENS=65536
```

### Per-Model Overrides

Create `~/.pi/agent/layerx1-model-overrides.json` (or under `$PI_CODING_AGENT_DIR`):

```json
{
  "lx1-gpt-oss-120b": { "maxTokens": 65536 },
  "lx1-fable-5":      { "maxTokens": 65536 }
}
```

- Keys can be the model ID or display name (case- and whitespace-insensitive).
- Supports `maxTokens` and `contextWindow` (must be positive integers).

---

## Troubleshooting

The extension prints concise, actionable diagnostics without ever logging your API key:

- **`Layer X1: no API key found. Run \`/login layerx1\` in Pi...`**
  First-time setup or cleared credentials. Run `/login layerx1` or set `LAYERX1_API_KEY`. Note the catalog still loads — only sending requests needs the key.
- **`Layer X1: <id> catalog fetch failed: ...`**
  Network or parsing error reaching `/v1/models`. Pi continues using the previously cached catalog, and will retry on the next refresh.

---

## Tests & Validation

Run the test suite:

```bash
npm test
```

Unit tests with fully mocked HTTP, zero live API dependencies.

Run type-checking:

```bash
npm run typecheck
```

---

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Layer X1. "Layer X1", and the model names referenced by its catalog, are trademarks of their respective owners, used here only to describe what this extension interoperates with.

---

## License

[MIT](LICENSE) © Joachim Stokke
