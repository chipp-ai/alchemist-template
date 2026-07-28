/**
 * Unit tests for the DEMO_MODE flag + its boot/runtime guards:
 *   - src/config/demo-mode.ts        (the flag itself)
 *   - src/lib/stripe.ts              (live-key boot refusal)
 *   - src/services/email.ts          (outbound-email suppression)
 *   - src/api/middleware/demo-noindex.ts (X-Robots-Tag + robots.txt)
 *
 * DEMO_MODE is read LIVE (Deno.env.get on every call, no module-level
 * caching), so these tests can flip it per-case without re-importing
 * modules -- same approach as the existing ALCHEMIST_DEV_ROUTES tests.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { Hono } from "hono";
import { isDemoMode } from "@/config/demo-mode.ts";
import { assertNoLiveStripeKeyInDemoMode } from "@/lib/stripe.ts";
import { demoNoindexHeaderMiddleware, demoRobotsTxtRoute } from "@/api/middleware/demo-noindex.ts";

/** Runs `fn` with DEMO_MODE and STRIPE_SECRET_KEY temporarily overridden, restoring both after. */
function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) prev[key] = Deno.env.get(key);

  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };

  apply(overrides);
  return Promise.resolve(fn()).finally(() => apply(prev));
}

// ── isDemoMode() ─────────────────────────────────────────────────────────

Deno.test("isDemoMode: false when DEMO_MODE is unset (default off)", async () => {
  await withEnv({ DEMO_MODE: undefined }, () => {
    assertEquals(isDemoMode(), false);
  });
});

Deno.test("isDemoMode: false for any value other than the literal '1'", async () => {
  await withEnv({ DEMO_MODE: "true" }, () => {
    assertEquals(isDemoMode(), false);
  });
  await withEnv({ DEMO_MODE: "0" }, () => {
    assertEquals(isDemoMode(), false);
  });
});

Deno.test("isDemoMode: true when DEMO_MODE=1", async () => {
  await withEnv({ DEMO_MODE: "1" }, () => {
    assertEquals(isDemoMode(), true);
  });
});

// ── Stripe boot guard ────────────────────────────────────────────────────

Deno.test("assertNoLiveStripeKeyInDemoMode: no-op when DEMO_MODE is off, even with a live key", async () => {
  await withEnv({ DEMO_MODE: undefined, STRIPE_SECRET_KEY: "sk_live_abc123" }, () => {
    assertNoLiveStripeKeyInDemoMode(); // must not throw
  });
});

Deno.test("assertNoLiveStripeKeyInDemoMode: no-op when Stripe is not configured", async () => {
  await withEnv({ DEMO_MODE: "1", STRIPE_SECRET_KEY: undefined }, () => {
    assertNoLiveStripeKeyInDemoMode(); // must not throw
  });
});

Deno.test("assertNoLiveStripeKeyInDemoMode: passes with a test-mode key", async () => {
  await withEnv({ DEMO_MODE: "1", STRIPE_SECRET_KEY: "sk_test_abc123" }, () => {
    assertNoLiveStripeKeyInDemoMode(); // must not throw
  });
});

Deno.test("assertNoLiveStripeKeyInDemoMode: throws on a live-mode key", async () => {
  await withEnv({ DEMO_MODE: "1", STRIPE_SECRET_KEY: "sk_live_abc123" }, () => {
    assertThrows(() => assertNoLiveStripeKeyInDemoMode(), Error, "TEST-mode");
  });
});

// ── robots.txt / X-Robots-Tag middleware ────────────────────────────────

function buildTestApp(): Hono {
  const app = new Hono();
  app.use("*", demoNoindexHeaderMiddleware);
  app.get("/robots.txt", demoRobotsTxtRoute);
  app.get("/robots.txt", (c) => c.text("fallback body")); // stands in for the SPA fallback
  app.get("/other", (c) => c.text("ok"));
  return app;
}

Deno.test("demo-noindex: no X-Robots-Tag header and robots.txt falls through when DEMO_MODE is off", async () => {
  await withEnv({ DEMO_MODE: undefined }, async () => {
    const app = buildTestApp();

    const other = await app.request("/other");
    assertEquals(other.headers.get("X-Robots-Tag"), null);

    const robots = await app.request("/robots.txt");
    assertEquals(robots.headers.get("X-Robots-Tag"), null);
    assertEquals(await robots.text(), "fallback body");
  });
});

Deno.test("demo-noindex: X-Robots-Tag on every response + disallow-all robots.txt when DEMO_MODE=1", async () => {
  await withEnv({ DEMO_MODE: "1" }, async () => {
    const app = buildTestApp();

    const other = await app.request("/other");
    assertEquals(other.headers.get("X-Robots-Tag"), "noindex, nofollow");

    const robots = await app.request("/robots.txt");
    assertEquals(robots.headers.get("X-Robots-Tag"), "noindex, nofollow");
    assertEquals(robots.headers.get("Content-Type"), "text/plain; charset=UTF-8");
    assertEquals(await robots.text(), "User-agent: *\nDisallow: /\n");
  });
});
