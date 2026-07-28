/**
 * Unit tests for the DEMO_MODE banner + public landing page:
 *   - src/api/middleware/demo-banner.ts (banner injection + dismissal)
 *   - src/api/routes/demo-landing.ts    (public `/` landing state)
 *
 * DEMO_MODE is read LIVE (Deno.env.get on every call), so these tests can
 * flip it per-case without a module-reload dance -- same approach as
 * src/__tests__/demo-mode.test.ts.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import {
  DEMO_BANNER_DISMISS_COOKIE,
  DEMO_BANNER_DISMISS_PATH,
  demoBannerDismissRoute,
  demoBannerMiddleware,
} from "@/api/middleware/demo-banner.ts";
import { demoLandingRoute } from "@/api/routes/demo-landing.ts";
import { demoNoindexHeaderMiddleware } from "@/api/middleware/demo-noindex.ts";

/** Runs `fn` with DEMO_MODE temporarily overridden, restoring it after. */
async function withDemoMode(value: string | undefined, fn: () => void | Promise<void>): Promise<void> {
  const prev = Deno.env.get("DEMO_MODE");
  if (value === undefined) Deno.env.delete("DEMO_MODE");
  else Deno.env.set("DEMO_MODE", value);
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("DEMO_MODE");
    else Deno.env.set("DEMO_MODE", prev);
  }
}

function buildBannerTestApp(): Hono {
  const app = new Hono();
  app.use("*", demoBannerMiddleware);
  app.get(DEMO_BANNER_DISMISS_PATH, demoBannerDismissRoute);
  app.get(DEMO_BANNER_DISMISS_PATH, (c) => c.text("fallback: no dismiss route", 404));
  app.get(
    "/page",
    (c) => c.html("<!doctype html><html><head></head><body><h1>Hello</h1></body></html>"),
  );
  app.get("/data.json", (c) => c.json({ ok: true }));
  return app;
}

// ── Banner injection ─────────────────────────────────────────────────────

Deno.test("demoBannerMiddleware: no banner in HTML response when DEMO_MODE is off", async () => {
  await withDemoMode(undefined, async () => {
    const app = buildBannerTestApp();
    const res = await app.request("/page");
    const body = await res.text();
    assert(!body.includes("alchemist-demo-banner"), "banner must be absent when DEMO_MODE is off");
    assertStringIncludes(body, "<h1>Hello</h1>");
  });
});

Deno.test("demoBannerMiddleware: injects banner into HTML response when DEMO_MODE=1", async () => {
  await withDemoMode("1", async () => {
    const app = buildBannerTestApp();
    const res = await app.request("/page");
    const body = await res.text();
    assertStringIncludes(body, "alchemist-demo-banner");
    assertStringIncludes(body, "Live demo of the SaaS Starter template on Alchemist");
    assertStringIncludes(body, "all content is fictional.");
    // Banner must land right after <body>, before existing content.
    assert(body.indexOf("alchemist-demo-banner") < body.indexOf("<h1>Hello</h1>"));
    // Dismiss link present and points at the dismiss route.
    assertStringIncludes(body, DEMO_BANNER_DISMISS_PATH);
  });
});

Deno.test("demoBannerMiddleware: does not touch non-HTML (JSON) responses", async () => {
  await withDemoMode("1", async () => {
    const app = buildBannerTestApp();
    const res = await app.request("/data.json");
    const json = await res.json();
    assertEquals(json, { ok: true });
  });
});

Deno.test("demoBannerMiddleware: banner absent once the dismiss cookie is set", async () => {
  await withDemoMode("1", async () => {
    const app = buildBannerTestApp();
    const res = await app.request("/page", {
      headers: { cookie: `${DEMO_BANNER_DISMISS_COOKIE}=1` },
    });
    const body = await res.text();
    assert(!body.includes("alchemist-demo-banner"), "banner must be suppressed once dismissed");
  });
});

// ── Dismissal route ──────────────────────────────────────────────────────

Deno.test("demoBannerDismissRoute: falls through untouched when DEMO_MODE is off", async () => {
  await withDemoMode(undefined, async () => {
    const app = buildBannerTestApp();
    const res = await app.request(DEMO_BANNER_DISMISS_PATH);
    assertEquals(res.status, 404);
    assertEquals(res.headers.get("set-cookie"), null);
  });
});

