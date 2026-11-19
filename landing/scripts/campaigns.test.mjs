// Campaign pages (src/lib/campaigns.ts): real builds in temp copies of
// landing/, for the classic home and for a composed page. The matching
// rules are unit-tested in src/__tests__/routes/landing-campaigns.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDist } from "./aeo-check.mjs";
import { build, tempRepo } from "./temp-landing.mjs";

const read = (dist, path) => readFileSync(join(dist, path), "utf8");

function writeJson(root, rel, data) {
  const file = join(root, "landing", "src", "content", rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

const DENTISTS = {
  name: "Dentists, Google Search",
  match: { utm_campaign: ["dentists-*"] },
  title: "The AI receptionist for dental offices",
  hero: {
    headline: "Never miss a patient call again",
    subhead: "Acme answers patient calls, books cleanings and fills cancellations for dental offices.",
    cta: { label: "Start a free trial for your practice", href: "/app/#/signup?from=dentists" },
  },
};

test("a campaign for the classic home builds a noindex variant with its words, and the home page is unchanged", () => {
  const root = tempRepo();
  try {
    writeJson(root, "campaigns/dentists.json", DENTISTS);
    const dist = build(root);
    assert.deepEqual(checkDist(dist).problems, []);
    const variant = read(dist, "_campaign/dentists/index.html");
    assert.match(variant, /<h1 id="hero-title"[^>]*>Never miss a patient call again<\/h1>/);
    assert.match(variant, /Acme answers patient calls, books cleanings/);
    assert.match(variant, /href="\/app\/#\/signup\?from=dentists"[^>]*>Start a free trial for your practice<\/a>/);
    assert.match(variant, /<title>The AI receptionist for dental offices<\/title>/);
    assert.match(variant, /<meta name="robots" content="noindex">/);
    assert.match(variant, /<html lang="en" data-campaign="dentists"/);
    assert.match(variant, /<meta name="landing-campaign" content="dentists">/);

    const home = read(dist, "index.html");
    assert.doesNotMatch(home, /Never miss a patient call again/);
    assert.doesNotMatch(home, /data-campaign/);
    assert.doesNotMatch(home, /noindex/);
    assert.ok(!read(dist, "sitemap.xml").includes("_campaign"), "campaign pages stay out of the sitemap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a campaign for a composed page changes its first hero and links canonical to the base page", () => {
  const site = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "content", "site.json"), "utf8"));
  site.url = "https://acme.example.com";
  const root = tempRepo({ siteJson: site });
  try {
    writeJson(root, "pages/roofing.json", {
      path: "/services/roofing",
      title: "Roof replacement",
      seo: { description: "Full roof replacement." },
      sections: [
        { type: "hero", heading: "Roof replacement", subhead: "We replace roofs in one or two days.", actions: [{ label: "Get a quote", href: "#quote" }, { label: "See our work", href: "#work" }] },
        { type: "faq", heading: "Questions", items: [{ question: "How long does it take?", answer: "One or two days." }] },
      ],
    });
    writeJson(root, "campaigns/storm.json", {
      name: "Storm damage, Meta ads",
      page: "/services/roofing/",
      match: { utm_source: ["facebook"], utm_content: ["*storm*"] },
      hero: { headline: "Storm damage? We fix roofs this week", cta: { label: "Book a free inspection", href: "#quote" } },
    });
    const dist = build(root);
    assert.deepEqual(checkDist(dist).problems, []);
    const variant = read(dist, "_campaign/storm/index.html");
    assert.match(variant, /<h1[^>]*>Storm damage\? We fix roofs this week<\/h1>/);
    assert.match(variant, /We replace roofs in one or two days\./, "the subhead it does not change stays");
    assert.match(variant, />Book a free inspection<\/a>/);
    assert.match(variant, />See our work<\/a>/, "only the first action changes");
    assert.match(variant, /<link rel="canonical" href="https:\/\/acme\.example\.com\/services\/roofing\/">/);
    assert.match(variant, /<meta name="robots" content="noindex">/);
    assert.match(read(dist, "services/roofing/index.html"), /<h1[^>]*>Roof replacement<\/h1>/);
    assert.ok(existsSync(join(dist, "index.html")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bad campaign fails the build with every problem named", () => {
  const root = tempRepo();
  try {
    writeJson(root, "campaigns/Bad_Name.json", { hero: {} });
    writeJson(root, "campaigns/nowhere.json", {
      name: "Nowhere",
      page: "/no-such-page/",
      match: { utm_term: ["*"] },
      hero: { headline: "Hi", cta: { label: "Go", href: "javascript:alert(1)" } },
    });
    assert.throws(() => build(root), (err) => {
      const out = String(err.stderr) + String(err.stdout);
      assert.match(out, /Bad_Name\.json: the file name must be lowercase/);
      assert.match(out, /Bad_Name\.json\.name: required/);
      assert.match(out, /nowhere\.json\.match\.utm_term: a pattern of only "\*"/);
      assert.match(out, /nowhere\.json\.hero\.cta\.href/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a campaign for a page that does not exist fails the build", () => {
  const root = tempRepo();
  try {
    writeJson(root, "campaigns/nowhere.json", { name: "Nowhere", page: "/no-such-page/", hero: { headline: "Hi" } });
    assert.throws(() => build(root), (err) => /nowhere\.json\.page: \/no-such-page\/ is not a page a campaign can change/.test(String(err.stderr) + String(err.stdout)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
