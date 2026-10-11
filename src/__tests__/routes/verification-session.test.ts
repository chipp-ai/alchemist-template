/**
 * Platform verification sessions (`POST /api/auth/verification-session`).
 *
 * The platform's post-deploy verifier cannot receive an email code, so it
 * trades a short-lived, platform-signed token for a read-only session on a
 * dedicated verification account. These tests pin every refusal (disabled,
 * unsigned, wrong secret, expired, overlong, other project, write-capable,
 * replayed, owner role) and the read-only guard on the minted session.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import * as jose from "jose";
import { withTestServer } from "../helpers.ts";
import { db } from "@/db/client.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { authRoutes } from "@/api/routes/auth/index.ts";
import {
  createSessionToken,
  requireAuth,
  verificationReadOnlyGuard,
} from "@/api/middleware/auth.ts";
import {
  MAX_SESSION_TTL_SECONDS,
  VERIFICATION_TOKEN_AUDIENCE,
  VERIFICATION_TOKEN_ISSUER,
  VERIFICATION_TOKEN_TYP,
  verifyVerificationToken,
} from "@/lib/verification-session-token.ts";
import {
  isVerificationAccountEmail,
  VERIFICATION_ORG_SLUG,
  verificationAccountEmail,
} from "@/lib/verification-accounts.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
const SECRET = "a".repeat(64);
const PROJECT_ID = "11111111-2222-4333-8444-555555555555";

interface MintOpts {
  secret?: string;
  sub?: string;
  role?: string;
  ro?: unknown;
  jti?: string;
  iatOffset?: number;
  expOffset?: number;
  typ?: string;
  aud?: string;
  ttl?: number;
}

async function mint(opts: MintOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = now + (opts.iatOffset ?? 0);
  return await new jose.SignJWT({
    role: opts.role ?? "admin",
    ro: "ro" in opts ? opts.ro : true,
    ticket: "job-1234",
    run: "verify_deployed",
    ttl: opts.ttl ?? 600,
  })
    .setProtectedHeader({ alg: "HS256", typ: opts.typ ?? VERIFICATION_TOKEN_TYP })
    .setIssuer(VERIFICATION_TOKEN_ISSUER)
    .setAudience(opts.aud ?? VERIFICATION_TOKEN_AUDIENCE)
    .setSubject(opts.sub ?? PROJECT_ID)
    .setJti(opts.jti ?? crypto.randomUUID().replaceAll("-", ""))
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.expOffset ?? 300))
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

// ── Token verification (no DB) ─────────────────────────────────────────────

Deno.test("verifyVerificationToken: accepts a well-formed platform token", async () => {
  const result = await verifyVerificationToken(await mint(), SECRET, PROJECT_ID);
  assert(result.ok);
  assertEquals(result.claims.role, "admin");
  assertEquals(result.claims.ticketId, "job-1234");
  assertEquals(result.claims.runId, "verify_deployed");
  assertEquals(result.claims.sessionTtlSeconds, 600);
});

Deno.test("verifyVerificationToken: refuses every forged or out-of-scope shape", async () => {
  const cases: Array<[string, Promise<string>, string]> = [
    ["wrong secret", mint({ secret: "b".repeat(64) }), "invalid"],
    ["expired", mint({ iatOffset: -400, expOffset: 300 }), "expired"],
    ["exp far past iat", mint({ expOffset: 3600 }), "invalid"],
    ["other project", mint({ sub: "99999999-2222-4333-8444-555555555555" }), "wrong_project"],
    ["write-capable", mint({ ro: false }), "not_read_only"],
    ["ro as a string", mint({ ro: "true" }), "not_read_only"],
    ["wrong typ", mint({ typ: "JWT" }), "invalid"],
    ["wrong audience", mint({ aud: "something-else" }), "invalid"],
    ["short jti", mint({ jti: "abc" }), "malformed"],
    ["bad role shape", mint({ role: "Admin; drop" }), "malformed"],
  ];
  for (const [label, tokenP, reason] of cases) {
    const result = await verifyVerificationToken(await tokenP, SECRET, PROJECT_ID);
    assertFalse(result.ok, label);
    if (!result.ok) assertEquals(result.reason, reason, label);
  }
});

Deno.test("verifyVerificationToken: a normal session cookie is never a verification token", async () => {
  const session = await createSessionToken({
    id: "u1",
    email: "a@b.c",
    name: null,
    organizationId: "o1",
    role: "owner",
  });
  const result = await verifyVerificationToken(session, SECRET, PROJECT_ID);
  assertFalse(result.ok);
});

Deno.test("verifyVerificationToken: the session TTL is clamped to the maximum", async () => {
  const result = await verifyVerificationToken(await mint({ ttl: 86_400 }), SECRET, PROJECT_ID);
  assert(result.ok);
  assertEquals(result.claims.sessionTtlSeconds, MAX_SESSION_TTL_SECONDS);
});

Deno.test("isVerificationAccountEmail: matches only the reserved .invalid accounts", () => {
  assert(isVerificationAccountEmail(verificationAccountEmail("admin")));
  assertEquals(verificationAccountEmail("member"), verificationAccountEmail("editor"));
  assertFalse(isVerificationAccountEmail("alchemist-verify-admin@example.com"));
  assertFalse(isVerificationAccountEmail("someone@verification.invalid"));
});

// ── Route (DB) ─────────────────────────────────────────────────────────────

function buildApp() {
  return withTestServer((app) => {
    app.use("*", verificationReadOnlyGuard);
    app.route("/api/auth", authRoutes);
    app.post("/api/things", requireAuth, (c) => c.json({ wrote: true }));
    app.get("/api/things", requireAuth, (c) => c.json({ read: true }));
  });
}

function enable() {
  __setEnvForTest("ALCH_VERIFICATION_SESSION_SECRET", SECRET);
  __setEnvForTest("PROJECT_ID", PROJECT_ID);
}

function disable() {
  __deleteEnvForTest("ALCH_VERIFICATION_SESSION_SECRET");
  __deleteEnvForTest("PROJECT_ID");
}

function post(app: ReturnType<typeof buildApp>, token?: string) {
  return app.request("/api/auth/verification-session", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function cleanupVerificationRows(jtis: string[]) {
  if (jtis.length > 0) {
    await db.deleteFrom("verification_sessions").where("jti", "in", jtis).execute();
  }
}

Deno.test({
  name: "verification-session: 404 when the platform secret is not configured",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    disable();
    const res = await post(buildApp(), await mint());
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "verification-session: mints a read-only session, refuses replay, blocks writes",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    enable();
    const jti = `test${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      const app = buildApp();

      assertEquals((await post(app)).status, 401, "no bearer token");
      assertEquals((await post(app, await mint({ secret: "c".repeat(64) }))).status, 401);

      const token = await mint({ jti, role: "admin" });
      const res = await post(app, token);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Cache-Control"), "no-store");
      assertEquals(res.headers.get("Set-Cookie"), null, "the route never sets a cookie");
      const body = await res.json();
      assertEquals(body.readOnly, true);
      assertEquals(body.cookieName, "session_id");
      assertEquals(body.user.role, "admin");
      assert(isVerificationAccountEmail(body.user.email));

      // The account lives in the dedicated verification org.
      const user = await db
        .selectFrom("users")
        .innerJoin("organizations", "organizations.id", "users.organizationId")
        .select(["organizations.slug"])
        .where("users.id", "=", body.user.id)
        .executeTakeFirstOrThrow();
      assertEquals(user.slug, VERIFICATION_ORG_SLUG);

      // Audit row written, status issued.
      const audit = await db
        .selectFrom("verification_sessions")
        .select(["status", "userId", "ticketId", "runId", "role"])
        .where("jti", "=", jti)
        .executeTakeFirstOrThrow();
      assertEquals(audit.status, "issued");
      assertEquals(audit.userId, body.user.id);
      assertEquals(audit.ticketId, "job-1234");

      // Replay of the same token is refused.
      const replay = await post(app, token);
      assertEquals(replay.status, 401);
      assert((await replay.json()).error.includes("replayed"));

      // The session reads ...
      const cookie = { cookie: `session_id=${body.sessionToken}` };
      assertEquals((await app.request("/api/auth/me", { headers: cookie })).status, 200);
      assertEquals((await app.request("/api/things", { headers: cookie })).status, 200);
      // ... but never writes, and cannot renew itself into a normal session.
      const write = await app.request("/api/things", { method: "POST", headers: cookie });
      assertEquals(write.status, 403);
      const touch = await app.request("/api/auth/touch", { method: "POST", headers: cookie });
      assertEquals(touch.status, 403);
      // Logging out stays allowed.
      const logout = await app.request("/api/auth/logout", { method: "POST", headers: cookie });
      assertEquals(logout.status, 200);
    } finally {
      await cleanupVerificationRows([jti]);
      disable();
    }
  },
});

Deno.test({
  name: "verification-session: refuses the owner role and write-capable tokens",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    enable();
    try {
      const app = buildApp();
      assertEquals((await post(app, await mint({ role: "owner" }))).status, 403);
      assertEquals((await post(app, await mint({ ro: false }))).status, 401);
    } finally {
      disable();
    }
  },
});

Deno.test({
  name: "verification-session: a normal session still writes (the guard only targets vrf sessions)",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { createIsolatedUser } = await import("../helpers.ts");
    const { user, cleanup } = await createIsolatedUser("owner");
    try {
      const token = await createSessionToken({
        id: user.id,
        email: user.email,
        name: user.name,
        organizationId: user.organizationId,
        role: "owner",
      });
      const res = await buildApp().request("/api/things", {
        method: "POST",
        headers: { cookie: `session_id=${token}` },
      });
      assertEquals(res.status, 200);
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name: "send-otp refuses verification account addresses",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await buildApp().request("/api/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: verificationAccountEmail("admin") }),
    });
    assertEquals(res.status, 400);
  },
});
