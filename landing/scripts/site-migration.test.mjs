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
import { convertForm, fileNameForPath, importSiteModel, makeRewriter } from "./import-site-model.mjs";

const LANDING = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(LANDING, "..");
const FIXTURE = join(REPO, "src", "__tests__", "fixtures", "site-migration");

/** A temp repo with a copy of landing/ (shared node_modules) and web/src/design. */
function tempRepo({ withFixture = false, siteJson } = {}) {
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
  if (withFixture) cpSync(join(FIXTURE, "chipp"), join(root, "chipp"), { recursive: true });
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

test("the fixture SiteModel imports and renders every page, post, form and redirect", () => {
  const site = JSON.parse(readFileSync(join(LANDING, "src", "content", "site.json"), "utf8"));
  site.name = "Fixture Roofing";
  site.url = "https://fixture-roofing.example.com";
  site.cta = { label: "Get an estimate", href: "/about-us/#form-contact-us" };
  const root = tempRepo({ withFixture: true, siteJson: site });
  try {
    const report = importSiteModel({ repoRoot: root });
    assert.ok(report.skippedSections.some((s) => s.includes("carousel")), "unknown sections are reported, not invented");
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
    ],
  });
  assert.equal(form.name, "get-a-quote");
  assert.equal(form.fields[0].name, "st_name");
  assert.equal(form.fields[1].type, "text");
  assert.equal(form.fields[2].type, "checkboxes");
  assert.ok(notes[0].includes('"file" is not supported'));
});
