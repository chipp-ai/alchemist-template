// What AI agents read about the product (src/lib/agent-facts.ts): the
// category sentence, JSON-LD facts, llms.txt, robots.txt, the sitemap, the
// agent onboarding section and /.well-known/api-catalog. Unit tests for the
// pure helpers, then real builds with a full and an empty site.json.
// Run with: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDist, checkLlms, jsonLdNodes } from "./aeo-check.mjs";
import { build, LANDING, tempRepo } from "./temp-landing.mjs";
import {
  agentSetup,
  apiCatalog,
  categoryStatement,
  llmsTxt,
  offersLd,
  parsePrice,
  useCasesIntro,
} from "../src/lib/agent-facts.ts";

const TEMPLATE = JSON.parse(readFileSync(join(LANDING, "src", "content", "site.json"), "utf8"));

/** A filled-in site.json: every agent-facing field set. */
function fullSite() {
  return {
    ...TEMPLATE,
    name: "Railyard",
    url: "https://railyard.example.com",
    description: "Railyard is a shipment board that shows every container from port to door.",
    starter: false,
    category: { name: "shipment tracking board", audience: "freight brokers" },
    pricing: {
      question: "How much does Railyard cost?",
      answer: "Railyard has a free plan and a paid plan per team.",
      currency: "USD",
      plans: [
        { name: "Free", price: "Free", period: "", description: "One user, ten shipments.", features: ["Ten shipments"] },
        { name: "Team", price: "$49", period: "per month", description: "Unlimited shipments.", features: ["Unlimited"] },
        { name: "Enterprise", price: "Contact us", period: "", description: "Custom terms.", features: [] },
      ],
    },
    useCases: [
      { title: "Tracking rail legs", body: "See where each container is on the rail leg and when it lands." },
      { title: "Answering customer calls", body: "Find a shipment by container number in one search." },
    ],
    alternatives: [
      {
        name: "Spreadsheets",
        summary: "A spreadsheet is free and flexible, but nobody updates it when a train is late.",
        chooseUs: "you track more than twenty containers a week.",
        chooseThem: "you track a few containers a month.",
      },
    ],
    agents: { mcp: { url: "/api/mcp", name: "railyard" }, openapi: "/openapi.json", docs: null, setupPrompt: null },
    sameAs: ["https://github.com/railyard", "http://insecure.example.com", "not a url"],
  };
}

/** The template's site.json with every agent-facing field removed. */
function emptySite() {
  const site = { ...TEMPLATE };
  for (const key of ["category", "useCases", "alternatives", "agents", "sameAs"]) delete site[key];
  return site;
}

// ── Pure helpers ──

test("the category sentence reads '<name> is the <category> for <audience>.'", () => {
  assert.equal(categoryStatement(fullSite()), "Railyard is the shipment tracking board for freight brokers.");
  assert.equal(
    categoryStatement({ name: "Acme", category: { name: "an inbox for invoices", audience: "small shops." } }),
    "Acme is an inbox for invoices for small shops.",
  );
  assert.equal(categoryStatement({ name: "Acme", category: { name: "CRM", audience: "" } }), "");
  assert.equal(categoryStatement({ name: "Acme" }), "");
});

test("prices become Offer fields only when they are readable", () => {
  assert.deepEqual(parsePrice("$49"), { price: "49", priceCurrency: "USD" });
  assert.deepEqual(parsePrice("€1,200.50 per year"), { price: "1200.50", priceCurrency: "EUR" });
  assert.deepEqual(parsePrice("30 GBP"), { price: "30", priceCurrency: "GBP" });
  assert.deepEqual(parsePrice("12", "cad"), { price: "12", priceCurrency: "CAD" });
  assert.deepEqual(parsePrice("Free"), { price: "0" });
  assert.equal(parsePrice("Contact us"), null);
  assert.equal(parsePrice(""), null);

  const offers = offersLd(fullSite(), "https://railyard.example.com/pricing/");
  assert.deepEqual(offers.map((o) => o.name), ["Free", "Team"], "the Contact us plan has no Offer");
  assert.deepEqual(offers[1], {
    "@type": "Offer",
    name: "Team",
    price: "49",
    priceCurrency: "USD",
    description: "Unlimited shipments.",
    url: "https://railyard.example.com/pricing/",
  });
  // A number with no symbol and no pricing.currency is not a price an agent can quote.
  assert.deepEqual(offersLd({ pricing: { plans: [{ name: "X", price: "49", description: "" }] } }, ""), []);
});

