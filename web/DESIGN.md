# Design system — token rules, motion conventions, and the component bar

This is the contract that keeps every project generated from this template
at the same visual bar over time — "looks like a funded consumer startup
built it," not "the CSS compiles." It is enforced, not just documented: see
`src/__tests__/design-guardrails.test.ts` for the lint tests that fail CI on
a violation.

Companion reading: `docs/design-system-program.md` (the design of record for
this system) and the per-slice design docs it links (tokens, dark mode,
motion, component kit).

## The token files are the ONLY place a hex color may originate

`web/src/app.css` (`:root` block) and `web/src/motion.css` (its small token
block at the top) are the two files where a raw hex literal (`#5e6ad2`,
`#fff`, etc.) is allowed. Every other component or page style — every
`.svelte` `<style>` block, any other `.css` file — must reference a color
through a `var(--...)` custom property.

```css
/* ❌ BAD — hand-picked hex in a component */
.badge-featured {
  background: #fef3c7;
  color: #92400e;
}

/* ✅ GOOD — derived token */
.badge-featured {
  background: var(--color-warning-bg);
  color: var(--color-warning);
}
```

**Why:** the whole point of `color-mix()`-derived tokens (see below) is that
a project's brand palette propagates through every surface automatically. A
hand-picked hex in a component is a color that will NOT update when the
brand changes, and it usually isn't even AA-contrast-checked.

**Need a new shade that doesn't exist yet?** Add another `color-mix()` step
to the relevant ramp in `app.css` — never hardcode the new hex at the call
site. If you're adding a whole new semantic color (a fourth status beyond
error/success/warning/info, say), follow the exact pattern of the existing
ramps: one "hand-picked" base hex + every shade off it via `color-mix()`.

**Exemptions** (each documented at its lint site in
`design-guardrails.test.ts`):
- `web/src/components/DevPanel.svelte` — the agent/developer debug console.
  It never ships to production (`import.meta.env.PROD` gate + Vite dead-code
  elimination) and is deliberately fixed "devtool chrome," independent of
  the active brand/theme.
- Inline SVG `fill="#..."` attributes in component MARKUP (not `<style>`
  blocks) for fixed third-party trademark colors — e.g. the official
  multi-color Google "G" logo on an OAuth button. Those colors belong to
  Google's brand, not ours; they cannot be derived from our palette.

## Semantic colors are DERIVED, never picked

Every accent/status shade in `app.css` is generated from ONE base value via
`color-mix()`:

| Ramp | Base | Shades derived from it |
|---|---|---|
| Accent | `--brand-primary` | `-hover` (88% → black), `-active` (76% → black), `-subtle` (12% → white), `-soft` (8% → surface), `-contrast` (AA text color, computed by `brand-loader.js`) |
| Error / Success / Warning / Info | one hand-picked hue each | `-hover`, `-bg`, `-border`, `-contrast` |

`--brand-primary`, `--brand-accent`, `--brand-neutral` come from
`brand.json` via `web/public/brand-loader.js`; every fallback (`var(--brand-primary,
#5e6ad2)`) renders the template default when a project hasn't set brand
config yet. Dark mode (`[data-theme="dark"]`) overrides `--color-bg`/
`--color-surface`/etc. directly — everything computed FROM them via
`color-mix()` recomputes automatically, so you only add an explicit
dark-mode override for a ramp that literally hand-picked "white" or "black"
as a `color-mix()` endpoint (the accent hover/active ramp and the status
backgrounds both do — see the comment above the dark block in `app.css`).

**Brand-neutral guard:** `--brand-neutral` is clamped to a LIGHT surface by
`brand-loader.js`'s `isLightSurface()` check before it's ever set, and the
dark theme's `--color-bg` override is a fixed hex that never references
`--brand-neutral`. Never wire `--brand-neutral` into a dark-mode surface —
that reintroduces the "half-dark" bug this template shipped once already.

## Typography — three tokens, no exceptions

```css
--font-heading  /* h1-h6, hero/marketing headings */
--font-sans     /* body copy, UI controls */
--font-mono     /* code, OTP inputs, tabular/monospace data */
```

Never write `font-family: "Inter"` or `font-family: monospace` in a
component. Use the token. `--font-heading`/`--font-sans` resolve
`var(--brand-font-heading, "Inter"), <system stack>` — a project without
brand.json v3 font fields (every project today) renders the "Inter"
fallback; a project with them renders the brand's Google Fonts pick, loaded
by the fonts partial in `web/index.html` + `brand-loader.js` with
`display=swap` so there's no layout-shifting FOUT.

## Radius, spacing, elevation

- **Radius** — always `var(--radius-sm|md|lg|full)`, never a raw px value.
  The concrete numbers are keyed off `<html data-radius-scale="sharp|soft|
  round">` (set by `brand-loader.js` from `brand.json`'s nullable
  `radiusScale` field); "soft" is the `:root` default.
- **Spacing** — always `var(--space-xs|sm|md|lg|xl|2xl|3xl)`. A raw px
  margin/padding/gap in a component is a review flag even though there's no
  automated lint for it yet.
