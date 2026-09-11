# Changelog

Notes on what changed. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Free-plan support: requests rejected with `403 plan_upgrade_required`
  before producing content are retried once under the learned output cap
  (parsed from the gateway's "up to N output tokens" message, else 4096),
  remembered per session. Paid keys never hit that path. New escape hatches
  `LAYERX1_PLAN=free` (clamp to the Free cap from the first request) and
  `LAYERX1_MAX_TOKENS=N` (explicit per-request output ceiling). The learned
  cap is intentionally not persisted, so plan upgrades take effect
  immediately.

## [0.1.0] - 2026-09-11

### Added

- Initial release: Pi extension registering Layer X1 as two native providers
  (`layerx1` on OpenAI Chat Completions, `layerx1-anthropic` on Anthropic
  Messages) sharing one `lx1_` credential via Pi's `/login` flow.
- Live catalog from unauthenticated `GET /v1/models` with pricing
  (`pricing_usd_per_mtok`), capabilities (`reasoning`/`vision`), and limits
  (`context_window`/`max_output`) mapped directly onto Pi models — no docs
  scraping, so the `/model` picker works before login.
- Per-model `maxTokens`/`contextWindow` overrides via
  `~/.pi/agent/layerx1-model-overrides.json` plus `LAYERX1_DEFAULT_MAX_TOKENS`,
  with a higher default ceiling for reasoning models.
