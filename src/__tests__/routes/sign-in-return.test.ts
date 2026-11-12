/**
 * Where a sign-in lands. Signed in, "/" is the app home (the landing site
 * redirect is in landing-site.test.ts). After a sign-in, the person opens
 * the page they asked for before they were sent to sign in, else the app
 * home, never the landing site at "/".
 *
 * - `safeAppRoute` (server) and `safeReturnRoute` (web/src/lib/return-to.ts)
 *   apply the same rule.
 * - The SPA remembers the asked-for route and hands it to OAuth as ?next=;
 *   the OAuth callback redirects there.
 * - `isSignedInMember` (the landing site's check) is true for a member's
 *   session and false for a verification session or a revoked one.
 */

import { assert, assertEquals } from "@std/assert";
import { appPath, safeAppRoute } from "@/config/site.ts";
import { OAUTH_NEXT_COOKIE, oauthLandingUrl } from "@/api/routes/auth/index.ts";
import {
  createSessionToken,
  createVerificationSessionToken,
  isSignedInMember,
} from "@/api/middleware/auth.ts";
import { __deleteEnvForTest, __setEnvForTest } from "@/lib/env.ts";
import { db } from "@/db/client.ts";
import {
  oauthStartUrl,
  rememberReturnTo,
  type ReturnToStore,
  safeReturnRoute,
  takeReturnTo,
} from "../../../web/src/lib/return-to.ts";
import { createIsolatedUser, dbTest } from "../helpers.ts";

function memoryStore(): ReturnToStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const ROUTES: [string | null | undefined, string | null][] = [
  ["/settings", "/settings"],
  ["/docs/intro", "/docs/intro"],
  ["/things/abc?tab=notes", "/things/abc?tab=notes"],
  [" /settings ", "/settings"],
  ["/", null],
  ["/login", null],
  ["/login?handoff=failed", null],
  ["/signup/", null],
  ["//evil.example", null],
  ["/\\evil.example", null],
  ["/javascript:alert(1)", null],
  ["https://evil.example/", null],
  ["settings", null],
  ["/a b", null],
  ["/x\u0000", null],
  [`/${"a".repeat(600)}`, null],
  ["", null],
  [null, null],
  [undefined, null],
];

Deno.test("safeAppRoute and safeReturnRoute agree: an in-app route, never a sign-in page, / or another site", () => {
  for (const [input, want] of ROUTES) {
    assertEquals(safeAppRoute(input), want, `server: ${String(input)}`);
    assertEquals(safeReturnRoute(input), want, `web: ${String(input)}`);
  }
});

Deno.test("return-to: remembered once, forgotten after reading or after 30 minutes", () => {
  const store = memoryStore();
  rememberReturnTo("/settings", 1_000, store);
  assertEquals(takeReturnTo(2_000, store), "/settings");
  assertEquals(takeReturnTo(2_000, store), null);

  rememberReturnTo("/settings", 1_000, store);
  assertEquals(takeReturnTo(1_000 + 31 * 60 * 1000, store), null);

  // "/", the sign-in pages and unsafe routes are not remembered.
  for (const route of ["/", "/login", "//evil.example"]) {
    rememberReturnTo(route, 1_000, store);
    assertEquals(store.data.size, 0, route);
  }

  // A tampered value is dropped, not followed.
  store.setItem("app:return-to", JSON.stringify({ route: "//evil.example", at: 1_000 }));
  assertEquals(takeReturnTo(2_000, store), null);
  store.setItem("app:return-to", "not json");
  assertEquals(takeReturnTo(2_000, store), null);
  assertEquals(takeReturnTo(2_000, null), null);
});

Deno.test("oauthStartUrl carries the remembered route as next, and takes it", () => {
  const store = memoryStore();
  assertEquals(oauthStartUrl("google", 1_000, store), "/api/auth/google");
  rememberReturnTo("/docs/intro?x=1", 1_000, store);
  assertEquals(
    oauthStartUrl("google", 2_000, store),
    `/api/auth/google?next=${encodeURIComponent("/docs/intro?x=1")}`,
  );
  assertEquals(store.data.size, 0);
});

