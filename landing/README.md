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
npm test         # tests for the AEO check
```

In the Builder it runs as a second preview app named "Landing site".

- **Words:** `src/content/site.json`. Every page and the JSON-LD read it.
- **Pages:** `src/pages/` (index, pricing, about, sitemap.xml, robots.txt).
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

To add a page: create `src/pages/<name>.astro` with `Layout`, an H1, a plain
definition paragraph under it, and at least one question heading with a
short answer. Add it to `PAGES` in
`src/lib/site.ts` so it is in the nav and the sitemap.

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