test("the use case intro names the use cases", () => {
  assert.equal(useCasesIntro(fullSite()), "Freight brokers use Railyard for tracking rail legs and answering customer calls.");
  assert.equal(useCasesIntro(emptySite()), "");
});

test("agent setup builds install snippets from absolute URLs, or is null without agents", () => {
  const s = agentSetup(fullSite());
  assert.equal(s.mcpUrl, "https://railyard.example.com/api/mcp");
  assert.equal(s.claudeCode, "claude mcp add --transport http railyard https://railyard.example.com/api/mcp");
  assert.deepEqual(JSON.parse(s.mcpJson), { mcpServers: { railyard: { url: "https://railyard.example.com/api/mcp" } } });
  assert.match(s.prompt, /Railyard is the shipment tracking board for freight brokers\./);
  assert.match(s.prompt, /https:\/\/railyard\.example\.com\/openapi\.json/);
  assert.match(s.prompt, /https:\/\/railyard\.example\.com\/llms\.txt/);
  const own = agentSetup({ ...fullSite(), agents: { ...fullSite().agents, setupPrompt: "Use Railyard." } });
  assert.equal(own.prompt, "Use Railyard.");
  assert.equal(agentSetup(emptySite()), null);
  assert.equal(agentSetup({ ...emptySite(), agents: { mcp: null, openapi: "", docs: "  " } }), null);
});

test("the API catalog is an RFC 9727 linkset, or null without agents", () => {
  const catalog = apiCatalog(fullSite());
  assert.equal(catalog.linkset.length, 1);
  const [entry] = catalog.linkset;
  assert.equal(entry.anchor, "https://railyard.example.com/api/mcp");
  assert.deepEqual(entry["service-desc"], [{ href: "https://railyard.example.com/openapi.json", type: "application/vnd.oai.openapi+json" }]);
  assert.equal(entry["service-meta"][0].href, "https://railyard.example.com/llms.txt");
  assert.equal(apiCatalog(emptySite()), null);
});

