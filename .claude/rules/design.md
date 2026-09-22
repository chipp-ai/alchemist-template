---
name: design
description: Design system — design.json is the only source of the app's look; presets, the curated font catalog, the /#/design sheet, and the rules for adding components. Load when touching web/src/design, app.css, any *.svelte styling, or when the user talks about fonts, colours, vibe or brand.
paths:
  - "web/src/design/**"
  - "web/src/app.css"
  - "web/src/routes/Design.svelte"
  - "web/src/**/*.svelte"
  - "src/services/design.service.ts"
  - "scripts/design.ts"
---

# Design system

Authoritative for how the app looks. The full playbook for TALKING about
design with a user (which preset for which words, typography and colour
principles, the conversation loop) is `docs/design-principles.md`; read it
when the request is aesthetic.

## One file

`web/src/design/design.json` is the repo-side source of the look.
`web/src/design/apply.ts` turns it into a `<style id="design-tokens">` block
before the app mounts and injects the single Google Fonts `<link>`. It writes
the SAME `--brand-*` variables the platform's `brand-loader.js` sets from
brand.json (`--brand-primary/-accent/-neutral`, v3 `--brand-font-heading/
-body`, `--brand-radius-scale` + `data-radius-scale`,
`--brand-primary-contrast`), so a platform brand config can still override at
runtime; every derived token in `app.css` reaches the brand through `var()`.
`web/src/app.css` remains the token + component contract documented in
`web/DESIGN.md` (color-mix ramps, `[data-theme="dark"]`, `[data-radius-scale]`,
motion); design.json feeds it and never replaces it.

- **Change the look by changing design.json**, through one of:
  `deno task design apply <preset>` / `set <path> <value>`, the `/#/design`
  page's "Save to project", or `PUT /api/dev/design`. All three validate.
- **Never** edit `app.css` token values, add a `<link>` for a font, or put
  a `font-family` / hex colour in a component to change the look.
- **Dark mode is the user's toggle** (`theme.svelte.ts`, default light,
  never OS-inferred). `mode: "dark"` in design.json means the palette is
  dark by construction and is emitted under both themes; a light design
  gets `app.css`'s dark block under the toggle.
- **Radius presets map to the brand v3 personality**: none/sm → sharp,
  md → soft, lg/pill → round (`RADIUS_SCALE_LABEL`); concrete `--radius-*`
  and `--radius-control` are emitted too. Controls use `--radius-control`.
- **Every component reads tokens** (`var(--color-*)`, `var(--font-*)`,
  `var(--radius-*)`, `var(--space-*)`, `var(--text-*)`,
  `var(--border-width)`, `var(--shadow-*)`). A literal hex or family name in
  `web/src/**/*.svelte` is a bug unless it is a third-party brand mark
  (the Google "G" logo).

## Presets + fonts

- `web/src/design/presets.ts`: nine complete designs with `vibe` words
  (`matchPresets(text)`), `suits`, and a `rationale`. Every preset passes
  `validateDesign` with zero errors; a new preset must too (pinned by
  `src/__tests__/services/design.test.ts`).
- `web/src/design/fonts.ts`: the curated Google Fonts catalog with real
  weight lists. Families outside it work but load at 400/700 only. Add a
  family with the weights it actually ships; the Google CSS API rejects a
  weight that does not exist.
- The runtime requests only the weights the design renders
  (`fontRequestsFor`); the font browser loads glyph-subset specimens
  (`loadFontSpecimen`). Do not preload the whole catalog.

## Tokens

`web/src/design/tokens.ts` derives everything from five colours + shape +
type + density. Borders, muted text, hover, soft tints and button label
colour are computed (60/30/10, ink-at-alpha, contrast-chosen labels).
`validateDesign` enforces WCAG 2.2 AA: text on canvas and on surface ≥
4.5:1 are hard errors; weak button labels and a primary under 3:1 against
the canvas are warnings. Keep the module dependency-free: the Deno API
imports it too.

## Components

- The sheet at `/#/design` renders every shipped component. **Adding a
  component means adding it to the sheet** in the same change, with a
  `data-testid="design-sheet-<component>"`.
- Global classes live in `app.css` (upstream kit + the "design.json
  extensions" section at the bottom): `.btn` (+ `-primary/-secondary/-ghost/
  -danger/-link`, `-sm/-lg`, `[data-loading]`), `.input .select .textarea
  .label .help-text .form-field .checkbox .radio .switch`, `.card .card-title
  .stat-card .divider`, `.badge` (+ `-accent/-highlight/-success/-warning/
  -danger`), `.alert` (+ `-info/-error/-success/-warning`), `.tabs .tab`,
  `.list-rows .list-row .list-row-main .list-row-title .list-row-meta
  .list-row-actions`, `.table-wrap .table`, `.avatar`, `.page-header
  .page-title .page-subtitle .section-title .subsection-title .text-muted
  .empty-state .stack .row`; `.skeleton*`, `.reveal`, toasts live in
  `motion.css`.
- Route-scoped `<style>` is for layout of that route only. If a rule would
  apply to a second route, it belongs in `app.css` as a class.
- Controls use `--radius-control`; cards use `--radius-lg`. Under the `pill`
  preset controls are round and cards are not; do not special-case.
- The platform's `brand-loader.js` may override `--brand-primary`,
  `--brand-accent`, `--brand-neutral` at runtime. Derived tokens reference
  those through `var()`, so keep that indirection when adding colour tokens.
