/**
 * chipp/redirects.json on the server (src/lib/site-redirects.ts): served
 * after the app routes and the landing site and before the SPA fallback,
 * validated with the same rules as the landing build (no loops, "from"
 * starts with "/", status 301 or 302).
 */
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { loadSiteRedirects, siteRedirectsMiddleware } from "@/lib/site-redirects.ts";
import { landingSiteMiddleware } from "@/lib/landing-site.ts";
import { validateRedirects } from "../../../landing/src/lib/redirects.ts";

const RULES = [
  { from: "/old-about", to: "/about/", status: 301 as const },
  { from: "/promo/", to: "/pricing/?ref=promo", status: 302 as const },
  { from: "/shop", to: "https://shop.example.com/", status: 301 as const },
  { from: "/about", to: "/never/", status: 301 as const },
];

/** The same order app.ts uses: API, landing site, redirects, SPA fallback. */
async function buildApp(): Promise<{ app: Hono; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "redirect-landing-" });
  await Deno.writeTextFile(`${dir}/index.html`, "<h1>home</h1>");
  await Deno.mkdir(`${dir}/about`);
  await Deno.writeTextFile(`${dir}/about/index.html`, "<h1>about</h1>");
  const app = new Hono();
  app.get("/api/x", (c) => c.json({ ok: true }));
  app.post("/old-about", (c) => c.text("posted"));
  const landing = landingSiteMiddleware(dir, "landing");
  if (landing) app.use("/*", landing);
  const redirects = siteRedirectsMiddleware(RULES);
  if (redirects) app.use("/*", redirects);
  app.use("/*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    c.header("X-Spa-Fallback", "1");
    return c.html("<div id=app></div>");
  });
  return { app, dir };
}

Deno.test("redirects: 301 and 302 with or without the trailing slash; the query string is kept", async () => {
  const { app, dir } = await buildApp();
  try {
    const a = await app.request("/old-about");
    assertEquals(a.status, 301);
    assertEquals(a.headers.get("location"), "/about/");
    const b = await app.request("/old-about/?utm_source=mail");
    assertEquals(b.status, 301);
    assertEquals(b.headers.get("location"), "/about/?utm_source=mail");
    const c = await app.request("/promo?x=1");
    assertEquals(c.status, 302);
    assertEquals(c.headers.get("location"), "/pricing/?ref=promo");
    const d = await app.request("/shop");
    assertEquals(d.headers.get("location"), "https://shop.example.com/");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("redirects: a real page wins, app routes and non-GET are untouched, unknown paths reach the SPA", async () => {
  const { app, dir } = await buildApp();
  try {
    const page = await app.request("/about/");
    assertEquals(page.status, 200, "the landing page at /about wins over its redirect");
    assert((await page.text()).includes("about"));
    assertEquals((await app.request("/api/x")).status, 200);
    const post = await app.request("/old-about", { method: "POST" });
    assertEquals(await post.text(), "posted");
    const unknown = await app.request("/nothing-here");
    assertEquals(unknown.status, 200);
    assertEquals(unknown.headers.get("x-spa-fallback"), "1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("redirects: no rules mounts nothing; a missing, broken or looping file serves no redirects", async () => {
  assertEquals(siteRedirectsMiddleware([]), null);
  assertEquals(loadSiteRedirects("/nonexistent/redirects.json"), []);
  const file = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(file, "{ not json");
    assertEquals(loadSiteRedirects(file), []);
    await Deno.writeTextFile(
      file,
      JSON.stringify({ redirects: [{ from: "/a", to: "/b", status: 301 }, { from: "/b", to: "/a", status: 301 }] }),
    );
    assertEquals(loadSiteRedirects(file), []);
    await Deno.writeTextFile(file, JSON.stringify({ redirects: [{ from: "/a", to: "/b", status: 301 }] }));
    assertEquals(loadSiteRedirects(file).length, 1);
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("redirects: validation finds loops and bad rules", () => {
  assertEquals(
    validateRedirects({ redirects: [{ from: "/a", to: "/b", status: 301 }, { from: "/b/", to: "/a", status: 302 }] }),
    ["redirect loop: /a -> /b -> /a"],
  );
  const bad = validateRedirects({ redirects: [{ from: "old", to: "/x", status: 307 }] });
  assert(bad.some((p) => p.includes('"from" must be a site path')));
  assert(bad.some((p) => p.includes('"status" must be 301 or 302')));
});

Deno.test("redirects: this repo's chipp/redirects.json and the fixture's are valid", async () => {
  for (const file of ["chipp/redirects.json", "src/__tests__/fixtures/site-migration/chipp/redirects.json"]) {
    const url = new URL(`../../../${file}`, import.meta.url);
    let text: string;
    try {
      text = await Deno.readTextFile(url);
    } catch {
      continue; // a project without redirects
    }
    assertEquals(validateRedirects(JSON.parse(text)), [], file);
  }
});

Deno.test("app.ts mounts redirects after the landing site and before the SPA fallback", async () => {
  const src = await Deno.readTextFile(new URL("../../../app.ts", import.meta.url));
  const landing = src.indexOf("landingSiteMiddleware()");
  const redirects = src.indexOf("siteRedirectsMiddleware()");
  const spaFallback = src.indexOf('app.use("/*", serveStatic({ root: "./web/dist" }))');
  assert(landing > 0 && redirects > 0 && spaFallback > 0, "anchors present");
  assert(landing < redirects && redirects < spaFallback);
});
