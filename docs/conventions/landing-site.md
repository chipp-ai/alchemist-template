# Landing site

## Landing site (`landing/`) vs the app (`web/`)

Marketing pages live in `landing/`, never in the SPA. The SPA renders nothing
until its JS runs, so answer engines (ChatGPT, Claude, Perplexity, Google AI)
and crawlers cannot read product facts that live only there.

**The homepage is the deployed root URL `/`.** Never leave the factory
placeholder landing at `/` and put the real homepage at `/app/#/`.

- **Marketing-first product:** write the real copy in
  `landing/src/content/site.json`. The seeded draft ("X is a web app.",
  "It is for anyone who needs what X does.") must never ship.
- **App-first product** (the app IS the homepage): set `"homepage": "app"`
  in `landing/src/content/site.json`. The server then serves the SPA at `/`
  (hash routes work: `/#/settings`), `/app/...` keeps working for old
  links, and the landing pages are not served: `/about`, `/pricing` and
  other landing pages redirect to `/` (`src/lib/landing-site.ts`).
  `llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap.xml`, the favicon and
  other static files are still served from `landing/`, so keep them there;
  the sitemap then lists only `/`. Never redirect `/` to `/app/`.
- **Build only in `web/` or `landing/`.** The image builds and serves only
  those two. A new top-level app folder is never deployed.
- **Verify with a production build and a screenshot of `/`,** not of
  `/app/#/` and not of the dev server.

`cd landing && npm test` enforces two of these: it fails when a project
with its own app pages still holds placeholder copy, and when a top-level
folder other than `web/` and `landing/` is a separate front end
(`landing/scripts/placeholder-copy.mjs`). Detail: `.claude/rules/landing.md`.

- **Where things are served.** `landing/dist` is served at `/` and the
  marketing paths (`/pricing/`, `/about/`, `/robots.txt`, `/sitemap.xml`). The
  app lives at `/app` (`APP_BASE_PATH` in `src/config/site.ts`), so app links
  are `/app/#/settings`. Build every server-side link into the app with
  `appPath("/#/...")`, never a hard-coded `"/#/..."`. Old `/#/x` links still
  work: the landing pages forward them to `/app/#/x`. `/api/*`, `/health`,
  `/.well-known` and the recipe routers are mounted ahead and are unchanged.
  If `landing/dist` is not built, or site.json sets `"homepage": "app"`,
  `/` serves the SPA (`src/lib/landing-site.ts`). App-first mode still
  serves landing/dist's non-HTML files (llms.txt, robots.txt, sitemap.xml,
  favicon, `/_astro/*`) and redirects its HTML pages to `/`.
- **Copy lives in `landing/src/content/site.json`.** Change the words there,
  not in the pages. The JSON-LD is built from the same values, so it always
  matches the visible text.
- **Fill what AI agents read.** site.json also takes `category` (name and
  audience, rendered as "<Product> is the <category> for <audience>." under
  the H1), `useCases`, `alternatives`, `agents` (MCP URL, OpenAPI, docs),
  `sameAs` and `pricing.currency`. They feed the JSON-LD (SoftwareApplication
  with Offers, Organization, FAQPage), the generated `/llms.txt` and
  `/llms-full.txt`, `/.well-known/api-catalog` and the "Use with your AI
  agent" section. Each is omitted when empty. Shapes: "What AI agents read"
  in `landing/README.md`.
- **The build enforces the AEO rules.** `cd landing && npm run build` runs
  `astro build` and then `scripts/aeo-check.mjs`; the same build runs in CI
  and in the deploy image, so a broken rule fails the deploy. The 11 rules,
  with the reason for each, are in `landing/README.md`. In short: semantic
  HTML with labels and alt text; key facts in the static HTML; a plain
  definition paragraph under the H1; at least one question heading answered
  in 100 words or less (the home page FAQ opens with the reader's main
  question and an honest "it depends" answer); a plain definition (what it is, who it is
  for, what it does) instead of a slogan; testimonials as plain text; "as of
  <Month Year>" on key facts; robots.txt open to AI search crawlers
  (meta-webindexer included); no broken links; visible Published and
  Updated dates plus the same dates in JSON-LD.
- **Preview.** The Builder runs the landing site as a second app ("Landing
  site", port 4321) from `.alchemist/dev-server.json`. Locally:
  `cd landing && npm install && npm run dev`.
- **A designed home page, not a FAQ.** The home page is a hero (`hero` in
  site.json), a product picture (`productShot`, a screenshot in
  `landing/public`), features, who it is for (`audience`), how it works
  (`steps`), pricing when there are plans, and the FAQ. `"starter": true`
  marks the platform's first draft; set it to `false` when a person asks for
  any change to the landing copy, so the build never rewrites their words.
- **More pages, a blog, forms, redirects, a migrated site.** Any number of
  pages at any path are JSON files in `landing/src/content/pages/` built from
  section components (hero, features, gallery, testimonials, pricing, FAQ,
  CTA, rich text, form, team, logos, sanitized HTML); blog posts are in
  `landing/src/content/posts/`. A `form` section posts to
  `POST /api/site-forms/<name>` (stored in `site_form_submissions`, owner
  emailed through the outbox). `chipp/redirects.json` holds 301/302
  redirects for paths nothing else serves. Approved analytics snippets go in
  `landing/src/content/custom-code.json`. **When
  `chipp/site-migration/site-model.json` exists, follow "Rebuilding a
  migrated site" in `.claude/rules/landing.md`**: rebuild every old page at
  its old path, keep its SEO, never invent content, and run
  `deno task check:old-urls` until it is clean (CI runs it too).
- **Brand.** The landing site reads colors, fonts, corners and shadows from
  `web/src/design/design.json` at build time, and `landing/src/styles/theme.css`
  overrides any token. Change the design there. The
  button label and link colors are derived by contrast (`bestTextOn` in
  `web/src/design/tokens.ts`), never hardcoded: a design may pick a white
  primary.
