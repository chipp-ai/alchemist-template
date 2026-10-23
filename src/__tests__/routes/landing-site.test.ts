/**
 * The landing site (src/lib/landing-site.ts) and the SPA prefix in app.ts.
 * DB-free: builds a small Hono app the same way app.ts does, against a
 * throwaway landing build, so it never depends on `npm run build`.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import {
  type HomepageMode,
  isLandingPath,
  landingSiteBuilt,
  landingSiteMiddleware,
  readHomepageMode,
  scanLandingDist,
} from "@/lib/landing-site.ts";
import { PAGES, sitemapPages } from "../../../landing/src/lib/pages.ts";
import { APP_BASE_PATH } from "@/config/site.ts";

const LANDING_HTML = "<!doctype html><html><body>LANDING HOME</body></html>";
const PRICING_HTML = "<!doctype html><html><body>LANDING PRICING</body></html>";
const SPA_HTML = "SPA SHELL";

async function landingBuild(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "landing-dist-" });
  await Deno.writeTextFile(`${dir}/index.html`, LANDING_HTML);
  await Deno.mkdir(`${dir}/pricing`);
  await Deno.writeTextFile(`${dir}/pricing/index.html`, PRICING_HTML);
  await Deno.mkdir(`${dir}/about`);
  await Deno.writeTextFile(
    `${dir}/about/index.html`,
    "<!doctype html><html><body>LANDING ABOUT</body></html>",
  );
  await Deno.writeTextFile(`${dir}/robots.txt`, "User-agent: *\nAllow: /\n");
  await Deno.writeTextFile(`${dir}/sitemap.xml`, '<?xml version="1.0"?><urlset></urlset>\n');
  await Deno.writeTextFile(`${dir}/llms.txt`, "# Acme\n\n> LLMS SUMMARY\n");
  await Deno.writeTextFile(`${dir}/llms-full.txt`, "# Acme\n\nLLMS FULL\n");
  await Deno.writeTextFile(`${dir}/favicon.svg`, "<svg>FAVICON</svg>");
  await Deno.mkdir(`${dir}/_astro`);
  await Deno.writeTextFile(`${dir}/_astro/site.css`, "body{color:red}");
  return dir;
}

/** The same order app.ts uses: API, SPA prefix, landing site, SPA fallback. */
function buildApp(landingDir: string, mode: HomepageMode = "landing"): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/thing", (c) => c.json({ ok: true }));
  app.get(APP_BASE_PATH, (c) => c.html(SPA_HTML));
  app.get(`${APP_BASE_PATH}/*`, (c) => c.html(SPA_HTML));
  const landing = landingSiteMiddleware(landingDir, mode);
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

