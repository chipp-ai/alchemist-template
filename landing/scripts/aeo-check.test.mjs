// Tests for scripts/aeo-check.mjs. Run with: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPage, checkPageDetailed, checkRobots, checkSitemap, makeResolver, withoutCustomCode } from "./aeo-check.mjs";

const LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebPage", datePublished: "2026-10-19", dateModified: "2026-10-20" },
    {
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: "Is it free?", acceptedAnswer: { "@type": "Answer", text: "Yes, for one user." } }],
    },
  ],
});

function page({ h2 = "Is Acme right for my team?", answer = "It depends on how often your team does the job.", extra = "", ld = LD } = {}) {
  return `<!doctype html><html><head><script type="application/ld+json">${ld}</script></head><body>
<header><a href="/">Acme</a><nav aria-label="Main"><ul><li><a href="/pricing/">Pricing</a></li><li><a href="/app/">Open the app</a></li></ul></nav></header>
<main><h1>Acme</h1><p>Acme is a web app that helps a team track work orders from request to sign-off in one shared place.</p>
<h2>${h2}</h2><p>${answer}</p>
<h2>FAQ</h2><h3>Is it free?</h3><p>Yes, for one user.</p>
<p>Facts as of October 2026.</p>${extra}
<p>Published <time datetime="2026-10-19">October 19, 2026</time>. Updated <time datetime="2026-10-20">October 20, 2026</time>.</p></main>
<footer><p>Acme</p></footer></body></html>`;
}

const ok = (path) => path === "/" || path === "/pricing/";

test("a good page passes", () => {
  assert.deepEqual(checkPage(page(), { resolves: ok }), []);
});

test("a page needs at least one question heading", () => {
  const html = page({ h2: "Why Acme" }).replace("<h3>Is it free?</h3>", "<h3>Pricing</h3>");
  const errors = checkPage(html, { resolves: ok });
  assert.ok(errors.some((e) => e.includes("no question heading")), errors.join("\n"));
});

test("the first H2 does not have to be the question (a styled FAQ further down counts)", () => {
  assert.deepEqual(checkPage(page({ h2: "What you can do with Acme" }), { resolves: ok }), []);
});

test("every question is answered in 100 words or less", () => {
  const errors = checkPage(page({ answer: "word ".repeat(101) }), { resolves: ok });
  assert.ok(errors.some((e) => e.includes("101 words")), errors.join("\n"));
});

test("a plain definition paragraph sits right under the H1", () => {
  const none = page().replace(/<h1>Acme<\/h1><p>[^<]*<\/p>/, "<h1>Acme</h1>");
  assert.ok(checkPage(none, { resolves: ok }).some((e) => e.includes("no paragraph under the <h1>")));
  const long = page().replace(/<h1>Acme<\/h1><p>[^<]*<\/p>/, "<h1>Acme</h1><p>" + "word ".repeat(61) + "</p>");
  assert.ok(checkPage(long, { resolves: ok }).some((e) => e.includes("61 words")));
});

test("an icon-only button needs an aria-label", () => {
  const bad = checkPage(page({ extra: '<button type="button"><svg aria-hidden="true"></svg></button>' }), { resolves: ok });
  assert.ok(bad.some((e) => e.includes("aria-label")), bad.join("\n"));
  const good = checkPage(page({ extra: '<button type="button" aria-label="Open menu"><svg></svg></button>' }), { resolves: ok });
  assert.deepEqual(good, []);
});

test("an img needs alt text", () => {
  const errors = checkPage(page({ extra: '<img src="https://cdn.example.com/x.png">' }), { resolves: ok });
  assert.ok(errors.some((e) => e.includes("without alt")), errors.join("\n"));
});

test("an input needs a label", () => {
  const bad = checkPage(page({ extra: '<input type="email" name="email">' }), { resolves: ok });
  assert.ok(bad.some((e) => e.includes("without a <label>")), bad.join("\n"));
  const good = checkPage(page({ extra: '<label for="e">Email</label><input id="e" type="email">' }), { resolves: ok });
  assert.deepEqual(good, []);
  const wrapped = checkPage(page({ extra: '<label>Email <input type="email"></label>' }), { resolves: ok });
  assert.deepEqual(wrapped, []);
});

