## What this changes

<!-- One or two sentences. -->

## Why

<!-- The motivation: an issue, upstream behaviour, a Layer X1 catalog change. -->

## Public surface

Does this change anything users depend on? Tick what applies, or "none".

- [ ] Provider ids (`layerx1`, `layerx1-anthropic`)
- [ ] Environment variables
- [ ] The override file shape (`~/.pi/agent/layerx1-model-overrides.json`)
- [ ] Model ids, pricing, or capability flags
- [ ] None

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `CHANGELOG.md` updated under `[Unreleased]` if user-visible
- [ ] No secrets in code, tests, logs, error messages, or this description

Untested plans are worth a note: Free caps output at 4,096 tokens per
request, so free-plan behavior (the `plan_upgrade_required` retry path)
can't be verified from a paid key alone. If your change touches request
limits or error handling, say what you tested against.