- **Elevation** — exactly 3 levels, `var(--shadow-sm|md|lg)`. Don't invent a
  fourth; don't hand-write a `box-shadow` value in a component.

## Motion — everything behind `prefers-reduced-motion`, everything fails safe

`web/src/motion.css` owns the motion language: `.reveal` (staggered
reveal-on-scroll, IntersectionObserver-backed), `.motion-press` (button
hover/press), skeleton loaders, toast spring keyframes, and the View
Transitions pseudo-elements for SPA route changes.

Rules:
- **Fail-safe to visible.** `.reveal` content is visible by default and is
  ONLY hidden-then-faded-in once JS confirms an `IntersectionObserver` is
  available AND `prefers-reduced-motion` is NOT set (`web/src/lib/reveal.ts`
  `shouldArmReveal()`). No JS, old browser, or reduced-motion preference —
  content is exactly as visible as it would be with zero motion code at all.
- **Content never gets a spinner.** Use a skeleton (`.skeleton`,
  `.skeleton-text`, `.skeleton-circle`, `.skeleton-card`). Reserve `.btn[data-loading]`'s
  spinner for the (short) span of an in-flight button action, not a
  page/section load.
- **`transition: all` is banned everywhere** (not just on cards — this is a
  correctness rule, not just the CLAUDE.md scroll-jank rule). List the
  properties you actually mean to animate.
- **Every animation/transition declared in `motion.css` is disabled inside
  its trailing `@media (prefers-reduced-motion: reduce)` block**, ending
  with a blanket `*` kill-switch. If you add a new motion utility, add its
  disable rule to that same block, in order.
- Interactive elements (buttons, list rows, cards) transition ONLY
  `transform`/`opacity` (see CLAUDE.md's "Hover/interactive transitions
  animate ONLY compositor properties" section for the paint-jank rationale)
  — `color` is tolerated on tiny single controls only.

## Dark mode is a theme, not a preference

`[data-theme="dark"]` on `<html>` is the ONLY thing that switches themes.
Nothing in this template reads `prefers-color-scheme` to decide the active
theme — light is always the default until the user explicitly flips
`<ThemeToggle>` (`web/src/components/ThemeToggle.svelte`, backed by
`web/src/stores/theme.svelte.ts`, persisted to `localStorage`). An inline
anti-FOUC script in `web/index.html` applies a persisted `dark` choice
synchronously before first paint so reload never flashes light→dark.

## Component kit — same class names, upgrade in place

`.btn` / `.btn-primary` / `.btn-secondary` / `.btn-ghost` / `.btn-danger`,
`.input`, `.card`, `.badge`, `.alert-error` / `.alert-success` /
`.alert-warning` / `.alert-info`, `.empty-state`, `.page-header` /
`.page-title` / `.page-subtitle`, `.table` — these are the load-bearing
class names existing template screens already use. When you refresh a
component's look, change what the class LOOKS like in `app.css`; don't
rename it. New template code should reach for these existing classes before
inventing a new one.

**Adding a new component at the bar:**
1. Reach for an existing class first — the kit covers buttons, inputs,
   cards, badges, alerts, tables, empty states, modals (`<Modal>`,
   `web/src/components/Modal.svelte` — never hand-roll a backdrop, see
   CLAUDE.md), and toasts (`toastStore` + `<ToastContainer>`).
2. If you genuinely need a new class, colors/spacing/radius/type/shadow
   come from tokens, motion comes from `motion.css` utilities, and
   `prefers-reduced-motion` is handled for any animation you add.
3. Keyboard-navigable: real `<button>`/`<a>` elements (not `<div onclick>`),
   visible `:focus-visible` ring (the kit's `--color-focus-ring` token
   applies this by default on every interactive element — don't remove it).
4. Add a `data-testid="{area}-{component}-{element}"` per CLAUDE.md.

## Accessibility

- Every semantic color ramp is contrast-checked by the pure math in
  `web/src/lib/color-math.ts` (WCAG relative luminance + contrast ratio),
  unit-tested in `src/__tests__/design-tokens.test.ts`.
- Focus-visible rings are token-driven (`--color-focus-ring`, derived from
  the live accent) and apply by default — don't override `outline: none`
  without supplying an equivalent visible focus style.
- Use semantic markup (`<button>`, `<label for>`, `<table>` with real
  `<thead>`/`<tbody>`) in every kit example; screen-reader users get the
  same navigability sighted users do.

## Enforcement

`src/__tests__/design-guardrails.test.ts` runs on every `deno task test`
and fails the build on:
- a raw hex color literal in a `<style>` block or `.css` file outside
  `app.css`/`motion.css`/`DevPanel.svelte`,
- `transition: all` / `transition-property: all` anywhere,
- a `font-family` declaration that isn't exactly `var(--font-heading)`,
  `var(--font-sans)`, or `var(--font-mono)` (outside the same exemptions),
- this file (`web/DESIGN.md`) or its reference from `CLAUDE.md` going
  missing.

If a lint fires and the change is genuinely a sanctioned exception (a new
third-party brand mark, a new dev-only tool), add it to the exemption sets
at the top of that test file and document why here — don't just delete the
assertion.
