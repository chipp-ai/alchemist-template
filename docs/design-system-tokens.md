# Design-system S1 — tokens, typography, brand-loader v3 (this slice)

**Status:** implemented — this is the tokens/typography/brand-loader slice
of ALCHEM7-3 (S1). Motion language (`motion.css`), dark-mode theming,
component-kit visual polish beyond the token refresh, and the S5 guardrail
lints + `web/DESIGN.md` are separate slices of the same ticket, tracked
elsewhere. See `docs/design-system-program.md` for the full S-series plan.

## Problem

`web/src/app.css` shipped a minimal, flat token kit: two shadow levels, a
non-modular type scale, fixed-px radii, and only one derived color
(`--color-accent-hover`). `web/public/brand-loader.js` only understood the
brand.json v2 shape (`primaryColor`/`accentColor`/`neutralColor`). There was
no way for a project's brand identity to drive typography, corner radius, or
a hero gradient, and choosing readable text-on-accent color required a
hand-picked hex per project instead of a derivation.

## Decision

**Tokens are DERIVED, not hand-picked.** Everything in the accent/error/
success ramps in `web/src/app.css` (`hover`/`active`/`subtle`/`soft`) is a
`color-mix()` expression off the single base hue — never a second literal
hex. The one thing CSS cannot derive is *which* of two fixed text colors
(white vs. ink) reads AA-safe on an arbitrary background, because there's no
shipped `contrast-color()` yet. That one branch runs in JS.

- **Rejected: precomputing all accent shades server-side and shipping them
  as brand.json fields.** Would require the brand generator to also derive
  hover/active/subtle for every future addition to the ramp, doubling the
  v3 contract's surface area for no benefit — `color-mix()` in the browser
  already does this for free and stays in sync automatically when the base
  hue changes (live SSE brand updates).
- **Rejected: CSS `@font-face` `size-adjust` tables per allow-listed
  Google Font** to kill FOUT reflow. That table only exists once S2a ships
  its fixed ~12-font allowlist; S1 has to work with an arbitrary/absent
  font name today. Used `font-size-adjust: from-font` on `<html>` instead —
  a browser-computed, metrics-agnostic approximation (no-op in browsers
  that don't support it yet, never a regression).
- **Rejected: encoding `--brand-radius-scale`'s three states as a numeric
  CSS custom property and computing `calc()` off it.** CSS can't switch
  concrete px values off an arbitrary custom-property *string* without a
  selector to key on. Used a mirrored `data-radius-scale` attribute on
  `<html>` instead — `brand-loader.js` sets both the CSS var (for
  introspection) and the attribute (for `[data-radius-scale="..."]`
  overrides in `app.css`).

## Public contract

### `web/src/app.css` — token additions (all existing class NAMES preserved)

| Token | Shape | Notes |
|---|---|---|
| `--text-xs` … `--text-5xl` | 9-step modular scale, ratio 1.25 off `--text-base` (16px/1rem) | replaces the old ad-hoc scale |
| `--space-xs` … `--space-3xl` | spacing scale | added `--space-3xl` (64px) |
| `--radius-sm/-md/-lg/-full` | keyed off `:root[data-radius-scale]` | `soft` (default) / `sharp` / `round` |
| `--shadow-sm/-md/-lg` | exactly 3 elevation levels | tuned for light surfaces |
| `--color-accent-hover/-active/-subtle/-soft/-contrast` | `color-mix()` off `--brand-primary` | `--color-accent-text` kept as a legacy alias of `-contrast` |
| `--color-error-hover/-bg/-border/-contrast`, `--color-success-*` | `color-mix()` off `--color-error`/`--color-success` | no more raw rgba()/hex in the alert/button rules |
| `--color-focus-ring` | `color-mix()` off `--brand-primary` | used by the global `:focus-visible` rule |
| `--font-heading` / `--font-sans` | `var(--brand-font-heading/-body, "Inter"), <system stack>` | brand var unset ⇒ identical Inter fallback |
| `--brand-gradient-from/-to` | falls back to `--brand-primary`/`--brand-accent` | consumed by the new `.brand-gradient` utility |

### `web/public/brand-loader.js` — v3 brand.json fields (all OPTIONAL)

| Field | CSS effect |
|---|---|
| `fontHeading` / `fontBody` (string) | sets `--brand-font-heading`/`--brand-font-body` (quoted); also triggers `ensureGoogleFontsLink()` — the fonts partial — which injects/replaces a single `<link id="alchemist-brand-fonts">` built from the CSS2 API with `display=swap` |
| `radiusScale` (`"sharp"\|"soft"\|"round"`) | sets `--brand-radius-scale` + `data-radius-scale` attribute on `<html>` |
| `gradient.from` / `gradient.to` (hex) | sets `--brand-gradient-from`/`--brand-gradient-to`, validated independently |
| *(derived, not a v3 field)* `primaryColor` | also sets `--brand-primary-contrast` via `contrastTextFor()` |

The existing `isLightSurface` neutral guard (`--brand-neutral` only applies
when the generated neutral is light enough to be a page background) is
unchanged and covered by a source-shape lint.

### `web/src/lib/color-math.ts` — pure, unit-tested derivation math

`normalizeHex`, `isValidHex`, `relativeLuminance`, `contrastRatio`,
`isLightSurface`, `pickContrastText` (returns `{ color, ratio, passesAA }`).
DOM-free so it's importable straight from a Deno test
(`src/__tests__/design-tokens.test.ts`). `brand-loader.js` runs unbundled in
`<head>` and can't `import` from the Vite-built `web/src` tree, so it carries
a small duplicated copy of the same three formulas (`relativeLuminanceHex` /
`contrastTextFor`) — documented at both call sites so the two don't drift
silently.

## Gotchas

- `var(--brand-font-heading, "Inter")` only falls back when the custom
  property is **unset** — an empty string does NOT trigger the fallback.
  `brand-loader.js` never calls `setProperty` with an empty string for this
  reason (guards on `.trim()` truthiness before setting).
- `pickContrastText` always returns the *better* of white/ink, even when
  neither clears AA 4.5:1 (an extreme mid-tone brand color) — check
  `passesAA` if a caller needs to know whether the guarantee actually held,
  rather than assuming it always does.
- The Google Fonts `<link>` swap in `ensureGoogleFontsLink()` appends the
  new link before removing the old one, so there's no frame where zero
  font-loading `<link>` is present.
- `web/src/lib/color-math.ts` is intentionally NOT wired into any Svelte
  component in this slice — it exists to back `--brand-primary-contrast`'s
  math and be unit-testable. A future slice that needs contrast checks at
  the component level should import from here rather than re-deriving the
  formulas.
