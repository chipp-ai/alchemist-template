// Builds real landing sites in temp copies of landing/: the classic
// three-page site.json, and the fixture SiteModel imported into composed
// pages (src/__tests__/fixtures/site-migration). Run with: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDist } from "./aeo-check.mjs";
import { convertForm, fileNameForPath, formatReport, importSiteModel, makeContentReader, makeRewriter, planImport } from "./import-site-model.mjs";
import { catalogProblems } from "../src/lib/composed.ts";

const LANDING = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(LANDING, "..");
const FIXTURES = join(REPO, "src", "__tests__", "fixtures");
const FIXTURE = join(FIXTURES, "site-migration");

/** A temp repo with a copy of landing/ (shared node_modules) and web/src/design. */
function tempRepo({ withFixture = false, fixture = FIXTURE, siteJson } = {}) {
  const root = mkdtempSync(join(tmpdir(), "landing-site-"));
  const skip = new Set(["node_modules", "dist", ".astro"]);
  cpSync(LANDING, join(root, "landing"), {
    recursive: true,
    filter: (src) => !relative(LANDING, src).split(sep).some((part) => skip.has(part)),
  });
  symlinkSync(join(LANDING, "node_modules"), join(root, "landing", "node_modules"), "dir");
  cpSync(join(REPO, "web", "src", "design"), join(root, "web", "src", "design"), { recursive: true });
  // Start from the template's own content: no composed pages or posts.
  rmSync(join(root, "landing", "src", "content", "pages"), { recursive: true, force: true });
  rmSync(join(root, "landing", "src", "content", "posts"), { recursive: true, force: true });
  if (siteJson) writeFileSync(join(root, "landing", "src", "content", "site.json"), JSON.stringify(siteJson, null, 2));
  if (withFixture) cpSync(join(fixture, "chipp"), join(root, "chipp"), { recursive: true });
  return root;
}

function build(root) {
  const landing = join(root, "landing");
  execFileSync(process.execPath, [join(landing, "node_modules", "astro", "bin", "astro.mjs"), "build", "--silent"], {
    cwd: landing,
    stdio: "pipe",
  });
  return join(landing, "dist");
}

const read = (dist, path) => readFileSync(join(dist, path), "utf8");

