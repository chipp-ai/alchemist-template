/**
 * The landing site (src/lib/landing-site.ts) and the SPA prefix in app.ts.
 * DB-free: builds a small Hono app the same way app.ts does, against a
 * throwaway landing build, so it never depends on `npm run build`.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { isLandingPath, landingSiteBuilt, landingSiteMiddleware } from "@/lib/landing-site.ts";
import { APP_BASE_PATH } from "@/config/site.ts";

const LANDING_HTML = "<!doctype html><html><body>LANDING HOME</body></html>";
const PRICING_HTML = "<!doctype html><html><body>LANDING PRICING</body></html>";
const SPA_HTML = "SPA SHELL";

async function landingBuild(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "landing-dist-" });
  await Deno.writeTextFile(`${dir}/index.html`, LANDING_HTML);
  await Deno.mkdir(`${dir}/pricing`);
  await Deno.writeTextFile(`${dir}/pricing/index.html`, PRICING_HTML);
  await Deno.writeTextFile(`${dir}/robots.txt`, "User-agent: *\nAllow: /\n");
  return dir;
}

/** The same order app.ts uses: API, SPA prefix, landing site, SPA fallback. */
function buildApp(landingDir: string): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/thing", (c) => c.json({ ok: true }));
  app.get(APP_BASE_PATH, (c) => c.html(SPA_HTML));
  app.get(`${APP_BASE_PATH}/*`, (c) => c.html(SPA_HTML));
  const landing = landingSiteMiddleware(landingDir);
  if (landing) app.use("/*", landing);
  app.use("/*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return await next();
    return c.html(SPA_HTML);
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}

Deno.test("the SPA lives at /app", () => {
  assertEquals(APP_BASE_PATH, "/app");
});

Deno.test("isLandingPath skips the API, /index.html and the SPA prefix", () => {
  assert(isLandingPath("/"));
  assert(isLandingPath("/pricing/"));
  assert(isLandingPath("/robots.txt"));
  assertFalse(isLandingPath("/api/thing"));
  assertFalse(isLandingPath("/index.html"));
  assertFalse(isLandingPath("/app"));
  assertFalse(isLandingPath("/app/"));
  assertFalse(isLandingPath("/app/settings"));
  // A path that only starts with the same letters is not the SPA prefix.
  assert(isLandingPath("/apples"));
});

Deno.test("with a landing build: / and marketing pages are landing, /app is the SPA, /api and /health unchanged", async () => {
  const dir = await landingBuild();
  try {
    assert(landingSiteBuilt(dir));
    const app = buildApp(dir);
    assertStringIncludes(await (await app.request("/")).text(), "LANDING HOME");
    assertStringIncludes(await (await app.request("/pricing/")).text(), "LANDING PRICING");
    assertStringIncludes(await (await app.request("/pricing")).text(), "LANDING PRICING");
    assertStringIncludes(await (await app.request("/robots.txt")).text(), "User-agent");
    assertEquals(await (await app.request("/app/")).text(), SPA_HTML);
    assertEquals(await (await app.request("/app")).text(), SPA_HTML);
    // Unknown paths still fall through to the SPA, as before.
    assertEquals(await (await app.request("/settings/billing")).text(), SPA_HTML);
    assertEquals((await app.request("/health")).status, 200);
    assertEquals((await (await app.request("/api/thing")).json()).ok, true);
    assertEquals((await app.request("/api/missing")).status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("without a landing build: / falls back to the SPA", async () => {
  const dir = await Deno.makeTempDir({ prefix: "landing-missing-" });
  try {
    assertFalse(landingSiteBuilt(dir));
    assertEquals(landingSiteMiddleware(dir), null);
    const app = buildApp(dir);
    assertEquals(await (await app.request("/")).text(), SPA_HTML);
    assertEquals(await (await app.request("/app/")).text(), SPA_HTML);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("app.ts mounts the SPA prefix and the landing site before the SPA fallback", async () => {
  const src = await Deno.readTextFile(new URL("../../../app.ts", import.meta.url));
  const prefix = src.indexOf("app.get(APP_BASE_PATH, serveSpaShell)");
  const landing = src.indexOf("landingSiteMiddleware()");
  const storefront = src.indexOf('app.route("/", storefrontRouter)');
  const spaFallback = src.indexOf('app.use("/*", serveStatic({ root: "./web/dist" }))');
  assert(prefix > 0 && landing > 0 && storefront > 0 && spaFallback > 0, "anchors present");
  assert(storefront < prefix, "storefront routes win over the SPA prefix");
  assert(prefix < landing, "the SPA prefix is mounted before the landing site");
  assert(landing < spaFallback, "the landing site is mounted before the SPA fallback");
});
