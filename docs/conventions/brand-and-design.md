# Brand identity and the design system

## Brand identity — `src/config/brand.ts` is the only source of truth

The deployed product has a customer-facing name that is **not**
"Alchemist" — Alchemist is the platform that built this app, not
the product the end-user sees. The platform sets two env vars on
the customer pod:

- `APP_NAME` — the user-facing product name (e.g. "Pinterest
  Clone", "Pickleball Tournament Matchmaker"). Sourced from
  `platform.projects.brand_config.productName`.
- `EMAIL_FROM` — the verified transactional sender address
  (e.g. `noreply@yourapp.adaas.dev`).

`src/config/brand.ts` reads both at boot into a frozen `BRAND`
object:

```ts
import { BRAND } from "@/config/brand.ts";

BRAND.name      // "Pinterest Clone"  (or "Your App" if APP_NAME unset)
BRAND.fromEmail // "noreply@..."       (or "noreply@example.com" if unset)
BRAND.fromName  // mirrors BRAND.name; pre-formatted for "Name <email>"
```

**Every customer-facing surface that needs the product name MUST
import `BRAND` from this module.** Never inline
`Deno.env.get("APP_NAME") ?? "Alchemist"` — the literal
`"Alchemist"` is the leak. The defensive fallbacks are
deliberately generic ("Your App", `noreply@example.com`) so a
misconfigured pod renders a placeholder, not the platform's
codename.

Surfaces wired through `BRAND` today:
- `src/services/email.ts` — every transactional email subject,
  body, and `From:` header.
- `web/index.html` — title is the placeholder `Loading…`;
  `web/public/brand-loader.js` overrides `document.title` with
  `brand.productName` from `/brand.json` once the SPA boots.

When adding a new surface (OG meta, push notification copy,
exported PDFs), reach for `BRAND.*` first. If you find yourself
typing the literal "Alchemist" anywhere in this repo's customer-
facing code, stop — that's the bug this module exists to prevent.

## Design system — the FIRST step of every new project

Every project used to ship looking exactly like this template. That is the
bug this section fixes. **Before any feature work on a new project, run the
design pass:** pick a preset from the user's words, apply it, adjust one or
two things, save. Details + the judgement calls live in
`docs/design-principles.md` and the `.claude/rules/design.md` spoke.

**One file is the whole look:** `web/src/design/design.json` — three fonts
(heading / body / mono), five colours (primary, accent, background, surface,
text), radius family, shadow style, type scale, density. `web/src/design/
apply.ts` turns it into a `<style>` block that sets the `--brand-*` custom
properties (colours, fonts, radius scale, primary contrast) plus the derived
tokens every component reads, and injects the one Google Fonts `<link>` the
design needs. **design.json is the only source of the look:** the platform's
`brand-loader.js` applies the app name, logo, favicon and gradient from
brand.json. An app whose look has not moved into code yet still gets colours, fonts and radius in brand.json (set in the Brand panel), and the loader applies them on top, as before. Once the look moves, brand.json carries identity only. `web/src/app.css` is the token contract (`web/DESIGN.md` explains it);
design.json feeds it, it does not replace it. Dark mode stays the user's
toggle (`web/src/stores/theme.svelte.ts`); a design with `mode: "dark"` is
dark under both themes.

```bash
deno task design list                       # 9 presets + the words that map to them
deno task design match "calm premium spa"   # rank presets for a phrase
deno task design apply editorial            # replace design.json with a preset
deno task design set fonts.heading Fraunces # one value; validated (fonts, hex, WCAG)
deno task design set colors.primary "#8b2e1f"
deno task design check                      # exit 1 on a contrast error
```

Same path over HTTP for the platform chat: `GET /api/dev/design`
(current design + warnings + presets + font catalog, `?match=` ranks
presets), `PUT /api/dev/design`, `POST /api/dev/design/preset`.

**The sheet:** `/#/design` (public in dev, in the sidebar in dev) renders
every shipped component with the live design and a control rail: preset,
fonts from the curated catalog with a specimen browser, colours, mode,
shape, type, density, WCAG checks, and "Save to project". Open it after
any design change and after adding a component (new components go on the
sheet in the same change).

**Rules:**
- Never change the look by editing a component, `app.css` token values, or
  adding a font `<link>`. Change `design.json`. New COMPONENT classes still
  go in `app.css` per `web/DESIGN.md` (tokens only, no hex), and on the sheet.
- Components reference tokens only (`var(--font-heading)`,
  `var(--color-accent)`, `var(--radius-control)`, ...). A literal
  `font-family` or hex in `web/src/**/*.svelte` is a bug.
- Fonts come from Google Fonts. Prefer the catalog in
  `web/src/design/fonts.ts`; it carries the weights each family ships.
- Presets and hand edits must pass `validateDesign` (WCAG 2.2 AA text
  contrast is a hard error). The sheet, the CLI and the API all enforce it.
- For an open aesthetic request ("more premium"), propose ONE preset with a
  one-line reason and apply it so the user reacts to the real thing; take
  their reaction as a delta and change one axis at a time. Do not open a
  swatch for a bug fix or a value they already gave you.
