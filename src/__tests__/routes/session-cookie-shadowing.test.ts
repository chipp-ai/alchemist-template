/**
 * Duplicate session-cookie shadowing regression (Valor Victoria, 2026-07-08).
 *
 * Customer apps are hosted at `<slug>.on.chipp.ai` -- a subdomain of
 * chipp.ai -- and the Chipp builder dashboard sets its OWN `session_id`
 * cookie with `Domain=.chipp.ai`, which browsers attach to every
 * *.chipp.ai host. A user who is also logged into the Chipp dashboard
 * therefore sends TWO cookies named `session_id`: the foreign platform
 * JWT (older, domain-wide, ordered FIRST per RFC 6265 creation-time
 * ordering) and this app's own JWT (host-only, second). Hono's
 * `getCookie()` keeps only the FIRST occurrence, so auth read the
 * foreign token, failed verification, and looped users back to login
 * forever even after a successful OTP.
 *
 * The middleware must try EVERY same-name cookie occurrence until one
 * verifies against this app's JWT_SECRET.
 */

import { assertEquals } from "@std/assert";
import { createIsolatedUser, withTestServer } from "../helpers.ts";
import { createSessionToken, requireAuth } from "@/api/middleware/auth.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

// A structurally-valid JWT signed by a DIFFERENT secret -- the shape of
// the platform's Domain=.chipp.ai session cookie.
const FOREIGN_TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3JlaWduLXBsYXRmb3JtLWp3dCJ9.bm90LW91ci1zaWduYXR1cmU";

Deno.test({
  name:
    "requireAuth: a foreign same-name session_id ordered FIRST must not shadow the valid session",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { user, cleanup } = await createIsolatedUser("owner");
    try {
      const app = withTestServer((a) => {
        a.get("/protected", requireAuth, (c) => c.json({ ok: true }));
      });

      const validToken = await createSessionToken({
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        organizationId: user.organizationId,
        role: "owner",
      });

      // Foreign first (the real-world ordering) -- must still authenticate.
      const foreignFirst = await app.request("/protected", {
        headers: { cookie: `session_id=${FOREIGN_TOKEN}; session_id=${validToken}` },
      });
      assertEquals(
        foreignFirst.status,
        200,
        "a foreign same-name cookie ordered first must not shadow the valid session",
      );

      // Valid first -- also fine.
      const validFirst = await app.request("/protected", {
        headers: { cookie: `session_id=${validToken}; session_id=${FOREIGN_TOKEN}` },
      });
      assertEquals(validFirst.status, 200);

      // Only the foreign cookie -- clean 401.
      const onlyForeign = await app.request("/protected", {
        headers: { cookie: `session_id=${FOREIGN_TOKEN}` },
      });
      assertEquals(onlyForeign.status, 401);

      // No cookie at all -- clean 401.
      const noCookie = await app.request("/protected");
      assertEquals(noCookie.status, 401);
    } finally {
      await cleanup();
    }
  },
});
