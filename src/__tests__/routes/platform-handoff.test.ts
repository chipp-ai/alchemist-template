/**
 * One-time sign-in handoff from Chipp (POST /api/auth/platform-handoff).
 *
 *   - a good token signs a synced member in once; a replay fails
 *   - expired, wrong project, wrong key, overlong and non-member tokens fail
 *   - `next` must be a same-origin relative path (no open redirect)
 *   - 404 without the member sync env
 * Every failure is a 303 to the login page with ?handoff=failed.
 */

import { assert, assertEquals } from "@std/assert";
import * as jose from "jose";
import { createHmac } from "node:crypto";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { db } from "@/db/client.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { resolveUser } from "@/api/middleware/auth.ts";
import { safeNextPath } from "@/api/routes/auth/platform-handoff.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
const SECRET = "f".repeat(64);
const PROJECT_ID = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";

/** The platform's key derivation, written out independently of the route. */
function key(secret = SECRET): Uint8Array {
  const hex = createHmac("sha256", new TextEncoder().encode(secret)).update("member-handoff:v1")
    .digest(
      "hex",
    );
  return new TextEncoder().encode(hex);
}

async function mint(
  opts: {
    email: string;
    sub?: string;
    secret?: string;
    iatOffset?: number;
    life?: number;
    jti?: string;
  },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0);
  return await new jose.SignJWT({ email: opts.email })
    .setProtectedHeader({ alg: "HS256", typ: "alch-handoff+jwt" })
    .setIssuer("chipp-alchemist")
    .setAudience("alchemist-member-handoff")
    .setSubject(opts.sub ?? PROJECT_ID)
    .setJti(opts.jti ?? crypto.randomUUID().replaceAll("-", ""))
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.life ?? 60))
    .sign(key(opts.secret));
}

async function handoff(token: string, next?: string): Promise<Response> {
  const body = new URLSearchParams({ token });
  if (next !== undefined) body.set("next", next);
  return await app.request("/api/auth/platform-handoff", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function assertFailed(res: Response) {
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/app/#/login?handoff=failed");
  assertEquals(res.headers.get("set-cookie"), null);
  assertEquals(res.headers.get("cache-control"), "no-store");
}

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: !HAS_DB,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      __setEnvForTest("ALCH_MEMBER_SYNC_SECRET", SECRET);
      __setEnvForTest("PROJECT_ID", PROJECT_ID);
      try {
        await fn();
      } finally {
        __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
        __deleteEnvForTest("PROJECT_ID");
      }
    },
  });
}

async function managedMember(orgId: string): Promise<{ id: string; email: string }> {
  const email = `handoff-${crypto.randomUUID().slice(0, 8)}@handoff.test.local`;
  return await db.insertInto("users")
    .values({
      email,
      name: "M",
      role: "editor",
      organizationId: orgId,
      emailVerified: true,
      managedBy: "platform",
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();
}

Deno.test({
  name: "handoff: 404 without the member sync env",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
    __setEnvForTest("PROJECT_ID", PROJECT_ID);
    try {
      assertEquals((await handoff("x")).status, 404);
    } finally {
      __deleteEnvForTest("PROJECT_ID");
    }
  },
});

dbTest("handoff: a good token signs a member in once; the replay fails", async () => {
  const org = await createIsolatedUser("owner");
  try {
    const m = await managedMember(org.org.id);
    const token = await mint({ email: m.email });

    const ok = await handoff(token, "/app/#/settings");
    assertEquals(ok.status, 303);
    assertEquals(ok.headers.get("location"), "/app/#/settings");
    assertEquals(ok.headers.get("cache-control"), "no-store");
    const session = /session_id=([^;]+)/.exec(ok.headers.get("set-cookie") ?? "")?.[1];
    assert(session);
    const payload = jose.decodeJwt(session);
    const user = await resolveUser(payload);
    assertEquals(user?.id, m.id);
    assertEquals(user?.organizationId, org.org.id);
    const row = await db.selectFrom("users").select("lastLoginAt").where("id", "=", m.id)
      .executeTakeFirst();
    assert(row?.lastLoginAt);

    assertFailed(await handoff(token));
  } finally {
    await org.cleanup();
  }
});

dbTest("handoff: expired, wrong project, wrong key and overlong tokens fail", async () => {
  const org = await createIsolatedUser("owner");
  try {
    const m = await managedMember(org.org.id);
    assertFailed(await handoff(await mint({ email: m.email, iatOffset: -200, life: 100 })));
    assertFailed(
      await handoff(await mint({ email: m.email, sub: "00000000-0000-4000-8000-000000000000" })),
    );
    assertFailed(await handoff(await mint({ email: m.email, secret: "g".repeat(64) })));
    assertFailed(await handoff(await mint({ email: m.email, life: 121 })));
    assertFailed(await handoff(await mint({ email: m.email, jti: "short" })));
    // Signed with the raw sync secret instead of the derived key.
    const raw = await new jose.SignJWT({ email: m.email })
      .setProtectedHeader({ alg: "HS256", typ: "alch-handoff+jwt" })
      .setIssuer("chipp-alchemist").setAudience("alchemist-member-handoff").setSubject(PROJECT_ID)
      .setJti(crypto.randomUUID().replaceAll("-", "")).setIssuedAt().setExpirationTime("60s")
      .sign(new TextEncoder().encode(SECRET));
    assertFailed(await handoff(raw));
    assertFailed(await handoff("not-a-jwt"));
  } finally {
    await org.cleanup();
  }
});

dbTest(
  "handoff: a non-member fails (native user, disconnected member, unknown email)",
  async () => {
    const org = await createIsolatedUser("owner");
    try {
      assertFailed(await handoff(await mint({ email: org.user.email })));
      const m = await managedMember(org.org.id);
      await db.updateTable("users").set({ organizationId: null }).where("id", "=", m.id).execute();
      assertFailed(await handoff(await mint({ email: m.email })));
      await db.deleteFrom("users").where("id", "=", m.id).execute();
      assertFailed(await handoff(await mint({ email: "nobody@handoff.test.local" })));
    } finally {
      await org.cleanup();
    }
  },
);

dbTest("handoff: an unsafe next falls back to the app home", async () => {
  const org = await createIsolatedUser("owner");
  try {
    for (
      const next of [
        "https://evil.example",
        "//evil.example",
        "/\\evil.example",
        "javascript:alert(1)",
      ]
    ) {
      const m = await managedMember(org.org.id);
      const res = await handoff(await mint({ email: m.email }), next);
      assertEquals(res.status, 303);
      assertEquals(res.headers.get("location"), "/app/#/", next);
    }
  } finally {
    await org.cleanup();
  }
});

Deno.test("handoff: safeNextPath", () => {
  assertEquals(safeNextPath("/app/#/x?y=1"), "/app/#/x?y=1");
  for (const bad of ["", "app", "//x", "/\\x", "http://x", "/\tx", "/javascript:alert(1)"]) {
    assertEquals(safeNextPath(bad), null, bad);
  }
});
