---
name: Bug report
about: Something is broken or behaving unexpectedly
---

## What happened

A clear description of the bug.

## Reproduction

Steps to reproduce, ideally with a minimal config:

```bash
export LAYERX1_API_KEY=...
pi
# then describe what you did
```

## Expected behavior

What you expected to happen instead.

## Environment

- Pi version (`pi --version`):
- Node version (`node --version`):
- OS:
- `LAYERX1_API_KEY` set? (yes / no — never paste the key itself)
- `LAYERX1_PLAN` set? (e.g. `free` / unset)
- `LAYERX1_MAX_TOKENS` set?
- `LAYERX1_DEFAULT_MAX_TOKENS` set?
- `~/.pi/agent/layerx1-model-overrides.json` exists? (yes / no / not sure)
- Plan tier (Free / paid — Free caps output at 4,096 tokens per request):

## Logs

Anything relevant from `pi` output — particularly any line starting with
`Layer X1:`. The key itself is never needed for diagnosis; please
redact it anyway.
