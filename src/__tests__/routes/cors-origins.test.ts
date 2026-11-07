/**
 * CORS on the API is credentialed, so it must answer only the app's own
 * origins. The template used to reflect any Origin back with
 * Access-Control-Allow-Credentials, which let any site read the API with a
 * signed-in visitor's session cookie.
 */
import { assertEquals } from "@std/assert";
import { app } from "../../../app.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";

function preflight(origin: string) {
  return app.request("/api/auth/config", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = getEnv(k);
    if (v === undefined) __deleteEnvForTest(k);
    else __setEnvForTest(k, v);
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) __deleteEnvForTest(k);
      else __setEnvForTest(k, v);
    }
  }
}

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "cors: another site's origin gets no CORS headers",
  ...OPTS,
  fn: () =>
    withEnv({ APP_URL: "https://app.example.com", NODE_ENV: "production" }, async () => {
      const res = await preflight("https://evil.example.net");
      await res.body?.cancel();
      assertEquals(res.headers.get("access-control-allow-origin"), null);
      const get = await app.request("/api/auth/config", {
        headers: { origin: "https://evil.example.net" },
      });
      await get.body?.cancel();
      assertEquals(get.headers.get("access-control-allow-origin"), null);
    }),
});

Deno.test({
  name: "cors: the app's own origins are allowed with credentials",
  ...OPTS,
  fn: () =>
    withEnv({
      APP_URL: "https://app.example.com",
      WEB_APP_URL: "https://web.example.com/",
      ALCHEMIST_PUBLIC_HOSTS: "abc.on.chipp.ai, www.customer.example",
      NODE_ENV: "production",
    }, async () => {
      for (
        const origin of [
          "https://app.example.com",
          "https://web.example.com",
          "https://abc.on.chipp.ai",
          "https://www.customer.example",
        ]
      ) {
        const res = await preflight(origin);
        await res.body?.cancel();
        assertEquals(res.headers.get("access-control-allow-origin"), origin, origin);
        assertEquals(res.headers.get("access-control-allow-credentials"), "true");
      }
    }),
});

Deno.test({
  name: "cors: localhost dev ports are allowed outside production only",
  ...OPTS,
  fn: async () => {
    await withEnv({ NODE_ENV: "development" }, async () => {
      const res = await preflight("http://localhost:5280");
      await res.body?.cancel();
      assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:5280");
    });
    await withEnv({ NODE_ENV: "production", APP_URL: "https://app.example.com" }, async () => {
      const res = await preflight("http://localhost:5280");
      await res.body?.cancel();
      assertEquals(res.headers.get("access-control-allow-origin"), null);
    });
  },
});

Deno.test({
  name: "cors: MCP_ALLOWED_ORIGINS origins keep working",
  ...OPTS,
  fn: () =>
    withEnv({
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
      MCP_ALLOWED_ORIGINS: "https://inspector.example.org",
    }, async () => {
      const res = await preflight("https://inspector.example.org");
      await res.body?.cancel();
      assertEquals(
        res.headers.get("access-control-allow-origin"),
        "https://inspector.example.org",
      );
    }),
});
