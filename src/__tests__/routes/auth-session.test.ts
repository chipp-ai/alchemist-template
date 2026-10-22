/**
 * GET /api/auth/session: the SPA's startup session check.
 *
 * An anonymous visitor on a public page must get a 200 `{ user: null }`,
 * never a 401: the browser prints every 4xx fetch as a console error, so a
 * 401 here logged one error on every public page of every app.
 * GET /api/auth/me keeps its 401 for anonymous callers.
 */

import { assertEquals } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser, dbTest } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";

dbTest("GET /api/auth/session: anonymous visitor gets 200 with user null", async () => {
  const res = await app.request("/api/auth/session");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.user, null);
  assertEquals(body.organization, null);
  assertEquals(typeof body.sessionDurationMs, "number");
});

dbTest("GET /api/auth/session: a garbage cookie is treated as signed out, not an error", async () => {
  const res = await app.request("/api/auth/session", {
    headers: { cookie: "session_id=not-a-jwt" },
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).user, null);
});

dbTest("GET /api/auth/session: a signed-in user gets the same body as /me", async () => {
  const a = await createIsolatedUser("owner");
  try {
    const cookie = `session_id=${await createSessionToken(a.user)}`;
    const session = await app.request("/api/auth/session", { headers: { cookie } });
    const me = await app.request("/api/auth/me", { headers: { cookie } });
    assertEquals(session.status, 200);
    assertEquals(me.status, 200);
    const s = await session.json();
    assertEquals(s, await me.json());
    assertEquals(s.user.email, a.user.email);
  } finally {
    await a.cleanup();
  }
});

dbTest("GET /api/auth/me: still 401 for an anonymous caller", async () => {
  const res = await app.request("/api/auth/me");
  assertEquals(res.status, 401);
  await res.body?.cancel();
});