test("llms.txt has an H1, a summary and links; empty sections are left out", () => {
  const pages = [{ path: "/", label: "Home", description: "The board." }, { path: "/pricing/", label: "Pricing" }];
  const short = llmsTxt(fullSite(), pages);
  assert.deepEqual(checkLlms(short), []);
  assert.ok(short.startsWith("# Railyard\n\n> Railyard is the shipment tracking board for freight brokers. Railyard is a shipment board"));
  assert.match(short, /^- \[Home\]\(https:\/\/railyard\.example\.com\/\): The board\.$/m);
  assert.match(short, /^- Team: \$49 per month\. Unlimited shipments\.$/m);
  assert.match(short, /^## Use with AI agents$/m);
  assert.match(short, /claude mcp add --transport http railyard/);
  assert.match(short, /\[Full text for AI assistants\]\(https:\/\/railyard\.example\.com\/llms-full\.txt\)/);
  assert.doesNotMatch(short, /## Questions and answers/);

  const full = llmsTxt(fullSite(), pages, { full: true, faq: [{ question: "Is it free?", answer: "Yes, for one user." }] });
  assert.match(full, /^## Use cases$/m);
  assert.match(full, /^### Railyard or Spreadsheets\?$/m);
  assert.match(full, /^Pick Spreadsheets when you track a few containers a month\.$/m);
  assert.match(full, /^### Is it free\?\n\nYes, for one user\.$/m);
  assert.match(full, /^## Setup prompt for an AI agent$/m);

  const bare = llmsTxt({ ...emptySite(), pricing: { question: "", answer: "", plans: [] } }, []);
  for (const heading of ["## Pages", "## Pricing", "## Use with AI agents"]) assert.ok(!bare.includes(heading), heading);
  assert.deepEqual(checkLlms(bare), []);
  assert.ok(checkLlms("no heading here\n").length > 0);
});

// ── Real builds ──

const read = (dist, path) => readFileSync(join(dist, path), "utf8");

test("a full site.json renders the category sentence, sections, JSON-LD, llms.txt, robots, sitemap and the API catalog", () => {
  const root = tempRepo({ siteJson: fullSite() });
  try {
    // The project serves its OpenAPI document from the landing site.
    mkdirSync(join(root, "landing", "public"), { recursive: true });
    writeFileSync(join(root, "landing", "public", "openapi.json"), '{"openapi":"3.1.0"}');
    const dist = build(root);
    assert.deepEqual(checkDist(dist).problems, []);

    // Server-rendered: the facts are in the HTML, no JavaScript needed.
    const home = read(dist, "index.html");
    assert.match(
      home,
      /<\/h1>\s*<p class="category-line"[^>]*>Railyard is the shipment tracking board for freight brokers\.<\/p>/,
      "the category sentence sits right under the H1",
    );
    for (const text of [
      "What can you use Railyard for?",
      "Freight brokers use Railyard for tracking rail legs and answering customer calls.",
      "How does Railyard compare?",
      "Railyard or Spreadsheets?",
      "Use Railyard with your AI agent",
      "claude mcp add --transport http railyard https://railyard.example.com/api/mcp",
      TEMPLATE.itDependsAnswer,
    ]) {
      assert.ok(home.includes(text) || home.includes(text.replace(/'/g, "&#39;")), text);
    }
    assert.match(home, /<link rel="canonical" href="https:\/\/railyard\.example\.com\/"/);
    assert.match(home, /<meta property="og:title" content="Railyard: /);
    assert.match(home, /<link rel="alternate" type="text\/plain" href="\/llms\.txt"/);
    assert.match(home, /<link rel="api-catalog" href="\/\.well-known\/api-catalog"/);
    assert.match(home, /<link rel="service-desc" [^>]*href="https:\/\/railyard\.example\.com\/openapi\.json"/);

    // JSON-LD: SoftwareApplication with category, audience, features, offers; Organization with https sameAs; FAQPage.
    const errors = [];
    const nodes = jsonLdNodes(home, errors);
    assert.deepEqual(errors, []);
    const app = nodes.find((n) => n["@type"] === "SoftwareApplication");
    assert.equal(app.name, "Railyard");
    assert.equal(app.url, "https://railyard.example.com");
    assert.equal(app.applicationSubCategory, "shipment tracking board");
    assert.deepEqual(app.audience, { "@type": "Audience", audienceType: "freight brokers" });
    assert.equal(app.disambiguatingDescription, "Railyard is the shipment tracking board for freight brokers.");
    assert.deepEqual(app.featureList, TEMPLATE.features.map((f) => f.title));
    assert.deepEqual(app.offers.map((o) => [o.name, o.price, o.priceCurrency]), [["Free", "0", "USD"], ["Team", "49", "USD"]]);
    const org = nodes.find((n) => n["@type"] === "Organization");
    assert.deepEqual(org.sameAs, ["https://github.com/railyard"]);
    const faq = nodes.find((n) => n["@type"] === "FAQPage");
    assert.ok(faq.mainEntity.length >= 1);
    for (const q of faq.mainEntity) assert.ok(home.includes(q.name.replace(/'/g, "&#39;")) || home.includes(q.name), q.name);

    // llms.txt and llms-full.txt are generated from the same site.json.
    const llms = read(dist, "llms.txt");
    assert.ok(llms.startsWith("# Railyard\n\n> Railyard is the shipment tracking board for freight brokers."));
    assert.match(llms, /^- \[Pricing\]\(https:\/\/railyard\.example\.com\/pricing\/\): Railyard has a free plan/m);
    assert.match(llms, /^- \[OpenAPI spec\]\(https:\/\/railyard\.example\.com\/openapi\.json\)$/m);
    const llmsFull = read(dist, "llms-full.txt");
    assert.match(llmsFull, /^## Questions and answers$/m);
    assert.ok(llmsFull.includes(`### ${TEMPLATE.mainQuestion}\n\n${TEMPLATE.itDependsAnswer}`), "the home FAQ, main question first");

    // robots.txt: AI crawlers in, private paths out, a sitemap line.
    const robots = read(dist, "robots.txt");
    for (const agent of ["GPTBot", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended", "OAI-SearchBot"]) {
      const group = robots.split(/\n\s*\n/).find((g) => new RegExp(`^User-agent: ${agent}$`, "m").test(g));
      assert.ok(group, agent);
      assert.match(group, /^Allow: \/$/m, agent);
      assert.match(group, /^Disallow: \/app\/$/m, agent);
      assert.match(group, /^Disallow: \/api\/$/m, agent);
    }
    assert.match(robots, /^Sitemap: https:\/\/railyard\.example\.com\/sitemap\.xml$/m);

    // sitemap.xml lists every public page with an absolute URL.
    const sitemap = read(dist, "sitemap.xml");
    for (const p of ["/", "/pricing/", "/about/"]) assert.ok(sitemap.includes(`<loc>https://railyard.example.com${p}</loc>`), p);

    // /.well-known/api-catalog is built and parses.
    const catalog = JSON.parse(read(dist, ".well-known/api-catalog"));
    assert.equal(catalog.linkset[0]["service-desc"][0].href, "https://railyard.example.com/openapi.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty config omits every agent-facing sentence, section and file cleanly", () => {
  const root = tempRepo({ siteJson: emptySite() });
  try {
    const dist = build(root);
    assert.deepEqual(checkDist(dist).problems, []);
    const home = read(dist, "index.html");
    for (const absent of ["category-line", "use-cases", 'id="compare"', "ai-agents", "data-copy", "api-catalog", "service-desc"]) {
      assert.ok(!home.includes(absent), absent);
    }
    const nodes = jsonLdNodes(home, []);
    const app = nodes.find((n) => n["@type"] === "SoftwareApplication");
    for (const key of ["offers", "applicationSubCategory", "audience", "disambiguatingDescription"]) assert.ok(!(key in app), key);
    assert.ok(!("sameAs" in nodes.find((n) => n["@type"] === "Organization")));
    assert.ok(!existsSync(join(dist, ".well-known")), "no API catalog without agents");
    const llms = read(dist, "llms.txt");
    assert.deepEqual(checkLlms(llms), []);
    assert.ok(!llms.includes("## Use with AI agents"));
    // No url: no Sitemap line and no sitemap entries (both need absolute URLs).
    assert.ok(!read(dist, "robots.txt").includes("Sitemap:"));
    assert.ok(!read(dist, "sitemap.xml").includes("<url>"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Builder-written public/llms.txt wins; llms-full.txt is still generated", () => {
  const root = tempRepo({ siteJson: fullSite() });
  try {
    mkdirSync(join(root, "landing", "public"), { recursive: true });
    writeFileSync(join(root, "landing", "public", "openapi.json"), "{}");
    writeFileSync(join(root, "landing", "public", "llms.txt"), "# Railyard\n\n> Written in the Builder.\n");
    const dist = build(root);
    assert.equal(read(dist, "llms.txt"), "# Railyard\n\n> Written in the Builder.\n");
    assert.match(read(dist, "llms-full.txt"), /^## Questions and answers$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
