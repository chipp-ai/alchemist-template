# Design system — dark mode (S1 slice)

Status: shipped (ALCHEM7-3 / S1). Design of record: `docs/design-system-program.md`.

## Problem

S1 requires dark mode as an explicit, user-chosen **theme** layered on top of
the token system (`web/src/app.css`) — never inferred from the OS, and never
allowed to let a customer's light-surface brand neutral leak into a dark
canvas.

## Decision

- **Activation:** `<html data-theme="dark">`. `web/src/app.css` carries a
  `:root[data-theme="dark"]` block that overrides only the tokens that can't
  auto-recompute (surfaces, text, borders, the accent hover/active + status
  tint ramps that hard-coded "white"/"black" as a `color-mix()` endpoint, and
  a bespoke elevation ramp). Everything else derived from `--color-bg` /
  `--color-surface` via `color-mix()` in the light `:root` block recomputes
  automatically once those two vars are overridden — CSS custom properties
  resolve against the active cascade at used-value time, not definition time.
- **Source of truth:** `web/src/lib/theme.ts` — a pure, rune-free module
  (`resolveInitialTheme`, `nextTheme`) unit-tested directly under Deno, mirroring
  the `color-math.ts` split (pure math vs. reactive/DOM wiring). This is what
  makes "default light" and "toggle" real, tested logic rather than a lint
  that only checks for the word "light" somewhere in a file.
- **Reactive wiring:** `web/src/stores/theme.svelte.ts` — `defineStore`-based
  (DevPanel/`/api/dev/app-state` visible), reads `localStorage` once at boot
  through `resolveInitialTheme`, and on every `setTheme`/`toggle` mirrors the
  value onto both the `data-theme` DOM attribute and `localStorage`.
- **Anti-FOUC:** `web/index.html` carries a small inline `<script>` (before
  `main.ts`'s module script) that reads the same `"alchemist-theme"` key and
  sets `data-theme="dark"` synchronously, before first paint. It duplicates
  the literal key string rather than importing `theme.ts` — it runs unbundled
  in `<head>`, the same constraint `brand-loader.js` already documents for
  its own duplicated contrast-math copy.
- **Toggle UI:** `web/src/components/ThemeToggle.svelte` — a real `<button>`
  with `aria-pressed`/`aria-label`, mounted in `Sidebar.svelte`'s footer next
  to the user/logout block (visible on every authenticated screen). Sun/moon
  icon via inline SVG `currentColor` — no image assets.

## Rejected alternatives

- **`prefers-color-scheme` media query as the default source.** Explicitly
  out of scope per the design program ("DEFAULT LIGHT, never OS-auto partial
  theming") — a media-query default would silently theme half of users dark
  on first load with no toggle interaction, which is the exact "partial
  theming" the program forbids. `brand-loader.js` already reads
  `prefers-color-scheme` for a **different, narrower** purpose (picking which
  logo image — light or dark mark — to render); that stays as-is and is not
  the app theme.
- **Deriving dark `--color-bg` from `--brand-neutral`.** Rejected outright —
  `--brand-neutral` is contractually a *light*-surface color
  (`brand-loader.js` clamps it via `isLightSurface()` before ever setting
  it), so the dark override hardcodes its own fixed dark value and never
  references `--brand-neutral` at all. Unit-tested in
  `src/__tests__/design-dark-mode.test.ts`.
- **A single shared color-mix ramp reused for both themes' hover/active
  states.** The light ramp darkens on hover (mixes toward black), which
  reads as "premium" on a light surface but "washed out"/low-contrast on a
  dark one. The dark override instead lightens on hover (mixes toward
  white) for the accent ramp, and mixes status backgrounds toward black
  instead of white so tinted alerts still read as dark surfaces.

## Public contract

- `localStorage["alchemist-theme"]`: `"dark"` or absent/anything else (→
  light). Written by `theme.svelte.ts`, read by both it and the
  `web/index.html` inline script.
- `<html data-theme="dark">`: the only DOM hook app.css keys off. Absence
  means light (the `:root` defaults).
- `themeStore` (`web/src/stores/theme.svelte.ts`): `{ theme, isDark,
  setTheme(theme), toggle() }`.
- `resolveInitialTheme(stored)` / `nextTheme(current)`
  (`web/src/lib/theme.ts`): pure functions, safe to unit test or reuse
  anywhere theme resolution is needed without touching the DOM.

## Gotchas

- Keep the `"alchemist-theme"` string literal in sync across
  `web/index.html`'s inline script and `THEME_STORAGE_KEY` in
  `web/src/lib/theme.ts` — the inline script can't import the TS module.
- Any new token added to the light `:root` block that hardcodes a `white`/
  `black` `color-mix()` endpoint (instead of referencing `--color-bg`/
  `--color-surface`) needs a matching entry in the
  `:root[data-theme="dark"]` block, or it will silently keep its light-mode
  direction in dark mode. Tokens that mix toward `--color-bg`/
  `--color-surface` do NOT need a dark override — they recompute for free.
