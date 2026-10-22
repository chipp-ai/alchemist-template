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
- **Colors and fonts:** read from `../web/src/design/design.json` at build time.
  Label and link colors come from `bestTextOn` / `contrastRatio` in
  `../web/src/design/tokens.ts`, so a light primary gets a dark label.

To add a page: create `src/pages/<name>.astro` with `Layout`, an H1, then a
question as the first H2, then a short answer. Add it to `PAGES` in
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
3. **The reader's main question is the first H2 under the H1.** Write it the
   way a person would ask it ("Is Acme right for my team?").
4. **An honest "it depends" answer in 100 words or less** right under that
   question. Say when the product is a good fit and when it is not.
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