async function siteJson(content: unknown): Promise<string> {
  const file = await Deno.makeTempFile({ prefix: "site-json-", suffix: ".json" });
  await Deno.writeTextFile(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

Deno.test('readHomepageMode: "app" is app-first; missing, unknown or unreadable is the landing default', async () => {
  const files = [
    await siteJson({ name: "Acme", homepage: "app" }),
    await siteJson({ name: "Acme" }),
    await siteJson({ name: "Acme", homepage: "landing" }),
    await siteJson({ name: "Acme", homepage: "App" }),
    await siteJson("not json"),
  ];
  try {
    assertEquals(readHomepageMode(files[0]), "app");
    assertEquals(readHomepageMode(files[1]), "landing");
    assertEquals(readHomepageMode(files[2]), "landing");
    assertEquals(readHomepageMode(files[3]), "landing");
    assertEquals(readHomepageMode(files[4]), "landing");
    assertEquals(readHomepageMode("/no/such/site.json"), "landing");
  } finally {
    for (const f of files) await Deno.remove(f);
  }
});

Deno.test("app-first mode: / serves the SPA, /app still works, the landing pages are not served", async () => {
  const dir = await landingBuild();
  try {
    const app = buildApp(dir, "app");
    assertEquals(await (await app.request("/")).text(), SPA_HTML);
    assertEquals(await (await app.request("/app/")).text(), SPA_HTML);
    assertEquals(await (await app.request("/app")).text(), SPA_HTML);
    // The marketing pages redirect to "/" (302: the mode can flip back).
    for (const path of ["/pricing", "/pricing/", "/pricing/index.html", "/about", "/about/"]) {
      const res = await app.request(path);
      assertEquals(res.status, 302, path);
      assertEquals(res.headers.get("location"), "/", path);
    }
    // /index.html stays the SPA shell, unknown paths still fall through to the SPA.
    assertEquals(await (await app.request("/index.html")).text(), SPA_HTML);
    assertEquals(await (await app.request("/settings/billing")).text(), SPA_HTML);
    assertEquals((await app.request("/health")).status, 200);
    assertEquals((await (await app.request("/api/thing")).json()).ok, true);
    assertEquals((await app.request("/api/missing")).status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("app-first mode still serves llms.txt, robots.txt, sitemap.xml, the favicon and assets from landing/dist", async () => {
  const dir = await landingBuild();
  try {
    const app = buildApp(dir, "app");
    const cases: [string, string, string][] = [
      ["/llms.txt", "LLMS SUMMARY", "text/plain"],
      ["/llms-full.txt", "LLMS FULL", "text/plain"],
      ["/robots.txt", "User-agent", "text/plain"],
      ["/sitemap.xml", "<urlset>", "xml"],
      ["/favicon.svg", "FAVICON", "image/svg"],
      ["/_astro/site.css", "color:red", "text/css"],
    ];
    for (const [path, body, type] of cases) {
      const res = await app.request(path);
      assertEquals(res.status, 200, path);
      assertStringIncludes(res.headers.get("content-type") ?? "", type, path);
      assertStringIncludes(await res.text(), body, path);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("landing mode serves the same machine-readable files and the pages", async () => {
  const dir = await landingBuild();
  try {
    const app = buildApp(dir, "landing");
    for (
      const [path, body] of [
        ["/llms.txt", "LLMS SUMMARY"],
        ["/llms-full.txt", "LLMS FULL"],
        ["/sitemap.xml", "<urlset>"],
        ["/favicon.svg", "FAVICON"],
        ["/about/", "LANDING ABOUT"],
      ]
    ) {
      const res = await app.request(path);
      assertEquals(res.status, 200, path);
      assertStringIncludes(await res.text(), body, path);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("app-first mode without a landing build: everything is the SPA", async () => {
  const dir = await Deno.makeTempDir({ prefix: "landing-missing-" });
  try {
    assertEquals(landingSiteMiddleware(dir, "app"), null);
    const app = buildApp(dir, "app");
    assertEquals(await (await app.request("/")).text(), SPA_HTML);
    assertEquals(await (await app.request("/pricing/")).text(), SPA_HTML);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanLandingDist splits files from pages in every path form", async () => {
  const dir = await landingBuild();
  try {
    await Deno.writeTextFile(`${dir}/404.html`, "<!doctype html>NOT FOUND");
    const { files, pages } = scanLandingDist(dir);
    for (
      const f of [
        "/robots.txt",
        "/sitemap.xml",
        "/llms.txt",
        "/llms-full.txt",
        "/favicon.svg",
        "/_astro/site.css",
      ]
    ) {
      assert(files.has(f), f);
    }
    for (
      const p of [
        "/",
        "/index.html",
        "/pricing",
        "/pricing/",
        "/pricing/index.html",
        "/about",
        "/404",
        "/404.html",
      ]
    ) {
      assert(pages.has(p), p);
    }
    assertFalse(files.has("/index.html"));
    assertFalse(pages.has("/llms.txt"));
    assertEquals(scanLandingDist("/no/such/dir").files.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the sitemap lists every page in landing mode and only / in app-first mode", () => {
  assertEquals(sitemapPages(undefined).map((p) => p.path), PAGES.map((p) => p.path));
  assertEquals(sitemapPages("landing").map((p) => p.path), ["/", "/pricing/", "/about/"]);
  assertEquals(sitemapPages("app").map((p) => p.path), ["/"]);
});

Deno.test("default mode with the same build: / is the landing site", async () => {
  const dir = await landingBuild();
  try {
    const app = buildApp(dir, "landing");
    assertStringIncludes(await (await app.request("/")).text(), "LANDING HOME");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the template ships in landing mode", () => {
  assertEquals(
    readHomepageMode(new URL("../../../landing/src/content/site.json", import.meta.url).pathname),
    "landing",
  );
});