test("a div or span must not act as a button", () => {
  const a = checkPage(page({ extra: '<div onclick="go()">Go</div>' }), { resolves: ok });
  const b = checkPage(page({ extra: '<span role="button">Go</span>' }), { resolves: ok });
  assert.ok(a.some((e) => e.includes("used as a button")));
  assert.ok(b.some((e) => e.includes("used as a button")));
});

test("a broken internal link fails, app paths are skipped", () => {
  const errors = checkPage(page({ extra: '<a href="/nope/">Nope</a>' }), { resolves: ok });
  assert.ok(errors.some((e) => e.includes("broken internal link: /nope/")), errors.join("\n"));
});

test("visible and JSON-LD dates are required and must agree", () => {
  const noDates = page().replace(/<p>Published[\s\S]*?<\/p>/, "");
  assert.ok(checkPage(noDates, { resolves: ok }).some((e) => e.includes("Published")));
  const ld = LD.replace("2026-10-20", "2026-10-21");
  assert.ok(checkPage(page({ ld }), { resolves: ok }).some((e) => e.includes("dateModified")));
});

test("FAQ JSON-LD must match the visible text", () => {
  const ld = LD.replace("Yes, for one user.", "Yes, for up to three users.");
  const errors = checkPage(page({ ld }), { resolves: ok });
  assert.ok(errors.some((e) => e.includes("FAQ JSON-LD answer")), errors.join("\n"));
});

test("robots.txt must allow meta-webindexer and the AI search crawlers", () => {
  const allow = (a) => `User-agent: ${a}\nAllow: /`;
  const good = ["meta-webindexer", "GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot"].map(allow).join("\n\n");
  assert.deepEqual(checkRobots(good), []);
  const bad = good.replace("User-agent: meta-webindexer\nAllow: /", "User-agent: meta-webindexer\nDisallow: /");
  assert.ok(checkRobots(bad).some((e) => e.includes("meta-webindexer")));
});

test("sitemap entries need an absolute loc and a lastmod", () => {
  assert.deepEqual(checkSitemap("<urlset><url><loc>https://a.example/</loc><lastmod>2026-10-19</lastmod></url></urlset>"), []);
  assert.equal(checkSitemap("<urlset><url><loc>/</loc></url></urlset>").length, 2);
});

test("a relaxed page (imported words) reports content-shape rules as warnings", () => {
  const ld = JSON.stringify({ "@graph": [{ "@type": "WebPage", datePublished: "2026-10-19", dateModified: "2026-10-20" }] });
  const html = page({ h2: "Why Acme", ld })
    .replace("<h3>Is it free?</h3>", "<h3>Pricing</h3>")
    .replace("<main>", '<main data-aeo="relaxed">');
  const result = checkPageDetailed(html, { resolves: ok });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((w) => w.includes("no question heading")), result.warnings.join("\n"));
  // Structural rules still fail on a relaxed page.
  const broken = checkPageDetailed(html.replace("</main>", '<img src="/x.png"></main>'), { resolves: ok });
  assert.ok(broken.errors.some((e) => e.includes("without alt")));
});

test("approved custom code is skipped", () => {
  const pixel = '<!--custom-code-->\n<noscript><img src="https://px.example.com/p.gif"></noscript>\n<!--/custom-code-->';
  assert.deepEqual(checkPage(page({ extra: pixel }), { resolves: ok }), []);
  assert.equal(withoutCustomCode(`a${pixel}b`), "ab");
});

test("a link to a redirected path resolves when the redirect's target does", () => {
  const dist = mkdtempSync(join(tmpdir(), "aeo-dist-"));
  try {
    mkdirSync(join(dist, "new"), { recursive: true });
    writeFileSync(join(dist, "new", "index.html"), "<html></html>");
    const resolves = makeResolver(dist, new Map([["/old", "/new/"], ["/gone", "/missing/"], ["/shop", "https://shop.example.com/"]]));
    assert.equal(resolves("/old/"), true);
    assert.equal(resolves("/old"), true);
    assert.equal(resolves("/shop"), true);
    assert.equal(resolves("/gone"), false);
    assert.equal(resolves("/nope"), false);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
