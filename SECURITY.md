# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/jstokke/pi-layerx1-provider/security/advisories/new)
instead, or email the maintainer if that is unavailable to you.

Include what makes the report actionable: affected version, Pi version, steps
to reproduce, and the impact you believe it has. I'll acknowledge as soon as I
see it. This is a side project maintained by one person, so please be patient
rather than assuming it has been ignored.

## Scope

This extension is a Pi package, which means it runs with the same trust as any
other Pi package: extensions execute arbitrary code, so review the source
before installing — including this one.

The design decisions that matter here:

- **The extension never stores your API key.** `/login layerx1` hands the
  key to Pi, which persists it in `~/.pi/agent/auth.json`. The extension reads
  it back on demand through Pi's credential API, or from
  `LAYERX1_API_KEY` in the environment.
- **The key is never logged.** Error and message paths are covered by the
  secret-hygiene tests in `src/native-provider.test.mjs`; a regression there is a security
  bug, not a cosmetic one.
- **Outbound requests are limited to Layer X1.** The extension calls
  `api.layerx1.com` for the model catalog and for chat requests via Pi's
  model runtime. The catalog endpoint is unauthenticated — no key is ever
  sent to fetch the model list.
- **No install scripts and no runtime dependencies.** The package has no
  `preinstall`/`postinstall` hooks and ships no third-party code.

## Supported versions

The latest published version is the supported one. Fixes go into a new release
rather than a backport.