Deno.test("oauthLandingUrl: the asked-for route, else the app home; never the site root", () => {
  const origin = "https://acme.example";
  assertEquals(oauthLandingUrl(origin, null), `${origin}${appPath("/#/")}`);
  assertEquals(oauthLandingUrl(origin, "/settings"), `${origin}${appPath("/#/settings")}`);
  assertEquals(oauthLandingUrl(origin, "//evil.example"), `${origin}${appPath("/#/")}`);
  assertEquals(oauthLandingUrl(origin, "/login"), `${origin}${appPath("/#/")}`);
  assert(appPath("/#/") !== "/");
});

dbTest("OAuth start keeps a safe ?next in a provider cookie and drops an unsafe one", async () => {
  const { app } = await import("../../../app.ts");
  __setEnvForTest("GOOGLE_CLIENT_ID", "test-client");
  __setEnvForTest("GOOGLE_CLIENT_SECRET", "test-secret");
  try {
    const ok = await app.request(`/api/auth/google?next=${encodeURIComponent("/settings")}`);
    assertEquals(ok.status, 302);
    const okCookies = ok.headers.getSetCookie().join("\n");
    assert(
      okCookies.includes(`${OAUTH_NEXT_COOKIE}_google=${encodeURIComponent("/settings")}`),
      okCookies,
    );

    const bad = await app.request(`/api/auth/google?next=${encodeURIComponent("//evil.example")}`);
    assertEquals(bad.status, 302);
    const badCookies = bad.headers.getSetCookie().join("\n");
    assert(!badCookies.includes("evil"), badCookies);
  } finally {
    __deleteEnvForTest("GOOGLE_CLIENT_ID");
    __deleteEnvForTest("GOOGLE_CLIENT_SECRET");
  }
});

dbTest("OAuth callback lands on the remembered route", async () => {
  const { app } = await import("../../../app.ts");
  const a = await createIsolatedUser("viewer");
  const realFetch = globalThis.fetch;
  __setEnvForTest("GOOGLE_CLIENT_ID", "test-client");
  __setEnvForTest("GOOGLE_CLIENT_SECRET", "test-secret");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(Response.json({ access_token: "at" }));
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
      return Promise.resolve(Response.json({ id: "g-1", email: a.user.email, name: "Viewer" }));
    }
    return realFetch(input);
  }) as typeof fetch;
  try {
    const res = await app.request("/api/auth/google/callback?code=abc&state=st", {
      headers: {
        cookie: `oauth_state_google=st; ${OAUTH_NEXT_COOKIE}_google=${
          encodeURIComponent("/settings")
        }`,
      },
    });
    assertEquals(res.status, 302);
    assert(
      res.headers.get("Location")!.endsWith(appPath("/#/settings")),
      res.headers.get("Location")!,
    );
  } finally {
    globalThis.fetch = realFetch;
    __deleteEnvForTest("GOOGLE_CLIENT_ID");
    __deleteEnvForTest("GOOGLE_CLIENT_SECRET");
    await a.cleanup();
  }
});

dbTest(
  "isSignedInMember: a member's session yes; verification, revoked or no session no",
  async () => {
    const a = await createIsolatedUser("viewer");
    const req = (cookie?: string) => ({
      req: { header: (n: string) => (n.toLowerCase() === "cookie" ? cookie : undefined) },
    });
    try {
      assertEquals(await isSignedInMember(req()), false);
      assertEquals(await isSignedInMember(req("session_id=not-a-jwt")), false);
      const member = await createSessionToken(a.user);
      assertEquals(await isSignedInMember(req(`session_id=${member}`)), true);
      const verifier = await createVerificationSessionToken(a.user, {
        ttlSeconds: 300,
        jti: crypto.randomUUID(),
      });
      assertEquals(await isSignedInMember(req(`session_id=${verifier}`)), false);
      await db.updateTable("users")
        .set({ tokenInvalidatedBefore: new Date(Date.now() + 60_000) })
        .where("id", "=", a.user.id)
        .execute();
      assertEquals(await isSignedInMember(req(`session_id=${member}`)), false);
    } finally {
      await a.cleanup();
    }
  },
);
