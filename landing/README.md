# Landing site

A static Astro site for this product's public pages. The Deno app serves the
build (`landing/dist`) at `/`. The signed-in app lives at `/app`.

It exists so answer engines and crawlers can read what the product is. The
app is a single-page app: it renders nothing until its JavaScript runs, so
facts that live only there are invisible to them.

## Work on it

```bash
cd landing
npm install
npm run dev      # http://localhost:4321
npm run build    # astro build, then the AEO check
npm test         # AEO check, redirects, and real builds of the classic and a migrated site
npm run import:site-model   # a migrated site: chipp/site-migration/site-model.json -> content files
```

In the Builder it runs as a second preview app named "Landing site".

- **Words:** `src/content/site.json`. Every page and the JSON-LD read it.
- **Pages:** `src/pages/index.astro` ("/") and `src/pages/[...path].astro`
  (every other page), plus sitemap.xml and robots.txt. The classic home,
  about and pricing pages are `src/components/legacy/`.
- **Composed pages:** one JSON file per page in `src/content/pages/`, any
  path (nested too), built from sections in `src/components/sections/`
  (hero, features, gallery, testimonials, pricing, faq, cta, richText, form,
  team, logos, html). Shapes and rules: `src/lib/composed.ts`.
- **Blog:** one JSON file per post in `src/content/posts/` (each at its own
  `path`) and `blog` in site.json (the list page).
- **Custom code:** approved analytics snippets in `src/content/custom-code.json`,
  printed in the head or before `</body>` of every landing page.
- **Redirects:** `../chipp/redirects.json`, validated by the build and served
  by the app (and by `npm run dev`).
- **Layout:** `src/layouts/Layout.astro` (header, nav, main, footer, dates, JSON-LD).
- **Look:** colors, fonts, corners and shadows are read from
  `../web/src/design/design.json` at build time, so the site matches the app.
  Label, link and muted colors come from `bestTextOn` / `contrastRatio` /
  `tintForContrast` in `../web/src/design/tokens.ts`, so text always reads.
  `src/styles/theme.css` overrides any token (the build fills it from the
  approved plan's prototype styles).
- **Product picture:** `productShot` in site.json points at a screenshot in
  `public/` (for example `/product.png`). Without one the home page draws a
  product sketch from the features.

## The home page

A hero (`hero.headline` is the H1, `hero.subhead` the plain definition under
it, the main and a second call to action), the product picture, features,
who it is for (`audience`), how it works (`steps`), pricing when there are
plans, the FAQ, and a closing call to action. The reader's main question
(`mainQuestion` and `itDependsAnswer`) is the first FAQ entry.

`"starter": true` marks the platform's first draft. The build may rewrite a
starter landing from the approved plan. When a person asks for any change to
the landing copy, set it to `false` so nothing rewrites their words.

To add a page: add `src/content/pages/<name>.json` with its `path`, `title`,
`seo`, an optional `navLabel` (puts it in the nav) and its `sections`. The
first section heading is the H1; put a plain definition paragraph under it
(a hero `subhead` or a section `intro`) and at least one question heading
with a short answer (a `faq` section). It is in the sitemap on its own.

A composed page for `/` makes the whole site composed: every page then comes
from `src/content/pages/`, and the classic about and pricing pages are not
built. A rebuilt (migrated) site works this way. See "Rebuilding a migrated
site" in `../.claude/rules/landing.md`.

## The AEO rules

`scripts/aeo-check.mjs` runs after every build, in CI, and in the deploy
image. A page that breaks a rule fails the build.

1. **Accessibility tree.** Icon-only buttons and links have an `aria-label`.
   Every form field has a `<label>`. Every image has descriptive `alt` text.
   Never put key context only in an image. Assistants read the accessibility
   tree, not the pixels.
2. **Key product info in static HTML.** Facts go in the page's HTML, not in
   client JavaScript, tabs that load later, or images.
3. **A plain definition right under the H1**, 60 words or less. The H1 can be
   a sharp headline; the paragraph under it says what the product is.
4. **The reader's questions, answered in 100 words or less.** Every page has
   at least one H2 or H3 that is a question, written the way a person asks
   it, with the answer in the paragraph under it. On the home page this is
   the FAQ, which opens with an honest "it depends" answer to the main
   question: say when the product is a good fit and when it is not.
5. **A clear definition, not a slogan.** Say what it is, who it is for, and
   what it does, in plain words (`definition` in site.json).
6. **Testimonials as plain text.** Quote, name, role. Never an image of a
   quote. Use only real quotes from real customers, with their consent.
7. **"As of <Month Year>" on key facts** such as prices and features
   (`asOf` in site.json). Update it when the facts change.
8. **robots.txt lets AI search crawlers in**, meta-webindexer included.
   Training-only crawlers stay blocked.
9. **No broken links.** Every internal link resolves to a built page. Links
   into `/app` and `/api` are served by the app and are not checked here.
10. **Semantic HTML.** `header`, `nav`, `main`, `footer`, real headings in
    order, `<button>` for actions (never a clickable `div` or `span`).
11. **Visible Published and Updated dates**, plus the same dates in JSON-LD
    (`datePublished`, `dateModified`). Change `updatedAt` when the content
    changes.

The FAQ JSON-LD is built from the same `faq` list the page shows, and the
check fails if the two ever differ.

Words carried over from an old site are not rewritten to fit rules 3 and 4:
that would mean inventing copy. Pages with `importedFrom` and blog posts
carry `<main data-aeo="relaxed">`, and the check prints those two rules as
warnings for them. Every other rule still fails the build. A link to an old
URL that `../chipp/redirects.json` redirects counts as resolved when the
redirect's target is a built page, and approved custom code is skipped.
