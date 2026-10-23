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
  homepage). Set `"homepage": "app"` in `landing/src/content/site.json`.
  The server reads it at boot (`readHomepageMode` in
  `src/lib/landing-site.ts`) and serves the SPA shell at `/`: the address
  bar shows `/` and `/#/...` hash routes work. The landing pages (`/about`,
  `/pricing`, any HTML page in landing/dist) answer a 302 redirect to `/`.
  `llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap.xml`, the favicon and
  other static files are still served from landing/ (the Builder's SEO
  settings write `landing/public/llms.txt`), and the sitemap lists only
  `/`. Keep those files in landing/; never move them into web/. `/app/...` keeps working for old links and `appPath()` links. Do
  not redirect `/` to `/app/`, and do not hand-edit app.ts for this. A
  missing field, or any other value, is the default landing mode. If the
  app's home page needs no sign-in, also list `"/"` in `recipePublicRoutes`
  (`web/src/recipe-routes.ts`), or a signed-out visitor lands on the login
  form.

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
pages. An app-first project (`"homepage": "app"`) skips the copy check,
because the landing site is not served. If the template gains a route, update `BASE_ROUTE_FILES`; the test
fails in the template repo until you do.

## Brand colors

The landing site reads `web/src/design/design.json`. The button label and
link colors are derived by contrast (`bestTextOn`, `contrastRatio` in
`web/src/design/tokens.ts`), never hardcoded: a design may choose a white
primary on a dark canvas, and a hardcoded white label then vanishes.
