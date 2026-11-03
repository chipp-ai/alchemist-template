/**
 * A browser round trip comes back to the host it started on.
 *
 * An app can answer on its `<id>.on.chipp.ai` address and a connected custom
 * domain. The platform sets APP_URL to the canonical host and lists every
 * host in ALCHEMIST_PUBLIC_HOSTS. Session and OAuth state cookies are
 * host-only, so OAuth redirect_uri / landing and Stripe return URLs must use
 * the request's host when it is listed, and APP_URL / WEB_APP_URL otherwise.
 */

import { assertEquals } from "@std/assert";

import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import {
  publicHosts,
  requestAppOrigin,
  requestPublicOrigin,
  requestWebOrigin,
} from "@/services/app-links.ts";

function req(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower[name.toLowerCase()] };
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = getEnv(k);
    if (v === undefined) __deleteEnvForTest(k);
    else __setEnvForTest(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) __deleteEnvForTest(k);
      else __setEnvForTest(k, v);
    }
  }
}

const HOSTS = "www.example.org,7158a5a670b6.on.chipp.ai";
const PROD = { ALCHEMIST_PUBLIC_HOSTS: HOSTS, APP_URL: "https://www.example.org", WEB_APP_URL: "https://www.example.org" };

Deno.test("publicHosts: parses and normalizes the platform list", () => {
  withEnv({ ALCHEMIST_PUBLIC_HOSTS: " WWW.Example.org , x.on.chipp.ai:443 ,," }, () => {
    assertEquals(publicHosts(), ["www.example.org", "x.on.chipp.ai"]);
  });
  withEnv({ ALCHEMIST_PUBLIC_HOSTS: undefined }, () => assertEquals(publicHosts(), []));
});

Deno.test("a request on the on.chipp.ai host stays there", () => {
  withEnv(PROD, () => {
    const r = req({ "X-Forwarded-Host": "7158a5a670b6.on.chipp.ai", Host: "7158a5a670b6.customer-router.chipp.ai" });
    assertEquals(requestPublicOrigin(r), "https://7158a5a670b6.on.chipp.ai");
    assertEquals(requestAppOrigin(r), "https://7158a5a670b6.on.chipp.ai");
    assertEquals(requestWebOrigin(r), "https://7158a5a670b6.on.chipp.ai");
  });
});

Deno.test("a request on the custom domain stays there", () => {
  withEnv(PROD, () => {
    const r = req({ "X-Forwarded-Host": "www.example.org" });
    assertEquals(requestAppOrigin(r), "https://www.example.org");
  });
});

Deno.test("an unlisted host falls back to APP_URL (a spoofed header cannot leave the app)", () => {
  withEnv(PROD, () => {
    const r = req({ "X-Forwarded-Host": "evil.example.com", Host: "7158a5a670b6.customer-router.chipp.ai" });
    assertEquals(requestPublicOrigin(r), null);
    assertEquals(requestAppOrigin(r), "https://www.example.org");
    assertEquals(requestWebOrigin(r), "https://www.example.org");
  });
});

Deno.test("Host is used when X-Forwarded-Host is absent", () => {
  withEnv(PROD, () => {
    assertEquals(requestAppOrigin(req({ Host: "www.example.org" })), "https://www.example.org");
  });
});

Deno.test("local dev (no platform list) keeps APP_URL / WEB_APP_URL exactly", () => {
  withEnv({ ALCHEMIST_PUBLIC_HOSTS: undefined, APP_URL: "http://localhost:8000", WEB_APP_URL: "http://localhost:5173" }, () => {
    const r = req({ Host: "localhost:5173" });
    assertEquals(requestAppOrigin(r), "http://localhost:8000");
    assertEquals(requestWebOrigin(r), "http://localhost:5173");
  });
});

Deno.test("wiring: OAuth and Stripe round trips use the request-aware origins", async () => {
  const auth = await Deno.readTextFile(new URL("../../api/routes/auth/index.ts", import.meta.url));
  assertEquals(auth.split("requestAppOrigin(c.req)").length - 1, 2, "authorize + token exchange redirect_uri");
  assertEquals(auth.includes("requestWebOrigin(c.req)"), true, "OAuth landing");
  assertEquals(/getEnv\("APP_URL"\)/.test(auth), false, "no hand-read APP_URL left in auth");
  const billing = await Deno.readTextFile(new URL("../../api/routes/billing/index.ts", import.meta.url));
  assertEquals(billing.split("requestWebOrigin(c.req)").length - 1, 3, "portal, plan checkout, product checkout");
});
