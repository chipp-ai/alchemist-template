# Design system — motion language (S1 slice)

Status: shipped (ALCHEM7-3 / S1). Design of record: `docs/design-system-program.md`.

## Problem

S1 requires a motion language on top of the token system — staggered
reveal-on-scroll, button micro-states, skeleton loaders, toast enter/exit,
and View Transitions for route changes — with a hard constraint: **every**
effect must be gated behind `prefers-reduced-motion`, and reveal-on-scroll
in particular must fail SAFE to fully visible content (this is a marketing
surface as much as an app; a page that stays blank because JS didn't run
is a worse failure than "no animation").

## Decision

- **File split:** `web/src/motion.css` (imported from `main.ts` right after
  `app.css`) holds every motion rule. Two small TS helpers —
  `web/src/lib/reveal.ts` and `web/src/lib/view-transitions.ts` — hold the
  DOM wiring, each with a **pure decision function** (`shouldArmReveal`,
  `shouldUseViewTransition`) extracted so the fail-safe gating logic is a
  real unit test, not a lint on file contents. Same split as
  `color-math.ts`/`theme.ts` from the tokens and dark-mode slices.
- **Reveal-on-scroll:** `.reveal` elements are visible by default
  (`opacity: 1; transform: none`) in `motion.css`. They are ONLY hidden and
  then faded/slid in once `<html class="reveal-ready">` is present, and
  that class is added exclusively by `initRevealOnScroll()` — which itself
  refuses to run when `IntersectionObserver` is unsupported OR
  `prefers-reduced-motion: reduce` is set. Net effect: JS failing to load,
  an old browser, a test/SSR render, or reduced motion all leave `.reveal`
  content fully visible; only the "everything supported" path gets the
  cascade. Staggering is per-element via a `--reveal-index` custom property
  (0-5, bucketed with modulo so a long list doesn't produce a multi-second
  cascade), set by the JS helper and consumed by a `transition-delay:
  calc(var(--reveal-index, 0) * 80ms)` in CSS.
  `App.svelte` calls `initRevealOnScroll()` once on mount and again on every
  route change (idempotent — it skips anything already marked
  `data-reveal-observed`), so newly-mounted `.reveal` elements on a route
  that loads after the initial screen still animate in.
- **Button hover/press:** the base treatment (hover background/border swap,
  `translateY(1px)` on press) already lives in `app.css`'s `.btn` (component
  kit slice). `motion.css` adds `.motion-press`, a reusable transform-only
  press affordance for non-`.btn` interactive elements (icon buttons, a card
  acting as a button), plus the reduced-motion override for both.
- **Skeleton loaders:** `.skeleton` / `.skeleton-text` / `.skeleton-circle`
  / `.skeleton-card` utility classes with a shimmer sweep
  (`@keyframes skeleton-shimmer`, `linear-gradient` sweeping across via
  `transform: translateX`, so it's compositor-only — no repaint of the
  underlying gradient stops). Per CLAUDE.md's paint-jank rule, this is
  exactly the case an infinite CSS animation is allowed: skeletons unmount
  the moment real content is ready, they never sit idle on permanently-
  mounted chrome.
- **Toast springs:** `ToastContainer.svelte` already drives its own
  enter/exit via Svelte's `fly` transition (component-kit slice), gated
  inline on `prefers-reduced-motion`. `motion.css` additionally ships
  `toast-spring-in`/`toast-spring-out` `@keyframes` + utility classes as a
  reusable CSS-only primitive for any future non-Svelte-transition surface
  that wants the same overshoot-in / quick-fade-out feel.
- **View Transitions:** `runWithViewTransition(update)` calls
  `document.startViewTransition(update)` when the API exists AND motion is
  allowed, else just calls `update()` — the navigation always happens,
  only the cross-fade is conditional. `navigateWithTransition(navigate,
  path)` is the router-agnostic convenience wrapper (`navigate` is passed
  in, e.g. svelte-spa-router's `replace`, so this module never imports
  svelte-spa-router directly). `App.svelte`'s login redirect uses it.
  `motion.css` styles `::view-transition-old(root)`/`::view-transition-
  new(root)` with the shared `--motion-base`/`--ease-out` tokens.
