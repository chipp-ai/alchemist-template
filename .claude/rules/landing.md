---
name: landing
description: The homepage at the deployed root URL "/" -- the landing site in landing/ vs the SPA in web/, the factory placeholder copy in landing/src/content/site.json that must never ship, app-first products that serve the app at "/", building only in web/ or landing/, brand colors on the landing site, composed pages at any path, the blog, site forms, redirects, approved custom code, and rebuilding a migrated site (chipp/site-migration/). Load when touching landing/, chipp/site-migration/, chipp/redirects.json or the site forms and redirects code.
paths:
  - "landing/**"
  - "src/lib/landing-site.ts"
  - "src/lib/site-redirects.ts"
  - "src/services/site-forms.service.ts"
  - "src/api/routes/site-forms/**"
  - "scripts/check-old-urls.ts"
  - "chipp/site-migration/**"
  - "chipp/redirects.json"
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

## Pages: classic and composed

Two kinds of landing page build side by side:

- **Classic pages:** home, about and pricing, written from `site.json`
  (`src/components/legacy/`). A new product starts here.
- **Composed pages:** one JSON file per page in `landing/src/content/pages/`,
  at any path (`/services/roofing/` works), built from section components
  in `landing/src/components/sections/`: `hero`, `features`, `gallery`,
  `testimonials`, `pricing`, `faq`, `cta`, `richText`, `form`, `team`,
  `logos`, and `html` (a sanitized fallback for a block no other section
  fits). Each page has its own `title` and `seo` (`title`, `description`,
  `canonical`, `og`, `jsonLd`, `noindex`). Shapes and validation:
  `landing/src/lib/composed.ts`. A bad file fails `npm run build` with
  every problem listed.

A composed page for `/` makes the whole site composed: every page comes
from `src/content/pages/` and the classic about and pricing pages are not
built. Without one, composed pages add paths next to the classic three. The
sitemap lists every indexable page with its own date; `navLabel` puts a
page in the nav, or `nav` in site.json sets the header and footer links.

- **Blog:** posts in `landing/src/content/posts/*.json`, each at its own
  `path` (keep the old URL), and `blog` in site.json for the list page
  (`path`, `title`, `description`). Post HTML is sanitized at build time.
- **Forms:** a `form` section renders any fields (text, email, tel, url,
  number, date, textarea, select, radio, checkbox, checkboxes, hidden) with
  the right `type`, `inputmode` and `autocomplete`, at 16px. It posts to
  `POST /api/site-forms/<form name>`, which validates against the same
  fields, stores the submission as JSONB in `site_form_submissions`, and
  queues an email to the owner through the outbox (`LEAD_NOTIFICATION_EMAIL`,
  else the first owner account). Honeypot and per-IP limit included. Do not
  build another form endpoint for a landing form.
- **Redirects:** `chipp/redirects.json`
  (`{ "redirects": [{ "from": "/old", "to": "/new/", "status": 301 }] }`).
  The app serves them for any path no page or route answers; `npm run dev`
  serves them too. The build and the tests fail on a loop, a `from` that is
  not a site path, a status other than 301 or 302, or a rule that never
  fires because a page exists at its `from`.
- **Custom code:** analytics or pixel snippets go in
  `landing/src/content/custom-code.json` (`snippets`: `name`, `placement`
  `"head"` or `"bodyEnd"`, `html`, `approvedBy`, `approvedAt`). Only a
  snippet with both approval fields is rendered, and only on the landing
  site. Add one only after the owner approved that exact snippet; record
  who and when. Never add a snippet on your own initiative.

## Rebuilding a migrated site

When `chipp/site-migration/site-model.json` exists, Chipp crawled the
owner's old site (WordPress, Wix, Squarespace, Webflow, Framer) and the job
is to rebuild it here, page for page, at the same URLs. The files:

- `chipp/site-migration/site-model.json`: `meta` (origin, platform),
  design tokens, `pages` (path, title, `seo`, `screenshot.desktop` and
  `.mobile`, sometimes `sections`), `forms`, `navigation`, `assets`
  (`oldUrl` -> rehosted `newUrl`), `redirects`, `collections` (blog posts)
  and `warnings`.
- `chipp/site-migration/old-urls.json`: every URL the old site served.
- `chipp/redirects.json`: redirects Chipp already knows about.

The workflow:

1. **Read the model and look at every screenshot** before writing anything.
   The screenshots are the source of truth for layout and order.
2. **Run `cd landing && npm run import:site-model`.** It writes one page file
   per page at the same path with the old title, description, canonical,
   Open Graph and JSON-LD, every blog post at its old path, a form section
   for every form, and `nav` and `blog` in site.json. It rewrites old asset
   URLs to the rehosted ones and old-origin links to site paths. It never
   overwrites a file that exists (`-- --force` does). Read its output:
   skipped sections and TODO lines are the work left.
3. **Rebuild every page with the section components**, in the order the
   screenshot shows, with the old page's words. A page the importer left
   with no sections must be rebuilt from its screenshot. Use `richText` for
   prose, a real section wherever one fits, and `html` only as a last
   resort.
4. **Keep the SEO exactly:** never change a page's `path`, `seo.title`,
   `seo.description`, canonical or JSON-LD unless the owner asks. Set
   `site.json` `url`, `name`, `description` and `definition` from the old
   home page.
5. **Use the rehosted asset URLs** (`assets[].newUrl`), never the old
   site's URLs, and keep each image's alt text. Write alt text only where
   the old site had none and the picture carries meaning.
6. **Rebuild forms with the `form` section** (the importer places them).
   Never point a form at the old site or a third-party form service.
7. **Add a redirect only when a path must change** (a `.html` or `.php`
   path, a page the owner wants dropped). Point it at the final page, never
   at another redirect. A rule matches the path with or without its
   trailing slash and ignores the query string.
8. **Start the app and run `deno task check:old-urls http://localhost:<port>`
   until it is clean.** Every old URL must answer 200, or 301/302 to a 200.
   CI runs the same gate whenever `old-urls.json` exists.
9. **Never invent content.** No new headings, claims, prices, reviews,
   FAQs or testimonials. When the old page lacks something an AEO rule
   wants, the build prints a warning for imported pages (`importedFrom`);
   leave it, or ask the owner for the words.

Design: start from the model's design tokens (`deno task design set ...`),
so the rebuilt site keeps the old site's colors and fonts.
