/**
 * The old-URL gate (scripts/check-old-urls.ts) against a mock server, and
 * against the real middleware stack (landing site, redirects, SPA
 * fallback) serving the fixture site's old URLs.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Hono } from "hono";
import { checkOldUrls, parseOldUrls } from "../../scripts/check-old-urls.ts";
import { landingSiteMiddleware } from "@/lib/landing-site.ts";
import { loadSiteRedirects, siteRedirectsMiddleware } from "@/lib/site-redirects.ts";

const FIXTURE = new URL("./fixtures/site-migration/", import.meta.url);

async function withServer(app: Hono, fn: (base: URL) => Promise<void>): Promise<void> {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, app.fetch);
  try {
    await fn(new URL(`http://127.0.0.1:${server.addr.port}`));
  } finally {
    ac.abort();
    await server.finished;
  }
}

Deno.test("check:old-urls: 200 and one redirect to a 200 pass; everything else fails with a reason", async () => {
  const app = new Hono();
  app.get("/ok", (c) => c.text("page"));
  app.get("/moved", (c) => c.redirect("/ok", 301));
  app.get("/temp", (c) => c.redirect("/ok?x=1", 302));
  app.get("/gone", (c) => c.redirect("/missing", 301));
  app.get("/twice", (c) => c.redirect("/moved", 301));
  app.get("/offsite", (c) => c.redirect("https://elsewhere.example.com/", 301));
  app.get("/perm", (c) => c.redirect("/ok", 308));
  app.get("/broken", (c) => c.text("oops", 500));
  app.get("/soft404", (c) => {
    c.header("X-Spa-Fallback", "1");
    return c.html("<div id=app></div>");
  });
  await withServer(app, async (base) => {
    const results = await checkOldUrls(base, [
      "/ok",
      "/moved",
      "/temp",
      "/gone",
      "/twice",
      "/offsite",
      "/perm",
      "/broken",
      "/soft404",
      "/never",
    ]);
    const by = Object.fromEntries(results.map((r) => [r.path, r]));
    assertEquals(by["/ok"], { path: "/ok", ok: true, detail: "200" });
    assertEquals(by["/moved"], { path: "/moved", ok: true, detail: "301 -> /ok -> 200" });
    assertEquals(by["/temp"].ok, true);
    assertEquals(by["/gone"], { path: "/gone", ok: false, detail: "301 -> /missing -> 404" });
    assert(!by["/twice"].ok && by["/twice"].detail.includes("a second redirect"));
    assert(!by["/offsite"].ok && by["/offsite"].detail.includes("off this site"));
    assert(!by["/perm"].ok && by["/perm"].detail.includes("use 301 or 302"));
    assertEquals(by["/broken"], { path: "/broken", ok: false, detail: "500" });
    assert(!by["/soft404"].ok && by["/soft404"].detail.includes("catch-all"));
    assertEquals(by["/never"].ok, false);
    assertEquals(results.map((r) => r.path)[0], "/ok", "results keep the input order");
  });
});

Deno.test("check:old-urls: an unreachable server fails every path instead of throwing", async () => {
  const results = await checkOldUrls(new URL("http://127.0.0.1:1"), ["/a"]);
  assertEquals(results[0].ok, false);
  assert(results[0].detail.startsWith("request failed"));
});

Deno.test("check:old-urls: parses the file and refuses a bad shape", () => {
  assertEquals(parseOldUrls('{"origin":"https://o.example.com","paths":["/","about","/"]}'), {
    origin: "https://o.example.com",
    paths: ["/", "/about"],
  });
  assertThrows(() => parseOldUrls('{"urls":[]}'));
});

Deno.test("check:old-urls: the fixture site's old URLs pass against the real middleware stack, and a missing page fails", async () => {
  const dist = await Deno.makeTempDir({ prefix: "old-urls-dist-" });
  try {
    for (const p of ["", "about-us", "services/roofing", "blog", "blog/spring-roof-check"]) {
      await Deno.mkdir(`${dist}/${p}`, { recursive: true });
      await Deno.writeTextFile(`${dist}/${p}/index.html`, `<h1>${p || "home"}</h1>`);
    }
    const rules = loadSiteRedirects(new URL("chipp/redirects.json", FIXTURE).pathname);
    assertEquals(rules.length, 1);
    const app = new Hono();
    const landing = landingSiteMiddleware(dist, "landing");
    if (landing) app.use("/*", landing);
    const redirects = siteRedirectsMiddleware(rules);
    if (redirects) app.use("/*", redirects);
    app.get("/*", (c) => {
      c.header("X-Spa-Fallback", "1");
      return c.html("<div id=app></div>");
    });
    const { paths } = parseOldUrls(await Deno.readTextFile(new URL("chipp/site-migration/old-urls.json", FIXTURE)));
    await withServer(app, async (base) => {
      const results = await checkOldUrls(base, paths);
      assertEquals(results.filter((r) => !r.ok), []);
      assertEquals(results.find((r) => r.path === "/roofing.html")?.detail, "301 -> /services/roofing/ -> 200");

      await Deno.remove(`${dist}/about-us`, { recursive: true });
      const after = await checkOldUrls(base, paths);
      assertEquals(after.filter((r) => !r.ok).map((r) => r.path), ["/about-us"]);
    });
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});
