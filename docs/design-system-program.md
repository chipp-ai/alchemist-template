# Template design-system program ("S-series"): awe-inspiring by default

**Status:** DESIGN OF RECORD (2026-07-28, operator-approved). Goal: every project
generated from an Alchemist template starts as a polished, consumer-grade
product -- "looks like a funded startup designed it" -- and STAYS at that bar as
agents extend it. Companion docs: `template-demos.md` (the demos this makes
worth showing), `template-commerce-storefront.md`, `template-cms-analysis.md`.

## Diagnosis

The templates are functionally rich but visually utilitarian: the base
`web/src/app.css` is a minimal kit (flat color vars, basic `.input`/`.btn`/
`.card`), no type scale, no elevation/motion language, dark mode only by
accident (the 2026-07-28 half-dark bug). Meanwhile the platform's unfair
advantage -- per-project AI brand GENERATION -- only emits 3 colors + a logo.

## Work items

### S1 (base template repo `alchemist-template`): design-system core + guardrails

One ticket, lands the system + the contract that keeps it:

- **Tokens**: full scale set -- type (display + body families via brand vars,
  modular size scale), spacing, radius (driven by a brand radius personality),
  elevation (3 shadow levels), semantic colors DERIVED from the brand palette
  with `color-mix` (primary -> hover/active/subtle/soft-tint; never hand-picked
  hexes in components). Focus-visible rings everywhere interactive.
- **Typography**: `--brand-font-heading` / `--brand-font-body` consumed with
  system-stack fallbacks; loaded via one fonts partial keyed to brand.json v3
  (contract below); no FOUT flash (font-display swap + metric-compatible
  fallbacks).
- **Motion language**: small, tasteful, consistent -- staggered reveal-on-scroll
  utility, button press/hover states, skeleton loaders (never spinners for
  content), toast enter/exit springs, View Transitions API for SPA route
  changes where supported. ALL motion behind `prefers-reduced-motion`.
- **Dark mode as a deliberate theme**: a real `[data-theme="dark"]` token set
  (derived surfaces, adjusted shadows), user-toggleable, defaulting to light.
  Never OS-preference-driven partial theming.
- **Component kit refresh** on the existing classes (buttons incl. loading
  state, inputs with float/label polish, cards, tables, modals, toasts, empty
  states, badges) -- same class names where possible so existing template code
  upgrades in place.
- **A11y = quality**: AA contrast guaranteed by the derivation helpers,
  keyboard nav, visible focus, reduced-motion, semantic markup in kit examples.
- **S5 guardrails land IN this ticket**: a `web/DESIGN.md` contract (token
  usage rules, no raw hex in components, motion conventions, how to add a
  component) referenced from CLAUDE.md, plus lint tests: no raw hex colors in
  component/page styles (tokens only), no `transition: all`, fonts only via
  the brand vars. Agents extend at the bar because the bar is enforced.

### S2a (chipp-deno platform): brand kit v3 generation

Extend `brand-generation.service.ts` + `brandService` schema:

- New OPTIONAL brand.json fields (v3 contract, all nullable -- consumers must
  fall back gracefully): `fontHeading` + `fontBody` (chosen from a CURATED
  allowlist of ~12 Google Fonts pairings baked into the generator prompt --
  never a free-form font name), `radiusScale` ("sharp" | "soft" | "round"),
  `gradient` ({from, to} hex pair derived from the palette for hero/mesh
  accents). Neutral stays clamped light (the existing
  `clampNeutralToLightSurface` guard).
- Server-side validation mirrors the allowlists (font names + radius enum +
  hex pair) -- LLM output is untrusted input.
- Existing projects keep their v2 blobs untouched; regeneration is opt-in.

### S1p (per variant repo x3): port S1

Seeded repos do not auto-inherit -- one port ticket each for storefront /
commerce / cms applying the S1 system + DESIGN.md + lints, adapting their
surface-specific styles (SSR pages included: the storefront landing, commerce
PDP, CMS block renderers consume the same tokens).

### S3 (base template, after S1): the judged moments

Auth/onboarding split-panel with brand identity + polished OTP entry;
beautiful empty states everywhere a list can be empty; delightful branded 404;
blur-up image loading conventions; BRANDED transactional email templates (OTP,
invites -- table-layout, brand colors, real fallbacks); PWA installability
(manifest + brand icons/splash; borrow chipp-deno's PWA learnings).

### S4 (per variant, after S1p): signature moments

- Commerce: product gallery with zoom/lightbox island, slide-in cart drawer
  island, checkout/receipt polish, order emails.
- CMS: the default BLOCK LIBRARY is the product -- stunning hero/testimonial/
  CTA/gallery/pricing blocks; agency console empty states.
- Storefront: pricing + testimonial + FAQ sections worth screenshotting;
  landing hero gradient/mesh keyed to brand.
- Demo re-seed refresh afterward so the gallery demos show the new bar.

## Sequencing

S1 and S2a dispatch NOW in parallel (the v3 contract above is fixed here, so
S1 consumes the new vars with fallbacks before S2a ships them). S1p x3 dispatch
after S1 lands; S3 after S1; S4 after each S1p. Demos re-verified at the end.

## Invariants

- brand.json consumers NEVER hard-require v3 fields (nullable, fallbacks).
- No component/page style may hard-code a hex that exists as a token (lint).
- Dark neutral can never reach a light surface (three-layer guard already
  shipped 2026-07-28: generator prompt, `clampNeutralToLightSurface`, loader
  `isLightSurface`).
- Every motion effect respects `prefers-reduced-motion` (lint greps for bare
  keyframe use outside the motion utilities).