- **Motion tokens:** `--motion-fast` (120ms) / `--motion-base` (200ms) /
  `--motion-slow` (400ms) durations, `--ease-out` / `--ease-spring` easing
  curves — every rule in `motion.css` references these instead of a literal
  duration, so retuning the language later is a token edit.
- **The single `prefers-reduced-motion` block:** one `@media` block at the
  bottom of `motion.css` disables every animation/transition declared above
  it by name, AND ends with a blanket `*, *::before, *::after { animation-
  duration: 0.01ms !important; ...; scroll-behavior: auto !important; }`
  kill-switch — the standard defense-in-depth pattern (Andy Bell's "sensible
  defaults") so a future rule added to this file without its own explicit
  override still gets neutralized under reduced motion.

## Rejected alternatives

- **Wrapping every `<a use:link>` navigation (Sidebar) in a View
  Transition.** svelte-spa-router's `link` action does its own
  `preventDefault` + hash mutation inside its own click handler; safely
  intercepting that would mean re-implementing the action's navigation
  logic in a capture-phase listener, which risks breaking real navigation
  for a purely cosmetic win. `navigateWithTransition` instead wraps the
  app's actual *programmatic* navigation call sites (redirects, post-auth
  landing) — the places this repo's own code controls end-to-end.
- **Real spring physics (Web Animations API `spring()`-style easing) for
  toasts.** Overkill for a small enter/exit — a standard overshoot
  cubic-bezier (`--ease-spring`) reads as "springy" without a JS animation
  loop, and CSS-driven means it composes with the reduced-motion media
  query for free.
- **Reveal defaulting to hidden with a `<noscript>` fallback.** Rejected —
  a `<noscript>` block can't undo an already-applied `opacity: 0` once JS
  *does* run but throws before wiring the observer (e.g. an unrelated
  script error earlier in the page). Defaulting `.reveal` to visible and
  only hiding once the observer is confirmed armed is fail-safe against
  every partial-failure mode, not just "JS disabled".

## Public contract

- `.reveal` (CSS class, `web/src/motion.css`): apply to any element that
  should fade/slide in on scroll. Visible by default; the JS opt-in
  (`initRevealOnScroll()`) is what makes it animate.
- `initRevealOnScroll(root?: ParentNode): { destroy(): void }`
  (`web/src/lib/reveal.ts`): arms the reveal observer for `.reveal`
  elements under `root` (default: the whole document). Safe to call
  repeatedly (idempotent via `data-reveal-observed`).
- `shouldArmReveal({ hasIntersectionObserver, prefersReducedMotion }):
  boolean` — pure gate, unit-tested directly.
- `.motion-press` (CSS class): transform-only press affordance for
  non-`.btn` interactive elements.
- `.skeleton`, `.skeleton-text`, `.skeleton-circle`, `.skeleton-card` (CSS
  classes): loading-state placeholders with a shimmer sweep.
- `.toast-spring-in` / `.toast-spring-out` (CSS classes): reusable
  CSS-only toast enter/exit animation primitive.
- `runWithViewTransition(update: () => void): void` and
  `navigateWithTransition(navigate: (path: string) => void, path: string):
  void` (`web/src/lib/view-transitions.ts`).
- `shouldUseViewTransition({ supportsViewTransitions,
  prefersReducedMotion }): boolean` — pure gate, unit-tested directly.
- `--motion-fast` / `--motion-base` / `--motion-slow` / `--ease-out` /
  `--ease-spring` (CSS custom properties, `:root` in `motion.css`).

## Gotchas

- `motion.css` must be imported AFTER `app.css` in `main.ts` — it relies on
  tokens (`--color-surface`, `--color-border-strong`, `--radius-*`,
  `--space-*`) defined there.
- Any new component that wants reveal-on-scroll must both add the
  `.reveal` class in markup AND ensure `initRevealOnScroll()` runs after
  it mounts (already covered app-wide via `App.svelte`'s mount + per-route
  effect; a component rendered inside an existing route doesn't need to
  call it again).
- The blanket `prefers-reduced-motion` kill-switch at the end of
  `motion.css` only covers rules that use `animation`/`transition`
  shorthand or the longhand `-duration` properties — it does not (and
  cannot) retroactively disable a hand-rolled `requestAnimationFrame` loop.
  There are none in this slice; keep it that way, or gate any future rAF
  loop on `matchMedia("(prefers-reduced-motion: reduce)")` explicitly.
