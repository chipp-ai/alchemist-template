/**
 * optionalSession (src/api/middleware/optional-session.ts): the viewer of a
 * public SSR page. The signed-in case uses createIsolatedUser.
 */

import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { Hono } from "hono";
import { createIsolatedUser } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import {
  getSsrSession,
  optionalSession,
  type SsrSessionVariables,
  VISITOR_COOKIE,
} from "@/api/middleware/optional-session.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function buildApp() {
  const app = new Hono<{ Variables: SsrSessionVariables }>();
  app.get("/page", optionalSession, (c) => c.json(getSsrSession(c)));
  app.get("/unwired", (c) => c.json(getSsrSession(c)));
  return app;
}

function visitorCookie(res: Response): string | null {
  const m = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${VISITOR_COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

Deno.test("a first visit gets an anonymous session and a visitor_id cookie", async () => {
  const res = await buildApp().request("/page");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.user, null);
  assertMatch(body.visitorId, UUID_RE);
  assertEquals(visitorCookie(res), body.visitorId);
  const cookie = res.headers.get("set-cookie") ?? "";
  assert(/HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie) && /Path=\//.test(cookie), cookie);
});

Deno.test("a returning visitor keeps the id and gets no new cookie", async () => {
  const id = crypto.randomUUID();
  const res = await buildApp().request("/page", { headers: { cookie: `${VISITOR_COOKIE}=${id}` } });
  assertEquals((await res.json()).visitorId, id);
  assertEquals(res.headers.get("set-cookie"), null);
});

Deno.test("a visitor_id that is not a UUID is replaced", async () => {
  const res = await buildApp().request("/page", {
    headers: { cookie: `${VISITOR_COOKIE}=../../etc; x=1` },
  });
  const body = await res.json();
  assertMatch(body.visitorId, UUID_RE);
  assertEquals(visitorCookie(res), body.visitorId);
});

Deno.test("a bad session cookie is an anonymous visitor, not an error", async () => {
  const res = await buildApp().request("/page", { headers: { cookie: "session_id=not-a-jwt" } });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).user, null);
});

Deno.test("getSsrSession on a route without the middleware is a wiring error", async () => {
  const res = await buildApp().request("/unwired");
  assertEquals(res.status, 500);
  assertThrows(() => getSsrSession({ get: () => undefined }), Error, "optionalSession is not mounted");
});

Deno.test({
  name: "a signed-in visitor gets their user on the session",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ctx = await createIsolatedUser();
    try {
      const token = await createSessionToken(ctx.user);
      const res = await buildApp().request("/page", { headers: { cookie: `session_id=${token}` } });
      const body = await res.json();
      assertEquals(body.user?.id, ctx.user.id);
      assertEquals(body.user?.organizationId, ctx.user.organizationId);
      assertMatch(body.visitorId, UUID_RE);
    } finally {
      await ctx.cleanup();
    }
  },
});
