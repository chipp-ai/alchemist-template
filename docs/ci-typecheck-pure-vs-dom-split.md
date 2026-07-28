# CI fix: `deno test` type-checks test-imported browser modules (no `dom` lib)

**Status:** shipped (ALCHEM7-4)

## Problem

CI's "Run tests" step runs `deno test --parallel --allow-all src/__tests__/`
**without** `--no-check` (unlike the local `deno task test`, which passes
`--no-check` for fast iteration). That means every module reachable from a
test file's import graph gets fully type-checked under this repo's root
`deno.json` `compilerOptions.lib: ["deno.window", "deno.unstable"]` — which
does **not** include `"dom"`.

`src/__tests__/design-motion.test.ts` imports `shouldArmReveal` from
`web/src/lib/reveal.ts` and `shouldUseViewTransition` from
`web/src/lib/view-transitions.ts` to unit-test those pure gating functions
directly under Deno. Both files ALSO contained DOM-wiring code
(`initRevealOnScroll`, `runWithViewTransition`) in the same module, using
`document`, `IntersectionObserver`, `matchMedia`, `HTMLElement`,
`requestAnimationFrame` — none of which resolve without the `dom` lib.
`deno test` type-checks the **whole file**, not just the symbols a test
imports, so CI failed with 19 `TS2304`/`TS2552`/`TS18046` errors while every
local `--no-check` run stayed green. This is exactly the class of bug that
only reproduces when CI's exact command is run locally.

## Decision

Split each file along the pure/DOM boundary this repo already uses for
`color-math.ts` (pure) vs. `brand-loader.js` (DOM) and `theme.ts` (pure) vs.
`stores/theme.svelte.ts` (DOM):

- `web/src/lib/reveal.ts` — pure `shouldArmReveal()` gate + `RevealHandle`
  type only. Zero DOM globals.
- `web/src/lib/reveal-dom.ts` (new) — `initRevealOnScroll()`, the actual
  `IntersectionObserver` wiring. Imported only from `App.svelte`.
- `web/src/lib/view-transitions.ts` — pure `shouldUseViewTransition()` gate
  only.
- `web/src/lib/view-transitions-dom.ts` (new) — `runWithViewTransition()` /
  `navigateWithTransition()`, the `document.startViewTransition` wiring.
  Imported only from `App.svelte`.

**Rejected alternative:** add `"dom"` to the root `deno.json`
`compilerOptions.lib`. Rejected because Deno's own lib types
(`Response`, `Headers`, `fetch`, etc.) conflict with the DOM lib's versions
of the same globals across the *entire* server-side type-check graph
(`main.ts`, every route, every service) — a much larger blast radius than
two client-only files, and it would mask this exact bug class for any
future browser-only module a test imports.

## Public contract

- `App.svelte` now imports `initRevealOnScroll` from `./lib/reveal-dom`
  (was `./lib/reveal`) and `navigateWithTransition` from
  `./lib/view-transitions-dom` (was `./lib/view-transitions`).
- `web/src/lib/reveal.ts` / `web/src/lib/view-transitions.ts` still export
  the pure gate functions under the same names — no test-visible API
  change to `shouldArmReveal` / `shouldUseViewTransition`.

## Gotcha for future contributors

Any new `web/src/lib/*.ts` module that a `src/__tests__/*.test.ts` file
imports directly (to unit-test pure logic under Deno) **must not** reference
`document`, `window`, or any other DOM-only global anywhere in that file —
even in a function the test never calls. Put DOM-touching code in a sibling
`*-dom.ts` file instead. Verify locally with the CI-exact command before
pushing:

```bash
DATABASE_URL=... JWT_SECRET=test-secret NODE_ENV=test TEST_PARALLEL_ISOLATION=1 \
  deno test --parallel --allow-all src/__tests__/
```

(note: **no** `--no-check` — that's the flag `deno task test` adds that let
this regression slip past local iteration).
