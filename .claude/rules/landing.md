---
name: landing
description: The homepage at the deployed root URL "/" -- the landing site in landing/ vs the SPA in web/, the factory placeholder copy in landing/src/content/site.json that must never ship, app-first products that serve the app at "/", building only in web/ or landing/, and brand colors on the landing site. Load when touching landing/ or src/lib/landing-site.ts.
paths:
  - "landing/**"
  - "src/lib/landing-site.ts"
---

# The homepage is "/"

Visitors, link previews and answer engines open the deployed root URL `/`.
Whatever renders there IS the product's homepage. Two of three pilot
projects left the factory placeholder landing at `/` and built the real
homepage at `/app/#/`, so the product looked unfinished to every visitor.

## Pick one, on purpose

- **Marketing-first product.** `/` is the landing site. Write the real
  words in `landing/src/content/site.json`. The seeded draft is scaffolding:
  "X is a web app.", "It is for anyone who needs what X does.", "X runs in
  the browser, so there is nothing to install.", "X is made by the team
  that runs it." and the template's "Your product" copy must never ship.
- **App-first product** (a calculator, an editor, a board: the app IS the
  homepage). Serve the app at `/`. Either make the landing index redirect to
  `/app/`, or remove `landing/`; with no `landing/dist`, `/` serves the SPA
  (`src/lib/landing-site.ts`).

## Build only in `web/` or `landing/`

The Dockerfile builds and serves exactly two front ends: the SPA in `web/`
(at `/app`) and the landing site in `landing/` (at `/`). A new top-level
folder with its own `package.json` or `index.html` is never built and never
deployed, however good it looks on a dev server.

## Verify what visitors see

Run the production build (`cd landing && npm run build`, `cd web && npm run
build`), start the server, and screenshot `/`. A screenshot of `/app/#/` or
of a dev server does not show the homepage.

## Enforced by `npm test`

`landing/scripts/placeholder-copy.test.mjs` (run by `cd landing && npm test`
and in CI) fails when:

- the project has route files beyond the template's (`BASE_ROUTE_FILES`) or
  a stray app folder, and `site.json` still holds placeholder copy;
- a top-level folder other than `web/` and `landing/` is a separate front
  end.

A brand-new project passes: its draft copy is allowed until it has its own
pages. If the template gains a route, update `BASE_ROUTE_FILES`; the test
fails in the template repo until you do.

## Brand colors

The landing site reads `web/src/design/design.json`. The button label and
link colors are derived by contrast (`bestTextOn`, `contrastRatio` in
`web/src/design/tokens.ts`), never hardcoded: a design may choose a white
primary on a dark canvas, and a hardcoded white label then vanishes.
