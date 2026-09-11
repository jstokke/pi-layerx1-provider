# Contributing

Thanks for considering a PR. This is a small extension — most changes
touch one of three files (`src/index.ts`, `src/core.mjs`,
`src/native-provider.mjs`) plus tests.

I'm a solo dev, so response times are whatever they are. If something's
sitting unanswered for a week, ping me.

## Running the tests

```bash
npm install
npm test
```

Unit tests, fully mocked HTTP, no live API. `node --test` runs them in about
300ms. The `--test-force-exit` flag is a safety net on Node ≥ 24 in case a
test leaves an unawaited microtask; `npm run test:ci` skips it.

## Type-checking

```bash
npm run typecheck
```

`tsc --noEmit`, strict mode, over `src/index.ts` and the `.d.mts` / `.d.ts`
declaration files. Please don't turn strict mode off.

What it does **not** cover is worth understanding, because the JavaScript is not
what gets checked:

- **The declaration files are not verified.** `skipLibCheck` is on, so TypeScript
  uses `core.d.mts` as the types for `core.mjs` without checking the contents of
  the declaration against the implementation. Turning it off is not an option:
  it reports errors inside `@earendil-works/pi-ai`'s generated
  declarations, because `module: nodenext` rejects their JSON import attributes.
- **The `.mjs` modules are not type-checked.** `allowJs`/`checkJs` are off, and
  the modules carry no JSDoc, so enabling `checkJs` reports many errors. Doing this
  properly is a real piece of work (annotate the `.mjs`, then drop the
  hand-written declarations), not a config change.

So `npm run typecheck` checks that `src/index.ts` uses the declared interfaces
correctly. It does not check that the declarations match the implementations.
`src/declarations.test.mjs` closes the gap that matters most — every declared
value export must exist at runtime, and every runtime export must be declared —
but it cannot check argument or return types.

If you change what a `.mjs` module exports, or change a signature, update the
matching `.d.mts` by hand. Nothing will remind you except that test.

## Project layout

```
src/
  index.ts                    # Pi extension entrypoint (loaded by jiti at startup)
  core.mjs                    # Pure logic: catalog fetch/parse, overrides
  core.d.mts                  # Type declarations for core.mjs
  core.test.mjs               # Unit tests for core
  native-provider.mjs         # Runtime Provider object: /login, refreshModels, wire dispatch
  native-provider.d.mts       # Type declarations for native-provider.mjs
  native-provider.test.mjs    # Unit tests for the provider
  pi-extension-augment.d.ts   # Augments ExtensionAPI.registerProvider with the runtime-provider overload
  declarations.test.mjs       # Asserts the .d.mts exports match the .mjs runtime exports
  README.md                   # User-facing technical documentation
```

`core.mjs` is deliberately plain ES module JavaScript so it loads via Pi's
jiti runtime AND tests with `node --test` without a compile step.

## Things I care about

- **No new runtime dependencies.** The extension is intentionally tiny.
  Built-in Node APIs are enough; please don't add a runtime dep without a
  really good reason.
- **All HTTP must be mockable for tests.** `fetchCatalog` takes its
  `fetchImpl` (and `signal`) as arguments; never call the global `fetch`
  directly in a way tests cannot stub.
- **Never log the API key.** Error paths are covered by secret-hygiene
  assertions; a regression there is a security bug, not a cosmetic one.
- **Layer X1 docs are the contract.** Base URLs, capability flags, and
  pricing shapes come from https://docs.layerx1.com. Link the doc you relied
  on when changing request/response handling.