test("the classic three-page site.json builds exactly the three pages and passes the AEO check", () => {
  const root = tempRepo();
  try {
    const dist = build(root);
    for (const page of ["index.html", "about/index.html", "pricing/index.html"]) assert.ok(existsSync(join(dist, page)), page);
    const { pages, problems } = checkDist(dist);
    assert.equal(pages, 3);
    assert.deepEqual(problems, []);
    const home = read(dist, "index.html");
    assert.match(home, /<h1 id="hero-title"[^>]*>Keep the whole job in one place<\/h1>/);
    assert.match(read(dist, "sitemap.xml"), /<urlset/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an older site.json without hero, audience, steps, nav or blog still builds", () => {
  const site = JSON.parse(readFileSync(join(LANDING, "src", "content", "site.json"), "utf8"));
  for (const key of ["hero", "audience", "steps", "productShot", "starter", "nav", "blog"]) delete site[key];
  site.url = "https://acme.example.com";
  const root = tempRepo({ siteJson: site });
  try {
    const dist = build(root);
    assert.deepEqual(checkDist(dist).problems, []);
    const sitemap = read(dist, "sitemap.xml");
    for (const p of ["/", "/pricing/", "/about/"]) assert.ok(sitemap.includes(`<loc>https://acme.example.com${p}</loc>`), p);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composed pages add nested paths next to the classic pages", () => {
  const root = tempRepo();
  try {
    const pagesDir = join(root, "landing", "src", "content", "pages");
    const page = {
      path: "/services/roofing",
      title: "Roof replacement",
      navLabel: "Roofing",
      seo: { description: "Full roof replacement.", noindex: true },
      sections: [
        { type: "hero", heading: "Roof replacement", subhead: "We replace roofs in one or two days." },
        { type: "faq", heading: "Questions", items: [{ question: "How long does it take?", answer: "One or two days." }] },
      ],
    };
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "roofing.json"), JSON.stringify(page));
    const dist = build(root);
    assert.deepEqual(checkDist(dist).problems, []);
    for (const p of ["index.html", "about/index.html", "pricing/index.html", "services/roofing/index.html"]) {
      assert.ok(existsSync(join(dist, p)), p);
    }
    const html = read(dist, "services/roofing/index.html");
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /"@type":"FAQPage"/);
    assert.match(read(dist, "index.html"), /href="\/services\/roofing\/"[^>]*>Roofing<\/a>/, "navLabel adds it to the nav");
    assert.ok(!read(dist, "sitemap.xml").includes("/services/roofing/"), "noindex pages stay out of the sitemap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bad composed page fails the build with the problem named", () => {
  const root = tempRepo();
  try {
    const pagesDir = join(root, "landing", "src", "content", "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "bad.json"), JSON.stringify({ path: "/x.html", title: "X", sections: [{ type: "slider" }] }));
    assert.throws(() => build(root), (err) => {
      const out = String(err.stderr) + String(err.stdout);
      assert.match(out, /looks like a file/);
      assert.match(out, /unknown section type "slider"/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a redirect loop in chipp/redirects.json fails the build", () => {
  const root = tempRepo();
  try {
    mkdirSync(join(root, "chipp"), { recursive: true });
    writeFileSync(
      join(root, "chipp", "redirects.json"),
      JSON.stringify({ redirects: [{ from: "/a", to: "/b", status: 301 }, { from: "/b", to: "/a", status: 302 }] }),
    );
    assert.throws(() => build(root), (err) => /redirect loop: \/a -> \/b -> \/a/.test(String(err.stderr) + String(err.stdout)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the early draft SiteModel shape (assets[], collections list, seo.og) still imports and renders", () => {
  const site = JSON.parse(readFileSync(join(LANDING, "src", "content", "site.json"), "utf8"));
  site.name = "Fixture Roofing";
  site.url = "https://fixture-roofing.example.com";
  site.cta = { label: "Get an estimate", href: "/about-us/#form-contact-us" };
  const root = tempRepo({ withFixture: true, siteJson: site });
  try {
    const report = importSiteModel({ repoRoot: root });
    assert.ok(report.skipped.some((s) => s.includes("carousel")), "unknown sections are reported, not invented");
    assert.equal(report.todo.length, 0, report.todo.join("\n"));
    const imported = JSON.parse(readFileSync(join(root, "landing", "src", "content", "site.json"), "utf8"));
    assert.deepEqual(imported.blog, {
      path: "/blog/",
      title: "Roofing tips | Fixture Roofing",
      description: "Short articles about keeping a roof in good shape.",
    });
    assert.equal(imported.nav.header[0].href, "/services/roofing", "old-origin nav links become site paths");

    const dist = build(root);
    const { problems, warnings } = checkDist(dist);
    assert.deepEqual(problems, []);
    assert.ok(warnings.length > 0, "imported pages report content-shape rules as warnings");

    // Every page at its original path. The classic about and pricing pages are gone.
    for (const p of ["index.html", "about-us/index.html", "services/roofing/index.html", "blog/index.html", "blog/spring-roof-check/index.html"]) {
      assert.ok(existsSync(join(dist, p)), p);
    }
    assert.ok(!existsSync(join(dist, "about", "index.html")));
    assert.ok(!existsSync(join(dist, "pricing", "index.html")));

    // Home: title, meta, canonical on the new origin, Open Graph, carried JSON-LD minus FAQPage.
    const home = read(dist, "index.html");
    assert.match(home, /<title>Fixture Roofing \| Roof repair and replacement<\/title>/);
    assert.match(home, /<meta name="description" content="Fixture Roofing repairs and replaces roofs for homes in the valley.">/);
    assert.match(home, /<link rel="canonical" href="https:\/\/fixture-roofing.example.com\/">/);
    assert.match(home, /<meta property="og:image" content="https:\/\/cdn.example.com\/fixture\/roof.jpg">/);
    assert.match(home, /<meta property="og:site_name" content="Fixture Roofing">/);
    assert.match(home, /"@type":"RoofingContractor"/);
    assert.equal((home.match(/"@type":"FAQPage"/g) ?? []).length, 1, "only the visible FAQ becomes FAQPage");
    assert.match(home, /<h1 id="s1-title"[^>]*>Roofs that last through every season<\/h1>/);
    assert.match(home, /src="https:\/\/cdn.example.com\/fixture\/roof.jpg"/, "assets use the rehosted URL");
    assert.match(home, /href="\/services\/roofing"/, "old-origin links become site paths");
    assert.match(home, /data-aeo="relaxed"/);

    // About: sanitized rich text, demoted h1, decorative image, the form.
    const about = read(dist, "about-us/index.html");
    assert.ok(!about.includes("alert(1)"), "scripts are stripped");
    assert.match(about, /<h2>Our story<\/h2>/);
    assert.match(about, /<img src="https:\/\/cdn.example.com\/fixture\/crew.jpg" alt="" aria-hidden="true"/);
    assert.match(about, /<form [^>]*action="\/api\/site-forms\/contact-us"/);
    assert.match(about, /<input id="form-contact-us-your-email" name="your-email" required[^>]*type="email" inputmode="email" autocomplete="email"/);
    assert.match(about, /<input id="form-contact-us-phone" name="phone"[^>]*type="tel" inputmode="tel" autocomplete="tel"/);
    assert.match(about, /<select id="form-contact-us-service" name="service" required/);
    assert.match(about, /<textarea id="form-contact-us-your-message" name="your-message"/);
    assert.match(about, /name="_website"/, "honeypot");
    assert.match(about, /<input type="hidden" name="_page" value="\/about-us\/"/);

    // Nested page with the canonical rewritten to the new origin.
    const roofing = read(dist, "services/roofing/index.html");
    assert.match(roofing, /<link rel="canonical" href="https:\/\/fixture-roofing.example.com\/services\/roofing\/">/);

    // Blog list and post.
    const list = read(dist, "blog/index.html");
    assert.match(list, /<a href="\/blog\/spring-roof-check\/"[^>]*>A spring roof check in five steps<\/a>/);
    const post = read(dist, "blog/spring-roof-check/index.html");
    assert.match(post, /"@type":"BlogPosting"/);
    assert.match(post, /<meta property="og:type" content="article">/);
    assert.match(post, /Published <time datetime="2026-04-02"/);
    assert.match(post, /href="\/about-us\/"/);

    // Sitemap: every page and the post, with their own dates.
    const sitemap = read(dist, "sitemap.xml");
    for (const p of ["/", "/about-us/", "/services/roofing/", "/blog/", "/blog/spring-roof-check/"]) {
      assert.ok(sitemap.includes(`<loc>https://fixture-roofing.example.com${p}</loc>`), p);
    }
    assert.ok(sitemap.indexOf("example.com/</loc>") < sitemap.indexOf("/about-us/</loc>"), "home is listed first");
    assert.match(sitemap, /spring-roof-check\/<\/loc>\n    <lastmod>2026-04-02<\/lastmod>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom code renders only when approved, in the head or before </body>", () => {
  const root = tempRepo();
  try {
    writeFileSync(
      join(root, "landing", "src", "content", "custom-code.json"),
      JSON.stringify({
        snippets: [
          { name: "Analytics", placement: "head", html: '<script async src="https://analytics.example.com/a.js"></script>', approvedBy: "owner@example.com", approvedAt: "2026-10-30" },
          { name: "Pixel", placement: "bodyEnd", html: '<noscript><img src="https://px.example.com/p.gif"></noscript>', approvedBy: "owner@example.com", approvedAt: "2026-10-30" },
          { name: "Not approved", placement: "head", html: '<script src="https://unapproved.example.com/x.js"></script>', approvedBy: "", approvedAt: "" },
        ],
      }),
    );
    const dist = build(root);
    assert.deepEqual(checkDist(dist).problems, [], "the pixel's <img> without alt is skipped by the AEO check");
    for (const page of ["index.html", "about/index.html"]) {
      const html = read(dist, page);
      const head = html.slice(0, html.indexOf("</head>"));
      assert.ok(head.includes("https://analytics.example.com/a.js"), page);
      assert.ok(!html.includes("unapproved.example.com"), page);
      assert.ok(html.indexOf("https://px.example.com/p.gif") > html.indexOf("</footer>"), page);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importer helpers: file names, rewrites and form conversion", () => {
  assert.equal(fileNameForPath("/"), "home");
  assert.equal(fileNameForPath("/services/Roofing"), "services--roofing");
  const rw = makeRewriter({
    meta: { origin: "https://www.old.example.com" },
    assets: [{ oldUrl: "https://old.example.com/a.jpg", newUrl: "https://cdn.example.com/a.jpg" }],
  });
  assert.equal(rw.content('<a href="https://old.example.com/x?y=1">x</a>'), '<a href="/x?y=1">x</a>');
  assert.equal(rw.content("https://old.example.com"), "/");
  assert.equal(rw.content('<img src="https://old.example.com/a.jpg">'), '<img src="https://cdn.example.com/a.jpg">');
  assert.equal(rw.content("https://old.example.com.evil.test/x"), "https://old.example.com.evil.test/x");
  assert.equal(rw.structured("https://old.example.com/about", "https://new.example.com"), "https://new.example.com/about");
  const { form, notes } = convertForm({
    name: "Get a Quote!",
    fields: [
      { name: "1st name", label: "First name", type: "text" },
      { name: "upload", label: "Photo", type: "file" },
      { name: "topics", label: "Topics", type: "checkbox", options: ["A", "B"] },
      { name: "rating", label: "Rating", type: "other" },
    ],
  });
  assert.equal(form.name, "get-a-quote");
  assert.equal(form.fields[0].name, "st_name");
  assert.equal(form.fields[1].type, "checkboxes", "file uploads are left out");
  assert.equal(form.fields[2].type, "text");
  assert.ok(notes.some((n) => n.includes("file uploads are not supported")));
  assert.ok(notes.some((n) => n.includes('type "other" is not supported')));
  // Form names stay unique across the site.
  const used = new Set(["contact"]);
  assert.equal(convertForm({ name: "contact", fields: [{ name: "email", label: "Email", type: "email" }] }, used).form.name, "contact-2");
  assert.equal(convertForm({ name: "login", fields: [{ name: "pw", label: "Password", type: "password" }] }).form, null);
});

// ── The current SiteModel (chipp-deno siteModelSchema, 2026-11-02) ──

const WORDPRESS = join(FIXTURES, "site-migration-wordpress");
const MINIMAL = join(FIXTURES, "site-migration-minimal");
const readModel = (dir) => JSON.parse(readFileSync(join(dir, "chipp", "site-migration", "site-model.json"), "utf8"));
const fixtureReader = (dir) => makeContentReader((repoPath) => JSON.parse(readFileSync(join(dir, repoPath), "utf8")));

test("the importer never throws on a sparse or odd model and says what it could not place", () => {
  const models = [
    {},
    { meta: {}, pages: null, forms: null, navigation: null, collections: null, assets: null },
    { meta: { origin: "not a url" }, pages: [{}, { path: 7 }, { path: "/x.html", title: "X" }], collections: { blog: {} } },
    { pages: [{ path: "/a/", title: "A" }], forms: [{ pagePath: "/missing/", name: "f", fields: [{ name: "e", type: "email" }] }], collections: [] },
    { collections: { blog: { indexPath: null, posts: [{ path: "/p/", title: "P", publishedAt: "2026-01-01", contentFile: "../../etc/passwd" }] }, products: { items: [{}], categories: [{}] } } },
  ];
  for (const m of models) {
    const plan = planImport(m, {}, { readContent: makeContentReader(() => { throw new Error("no file"); }) });
    assert.ok(plan.report.counts, JSON.stringify(m));
    assert.ok(formatReport(plan.report).length > 1);
  }
  const odd = planImport(models[2], {});
  assert.ok(odd.report.skipped.some((s) => s.startsWith("page /x.html/") && s.includes("looks like a file")), odd.report.skipped.join("\n"));
  const lost = planImport(models[3], {});
  assert.ok(lost.report.skipped.some((s) => s.includes('form "f"') && s.includes("/missing/")));
  const escape = planImport(models[4], {}, { readContent: makeContentReader(() => ({ items: { "/p/": "<p>x</p>" } })) });
  assert.equal(escape.posts.length, 0, "a content file outside chipp/site-migration/content/ is never read");
  assert.ok(escape.report.skipped.some((s) => s.includes("outside chipp/site-migration/content/")));
  assert.ok(escape.report.skipped.some((s) => s.startsWith("product ")));
});

test("a WordPress + WooCommerce model: pages, posts, forms, products and the summary", () => {
  const model = readModel(WORDPRESS);
  const oldUrls = JSON.parse(readFileSync(join(WORDPRESS, "chipp", "site-migration", "old-urls.json"), "utf8"));
  const plan = planImport(model, { url: "https://jewelry.example.com" }, { readContent: fixtureReader(WORDPRESS), oldUrls });
  const { pages, posts, blog, catalog, blogTerms, nav, report } = plan;

  assert.equal(report.platform.platform, "wordpress");
  assert.equal(report.platform.confidence, "high");
  assert.deepEqual(report.counts, {
    pages: 4, posts: 2, forms: 1, headerLinks: 4, footerLinks: 2, products: 3, productCategories: 2, blogCategories: 2, blogTags: 2,
  });
  assert.deepEqual(pages.map((p) => p.path).sort(), ["/", "/about/", "/contact/", "/faq/"]);

  // SEO: the crawled head first, the API's Yoast SEO for what the crawl lacks.
  const home = pages.find((p) => p.path === "/");
  assert.equal(home.title, "Home");
  assert.equal(home.seo.title, "Fixture Jewelry | Handmade silver and gold jewelry");
  assert.equal(home.seo.description, "Handmade silver and gold rings and necklaces from a two-person studio.");
  assert.equal(home.seo.canonical, "/");
  assert.equal(home.seo.og.title, "Fixture Jewelry");
  assert.match(home.seo.og.image, /^https:\/\/build\.chipp\.ai\//, "og:image is the rehosted copy");
  assert.equal(home.seo.jsonLd[0]["@type"], "JewelryStore");
  assert.equal(home.seo.jsonLd[0].url, "https://jewelry.example.com/", "JSON-LD URLs move to the new site");
  assert.equal(home.seo.jsonLd[0].logo, "https://www.fixture-jewelry.example/wp-content/uploads/logo.png", "a file with no rehosted copy stays absolute");
  assert.equal(home.publishedAt, "2012-05-01");
  assert.equal(home.updatedAt, "2026-10-01");
  assert.equal(home.importedFrom, "https://www.fixture-jewelry.example/");

  // Bodies come from content/*.json, as one richText section under the old H1. No invented words.
  assert.deepEqual(home.sections.map((s) => s.type), ["richText"]);
  assert.equal(home.sections[0].heading, "Handmade jewelry from our studio");
  assert.ok(home.sections[0].html.includes('<a href="/shop/">See the shop</a>'), "old-origin links become site paths");
  const about = pages.find((p) => p.path === "/about/");
  assert.ok(about.sections[0].html.includes(model.assets.map["https://www.fixture-jewelry.example/wp-content/uploads/about.jpg"]), "assets.map rehosts body images");
  const faq = pages.find((p) => p.path === "/faq/");
  assert.equal(faq.sections[0].heading, "Questions and answers");
  assert.equal(faq.seo.title, "FAQ | Fixture Jewelry", "an API-only page keeps its Yoast title");

  // The contact form keeps its name and drops platform plumbing.
  const contact = pages.find((p) => p.path === "/contact/");
  const form = contact.sections.find((s) => s.type === "form").form;
  assert.equal(form.name, "contact");
  assert.equal(form.submitLabel, "Send message");
  assert.deepEqual(form.fields.map((f) => f.name), ["your-name", "your-email", "phone", "topic", "your-message"]);
  assert.deepEqual(form.fields.find((f) => f.name === "topic").options, ["An order", "Ring sizing", "A repair"]);
  assert.ok(report.notes.some((n) => n.includes("now posts to /api/site-forms/contact")));
  assert.ok(report.notes.some((n) => n.includes('"photo": file uploads are not supported')));

  // Posts at their original paths with dates, authors, categories and tags.
  assert.deepEqual(posts.map((p) => p.path).sort(), ["/2026/01/winter-collection/", "/2026/03/caring-for-silver/"]);
  const silver = posts.find((p) => p.path === "/2026/03/caring-for-silver/");
  assert.equal(silver.date, "2026-03-14");
  assert.equal(silver.updatedAt, "2026-03-20");
  assert.equal(silver.author, "Ada Smith");
  assert.deepEqual(silver.categories, ["Jewelry care"]);
  assert.deepEqual(silver.tags, ["Silver", "Cleaning"]);
  assert.equal(silver.seo.title, "Caring for silver | Fixture Jewelry");
  assert.equal(silver.seo.og.type, "article");
  assert.equal(silver.seo.jsonLd[0].image, model.assets.map["https://www.fixture-jewelry.example/wp-content/uploads/silver.jpg"]);
  assert.ok(silver.html.includes('href="/faq/"'));
  assert.deepEqual(blog, { path: "/blog/", title: "Journal | Fixture Jewelry", description: "Notes from the studio: care guides and new collections." });
  assert.deepEqual(blogTerms.categories.map((c) => c.path), ["/category/care/", "/category/news/"]);

  // Products: a data file, not pages.
  assert.equal(catalog.indexPath, "/shop/");
  assert.equal(catalog.currency, "USD");
  const ring = catalog.items.find((p) => p.slug === "silver-band-ring");
  assert.deepEqual(
    { path: ring.path, price: ring.price, regularPrice: ring.regularPrice, salePrice: ring.salePrice, onSale: ring.onSale, inStock: ring.inStock, sku: ring.sku },
    { path: "/product/silver-band-ring/", price: "120.00", regularPrice: "150.00", salePrice: "120.00", onSale: true, inStock: true, sku: "RING-001" },
  );
  assert.deepEqual(ring.attributes, [{ name: "Ring size", values: ["6", "7"] }]);
  assert.equal(ring.variants.length, 2);
  assert.deepEqual(ring.categories, ["rings"]);
  assert.match(ring.html, /recycled sterling silver, brushed by hand/);
  const necklace = catalog.items.find((p) => p.slug === "gold-chain-necklace");
  assert.equal(necklace.inStock, false);
  assert.ok(necklace.html.includes(model.assets.map["https://www.fixture-jewelry.example/wp-content/uploads/necklace.jpg"]));
  assert.equal(catalog.items.find((p) => p.slug === "gift-card").html, null);
  assert.deepEqual(catalog.categories.map((c) => [c.slug, c.path]), [["rings", "/product-category/rings/"], ["necklaces", "/product-category/necklaces/"]]);
  assert.deepEqual(catalogProblems(catalog), [], "the catalog passes the build's own check");

  // Navigation, header and footer.
  assert.deepEqual(nav.header.map((l) => l.href), ["/shop/", "/about/", "/blog/", "/contact/"]);
  assert.equal(nav.footer[1].href, "https://www.instagram.com/fixturejewelry/");

  // Everything skipped says why.
  const skipped = report.skipped.join("\n");
  assert.match(skipped, /page \/shop\/: the shop list/);
  assert.match(skipped, /page \/cart\/: the old WordPress cart/);
  assert.match(skipped, /page \/staff-notes\/: private/);
  assert.match(skipped, /post \/\?p=103 \("Spring sale \(draft\)"\): draft/);
  assert.match(skipped, /post \/2025\/12\/holiday-hours\/: no body HTML/);
  assert.match(skipped, /crawl https:\/\/www\.fixture-jewelry\.example\/product-tag\/silver\/: over_cap/);
  const todo = report.todo.join("\n");
  assert.match(todo, /3 old URL\(s\) in old-urls.json have no page, post or product yet: .*\/lookbook\//);
  assert.match(todo, /products\.json holds 3 product\(s\) and 2 categories/);
  assert.match(todo, /no screenshot: .*\/faq\//);
  assert.ok(report.notes.some((n) => n.includes("1 image(s) were not rehosted")));
  assert.ok(report.notes.some((n) => n.includes("WordPress menus are not public")));
});

test("the WordPress model imports to files and the landing site builds from them", () => {
  const site = JSON.parse(readFileSync(join(LANDING, "src", "content", "site.json"), "utf8"));
  site.name = "Fixture Jewelry";
  site.url = "https://jewelry.example.com";
  site.cta = { label: "Contact us", href: "/contact/" };
  const root = tempRepo({ withFixture: true, fixture: WORDPRESS, siteJson: site });
  try {
    const report = importSiteModel({ repoRoot: root });
    const content = join(root, "landing", "src", "content");
    for (const f of ["pages/home.json", "pages/about.json", "pages/contact.json", "pages/faq.json", "posts/2026--03--caring-for-silver.json", "posts/2026--01--winter-collection.json", "products.json", "blog-terms.json"]) {
      assert.ok(existsSync(join(content, f)), f);
      assert.ok(report.written.includes(f), f);
    }
    assert.ok(report.written.includes("site.json"));
    const again = importSiteModel({ repoRoot: root });
    assert.equal(again.kept.length, 8, "existing files are kept without --force");

    const dist = build(root);
    for (const p of ["index.html", "about/index.html", "contact/index.html", "faq/index.html", "blog/index.html", "2026/03/caring-for-silver/index.html"]) {
      assert.ok(existsSync(join(dist, p)), p);
    }
    const post = read(dist, "2026/03/caring-for-silver/index.html");
    assert.match(post, /Categories: Jewelry care\. Tags: Silver, Cleaning\./);
    assert.match(post, /"articleSection":\["Jewelry care"\]/);
    assert.match(post, /<title>Caring for silver \| Fixture Jewelry<\/title>/);
    const contact = read(dist, "contact/index.html");
    assert.match(contact, /<form [^>]*action="\/api\/site-forms\/contact"/);
    assert.match(contact, /<h1 id="s1-title"[^>]*>Contact<\/h1>/);
    const home = read(dist, "index.html");
    assert.match(home, /<link rel="canonical" href="https:\/\/jewelry.example.com\/">/);
    assert.match(home, /"@type":"JewelryStore"/);

    // What is left is the shop: links to it stay broken until its pages are built from products.json.
    const { problems } = checkDist(dist);
    assert.ok(problems.length > 0);
    for (const p of problems) assert.match(p, /broken internal link: \/shop\//, p);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a product path that is also a page fails the build", () => {
  const root = tempRepo();
  try {
    const content = join(root, "landing", "src", "content");
    mkdirSync(join(content, "pages"), { recursive: true });
    writeFileSync(join(content, "pages", "ring.json"), JSON.stringify({ path: "/ring/", title: "Ring", sections: [{ type: "richText", heading: "Ring", html: "<p>A ring.</p>" }] }));
    writeFileSync(join(content, "products.json"), JSON.stringify({
      indexPath: null, currency: "USD", categories: [],
      items: [{ id: "1", slug: "ring", path: "/ring/", title: "Ring", price: "12", images: [], categories: [], tags: [], html: null }],
    }));
    assert.throws(() => build(root), (err) => /products\.json: path \/ring\/ is also a page or post/.test(String(err.stderr) + String(err.stdout)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(catalogProblems({ indexPath: null, currency: null, categories: [], items: [{ path: "/a/", title: "A", slug: "a", price: "1,00", images: [], categories: [], tags: [] }] }), [
    'src/content/products.json items[0].price: a decimal string ("12.50") or null',
  ]);
});

test("a crawl-only model (no platform API, written before 2026-11-02) imports and reports the rebuild work", () => {
  const model = readModel(MINIMAL);
  assert.equal(model.meta.platformConfidence, undefined);
  const plan = planImport(model, {}, { readContent: fixtureReader(MINIMAL), oldUrls: { paths: ["/", "/book-online", "/members"] } });
  const { report } = plan;
  assert.equal(report.counts.pages, 2);
  assert.equal(report.counts.posts, 0);
  assert.equal(plan.catalog, null);
  assert.equal(plan.blog, null);
  assert.equal(plan.blogTerms, null);
  const home = plan.pages.find((p) => p.path === "/");
  assert.deepEqual(home.sections, [], "section outlines (kind and heading only) are not content");
  assert.equal(home.title, "Yoga in the park");
  assert.equal(home.seo.og.image, "https://cdn.example.com/m/hero.jpg");
  const book = plan.pages.find((p) => p.path === "/book-online/");
  assert.equal(book.seo.noindex, true, "robots noindex is kept");
  assert.deepEqual(book.sections[0].form.fields.map((f) => f.name), ["email"], "password fields are never imported");
  assert.deepEqual(plan.nav, { header: [{ label: "Book", href: "/book-online" }] });
  assert.match(report.todo.join("\n"), /2 page\(s\) have no body: rebuild each from its screenshot.*home-d\.png/);
  assert.match(report.todo.join("\n"), /no page, post or product yet: .*\/members/);
  assert.ok(report.notes.some((n) => n.startsWith("the crawl outlined 2 section(s)")));
  assert.ok(report.skipped.includes("crawl https://studio-fixture.example/members: scrape_failed"));
});