Deno.test("demoBannerDismissRoute: sets a session cookie and redirects back when DEMO_MODE=1", async () => {
  await withDemoMode("1", async () => {
    const app = buildBannerTestApp();
    const res = await app.request(
      `${DEMO_BANNER_DISMISS_PATH}?to=${encodeURIComponent("/page?x=1")}`,
      { redirect: "manual" },
    );
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/page?x=1");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assertStringIncludes(setCookie, `${DEMO_BANNER_DISMISS_COOKIE}=1`);
    // Session cookie -- no Max-Age/Expires.
    assert(!/max-age/i.test(setCookie), "dismiss cookie must not set Max-Age (session-only)");
    assert(!/expires=/i.test(setCookie), "dismiss cookie must not set Expires (session-only)");
  });
});

Deno.test("demoBannerDismissRoute: rejects an absolute/open-redirect `to` and falls back to /", async () => {
  await withDemoMode("1", async () => {
    const app = buildBannerTestApp();
    const res = await app.request(
      `${DEMO_BANNER_DISMISS_PATH}?to=${encodeURIComponent("https://evil.example.com")}`,
      { redirect: "manual" },
    );
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/");
  });
});

Deno.test("demoBannerDismissRoute: rejects a protocol-relative `to` and falls back to /", async () => {
  await withDemoMode("1", async () => {
    const app = buildBannerTestApp();
    const res = await app.request(
      `${DEMO_BANNER_DISMISS_PATH}?to=${encodeURIComponent("//evil.example.com")}`,
      { redirect: "manual" },
    );
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/");
  });
});

// ── Public landing page ──────────────────────────────────────────────────

function buildLandingTestApp(): Hono {
  const app = new Hono();
  app.get("/", demoLandingRoute);
  app.get("/", (c) => c.text("spa fallback"));
  return app;
}

Deno.test("demoLandingRoute: falls through to the SPA fallback when DEMO_MODE is off", async () => {
  await withDemoMode(undefined, async () => {
    const app = buildLandingTestApp();
    const res = await app.request("/");
    assertEquals(await res.text(), "spa fallback");
  });
});

Deno.test("demoLandingRoute: renders a read-only landing page when DEMO_MODE=1", async () => {
  await withDemoMode("1", async () => {
    const app = buildLandingTestApp();
    const res = await app.request("/");
    assertEquals(res.status, 200);
    assertMatch(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assertStringIncludes(body, "Alchemist SaaS Starter");
    assertStringIncludes(body, "/index.html#/login");
    assertStringIncludes(body, "github.com/chipp-ai/alchemist-template");
    assertStringIncludes(body, "all content is fictional");
  });
});

Deno.test("demoBannerMiddleware composes with demoNoindexHeaderMiddleware in app.ts's registration order", async () => {
  // Mirrors app.ts: demoNoindexHeaderMiddleware is registered BEFORE
  // demoBannerMiddleware. Reassigning c.res inside the banner middleware
  // must not drop headers set by middleware registered earlier (which
  // unwind AFTER it) -- see src/api/middleware/demo-banner.ts's ordering
  // comment.
  await withDemoMode("1", async () => {
    const app = new Hono();
    app.use("*", demoNoindexHeaderMiddleware);
    app.use("*", demoBannerMiddleware);
    app.get("/page", (c) => c.html("<!doctype html><html><body><p>hi</p></body></html>"));

    const res = await app.request("/page");
    assertEquals(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
    const body = await res.text();
    assertStringIncludes(body, "alchemist-demo-banner");
  });
});

Deno.test("demoLandingRoute + demoBannerMiddleware compose: landing page also carries the banner", async () => {
  await withDemoMode("1", async () => {
    const app = new Hono();
    app.use("*", demoBannerMiddleware);
    app.get("/", demoLandingRoute);
    const res = await app.request("/");
    const body = await res.text();
    assertStringIncludes(body, "alchemist-demo-banner");
    assertStringIncludes(body, "Alchemist SaaS Starter");
  });
});
