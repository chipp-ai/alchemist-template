/**
 * Landing campaign variants (dynamic targeting): the matching rules in
 * landing/src/lib/campaigns.ts and the server half in
 * src/lib/landing-site.ts. DB-free: a throwaway landing build and a small
 * Hono app in the same order app.ts uses. The build half (the variant
 * pages themselves) is tested by landing/scripts/campaigns.test.mjs.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { landingSiteMiddleware, readCampaigns, type SignedInCheck } from "@/lib/landing-site.ts";
import {
  attributionOf,
  type Campaign,
  campaignMatches,
  parseCampaign,
  parseCampaigns,
  patternMatches,
  selectCampaign,
} from "../../../landing/src/lib/campaigns.ts";

function campaign(id: string, data: Record<string, unknown>): Campaign {
  const { campaign, problems } = parseCampaign(`src/content/campaigns/${id}.json`, {
    name: id,
    hero: { headline: `Headline for ${id}` },
    ...data,
  });
  assertEquals(problems, []);
  return campaign!;
}

const q = (s: string) => new URLSearchParams(s);

// ── Matching rules ──

Deno.test("a pattern matches case-insensitively, with * as a wildcard", () => {
  assert(patternMatches("dentists-*", "Dentists-Q4"));
  assert(patternMatches("*dentist*", "ai receptionist for dentists"));
  assert(patternMatches("spring sale", "Spring Sale"));
  assertFalse(patternMatches("dentists", "dentists-q4"), "no * means the whole value");
  assertFalse(patternMatches("a.b", "axb"), "regex characters are literal");
});

Deno.test("a campaign matches when any listed value fits any of its patterns", () => {
  const c = campaign("dentists", {
    match: { utm_campaign: ["dentists-*"], utm_term: ["*dental*"] },
  });
  assert(campaignMatches(c, q("utm_campaign=dentists-search")));
  assert(campaignMatches(c, q("utm_term=dental+receptionist")));
  assertFalse(campaignMatches(c, q("utm_campaign=roofers")));
  assertFalse(campaignMatches(c, q("utm_campaign=")));
  assertFalse(campaignMatches(c, q("")));
});

Deno.test("?campaign=<id> wins, then the first match by order then id; other pages never match", () => {
  const list = parseCampaigns([
    {
      file: "src/content/campaigns/b-general.json",
      data: { name: "B", match: { utm_source: ["google"] }, hero: { headline: "B" } },
    },
    {
      file: "src/content/campaigns/a-general.json",
      data: { name: "A", match: { utm_source: ["google"] }, hero: { headline: "A" } },
    },
    {
      file: "src/content/campaigns/z-first.json",
      data: { name: "Z", order: 1, match: { utm_medium: ["cpc"] }, hero: { headline: "Z" } },
    },
    { file: "src/content/campaigns/qr.json", data: { name: "QR", hero: { headline: "QR" } } },
    {
      file: "src/content/campaigns/pricing.json",
      data: {
        name: "P",
        page: "/pricing",
        match: { utm_source: ["google"] },
        hero: { headline: "P" },
      },
    },
  ]);
  assertEquals(list.problems, []);
  const pick = (path: string, s: string) => selectCampaign(list.campaigns, path, q(s))?.id ?? null;
  assertEquals(pick("/", "utm_source=google"), "a-general", "ties go by id");
  assertEquals(pick("/", "utm_source=google&utm_medium=cpc"), "z-first", "lower order first");
  assertEquals(pick("/", "campaign=qr&utm_source=google"), "qr", "?campaign= wins");
  assertEquals(pick("/", "campaign=QR"), "qr");
  assertEquals(
    pick("/", "campaign=pricing"),
    null,
    "a campaign for another page is never served here",
  );
  assertEquals(pick("/", "campaign=nope"), null);
  assertEquals(pick("/pricing/", "utm_source=google"), "pricing");
  assertEquals(
    pick("/pricing", "utm_source=google"),
    "pricing",
    "with or without the trailing slash",
  );
  assertEquals(pick("/", "utm_source=bing"), null);
});

Deno.test("a campaign file is checked: id, name, hero, safe links, real patterns", () => {
  const bad = (file: string, data: unknown) =>
    parseCampaign(`src/content/campaigns/${file}`, data).problems.join("\n");
  assertStringIncludes(
    bad("Bad Name.json", { name: "x", hero: { headline: "h" } }),
    "file name must be lowercase",
  );
  assertStringIncludes(bad("x.json", { hero: { headline: "h" } }), ".name: required");
  assertStringIncludes(bad("x.json", { name: "x" }), ".hero: required");
  assertStringIncludes(bad("x.json", { name: "x", hero: {} }), "change at least one");
  assertStringIncludes(
    bad("x.json", { name: "x", hero: { cta: { label: "Go", href: "javascript:alert(1)" } } }),
    "cta.href",
  );
  assertStringIncludes(
    bad("x.json", { name: "x", hero: { headline: "h" }, match: { utm_term: ["**"] } }),
    'only "*"',
  );
  assertStringIncludes(
    bad("x.json", { name: "x", hero: { headline: "h" }, match: { campaign: ["x"] } }),
    "always selects",
  );
  assertStringIncludes(
    bad("x.json", { name: "x", hero: { subhead: "word ".repeat(61) } }),
    "60 words or less",
  );
  assertEquals(
    bad("x.json", { name: "x", hero: { cta: { label: "Call", href: "tel:+15551234567" } } }),
    "",
  );
});

Deno.test("attribution keeps the UTM values and ad click ids, nothing else", () => {
  assertEquals(
    attributionOf(
      q("utm_source=google&utm_campaign=dentists-q4&gclid=abc&email=a@b.co&campaign=qr"),
    ),
    { utm_source: "google", utm_campaign: "dentists-q4", gclid: "abc", campaign: "qr" },
  );
  assertEquals(attributionOf(q("utm_term=" + "x".repeat(300))).utm_term.length, 200);
  assertEquals(attributionOf(q("")), {});
});

// ── The server answers with the variant ──

const HOME = "<!doctype html><html><body>BASE HOME</body></html>";
const DENTISTS = '<!doctype html><html data-campaign="dentists"><body>DENTISTS HOME</body></html>';
const ROOFING = "<!doctype html><html><body>BASE ROOFING</body></html>";
const STORM = '<!doctype html><html data-campaign="storm"><body>STORM ROOFING</body></html>';

async function write(path: string, text: string) {
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, text);
}

async function fixture(): Promise<{ dist: string; campaignsDir: string }> {
  const root = await Deno.makeTempDir({ prefix: "landing-campaigns-" });
  const dist = `${root}/dist`;
  await write(`${dist}/index.html`, HOME);
  await write(`${dist}/services/roofing/index.html`, ROOFING);
  await write(`${dist}/_campaign/dentists/index.html`, DENTISTS);
  await write(`${dist}/_campaign/storm/index.html`, STORM);
  const campaignsDir = `${root}/campaigns`;
  await write(
    `${campaignsDir}/dentists.json`,
    JSON.stringify({
      name: "Dentists",
      match: { utm_campaign: ["dentists-*"] },
      hero: { headline: "Dentists" },
    }),
  );
  await write(
    `${campaignsDir}/storm.json`,
    JSON.stringify({
      name: "Storm",
      page: "/services/roofing/",
      match: { utm_content: ["*storm*"] },
      hero: { headline: "Storm" },
    }),
  );
  // In the folder but not in the build: never served.
  await write(
    `${campaignsDir}/unbuilt.json`,
    JSON.stringify({ name: "Unbuilt", match: { utm_source: ["x"] }, hero: { headline: "U" } }),
  );
  await write(`${campaignsDir}/broken.json`, "{ not json");
  return { dist, campaignsDir };
}

function app(
  dist: string,
  campaigns: Campaign[],
  signedIn: SignedInCheck = () => Promise.resolve(false),
): Hono {
  const a = new Hono();
  a.get("/api/thing", (c) => c.json({ ok: true }));
  const landing = landingSiteMiddleware(dist, "landing", signedIn, campaigns);
  if (landing) a.use("/*", landing);
  a.get("*", (c) => c.html("SPA SHELL"));
  return a;
}

Deno.test("readCampaigns skips a broken file and reads the rest; a missing folder means none", async () => {
  const { campaignsDir } = await fixture();
  assertEquals(readCampaigns(campaignsDir).map((c) => c.id), ["dentists", "storm", "unbuilt"]);
  assertEquals(readCampaigns(`${campaignsDir}/nope`), []);
});

Deno.test("the base URL of a page that a URL selects a campaign for answers the variant", async () => {
  const { dist, campaignsDir } = await fixture();
  const a = app(dist, readCampaigns(campaignsDir));
  const get = async (url: string) => {
    const res = await a.request(url);
    return {
      status: res.status,
      body: await res.text(),
      campaign: res.headers.get("x-landing-campaign"),
    };
  };

  assertEquals(await get("/?utm_campaign=dentists-search&utm_source=google"), {
    status: 200,
    body: DENTISTS,
    campaign: "dentists",
  });
  assertEquals(await get("/?campaign=dentists"), {
    status: 200,
    body: DENTISTS,
    campaign: "dentists",
  });
  assertEquals(await get("/?utm_campaign=roofers"), { status: 200, body: HOME, campaign: null });
  assertEquals(await get("/"), { status: 200, body: HOME, campaign: null });
  assertEquals((await get("/services/roofing/?utm_content=spring-storm-ad")).body, STORM);
  assertEquals((await get("/services/roofing?utm_content=storm")).campaign, "storm");
  assertEquals(
    (await get("/?utm_content=storm")).body,
    HOME,
    "a campaign only changes its own page",
  );
  assertEquals(
    (await get("/?utm_source=x")).body,
    HOME,
    "a campaign with no built page is not served",
  );
  assertEquals(
    (await get("/_campaign/dentists/")).body,
    DENTISTS,
    "the variant page is readable on its own (Builder preview)",
  );
  assertEquals((await get("/api/thing?campaign=dentists")).body, '{"ok":true}');
});

Deno.test("a HEAD gets the variant too; a POST never does", async () => {
  const { dist, campaignsDir } = await fixture();
  const a = app(dist, readCampaigns(campaignsDir));
  const head = await a.request("/?campaign=dentists", { method: "HEAD" });
  assertEquals(head.headers.get("x-landing-campaign"), "dentists");
  const post = await a.request("/?campaign=dentists", { method: "POST" });
  assertEquals(post.headers.get("x-landing-campaign"), null);
});

Deno.test("a signed-in visitor still goes to the app, campaign URL or not", async () => {
  const { dist, campaignsDir } = await fixture();
  const a = app(dist, readCampaigns(campaignsDir), () => Promise.resolve(true));
  const res = await a.request("/?campaign=dentists");
  assertEquals(res.status, 302);
});

Deno.test("app-first mode serves no campaigns", async () => {
  const { dist, campaignsDir } = await fixture();
  const a = new Hono();
  const landing = landingSiteMiddleware(
    dist,
    "app",
    () => Promise.resolve(false),
    readCampaigns(campaignsDir),
  );
  if (landing) a.use("/*", landing);
  a.get("*", (c) => c.html("SPA SHELL"));
  assertEquals(await (await a.request("/?campaign=dentists")).text(), "SPA SHELL");
});
