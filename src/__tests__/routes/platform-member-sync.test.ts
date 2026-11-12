/**
 * Platform member sync (`POST /api/platform/member-sync`).
 *
 * The Chipp platform sends the full desired set of platform-managed
 * members, HMAC-signed with ALCH_MEMBER_SYNC_SECRET. These tests drive the
 * real app.ts mount and pin:
 *   - the route is absent (404) without its env, and refuses an unsigned,
 *     wrongly signed or stale delivery (401) and another project's (403)
 *   - create, update, demote, disconnect and re-attach of managed rows
 *   - app-native rows are never touched (skipped as "app_account")
 *   - the owner slot: a native owner keeps it; otherwise one platform owner
 *   - a replayed or older seq is ignored
 *   - a role change applies on the next request (resolveUser reads it)
 *   - OTP sign-in lands a managed user in the synced org and role, and a
 *     disconnected managed user gets no session
 *   - the app refuses to change a managed row (role, remove, invite)
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { app } from "../../../app.ts";
import { createIsolatedUser } from "../helpers.ts";
import { db } from "@/db/client.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { signEventBody } from "@/lib/event-signing.ts";
import { createSessionToken, resolveUser } from "@/api/middleware/auth.ts";
import { verificationAccountEmail } from "@/lib/verification-accounts.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
const SECRET = "c".repeat(64);
const PROJECT_ID = "9b2f8f0e-1c1d-4b7a-9f00-0123456789ab";

let seqCounter = Date.now();
function nextSeq(): number {
  seqCounter += 1000;
  return seqCounter;
}

function withEnv(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    __setEnvForTest("ALCH_MEMBER_SYNC_SECRET", SECRET);
    __setEnvForTest("PROJECT_ID", PROJECT_ID);
    try {
      await fn();
    } finally {
      __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
      __deleteEnvForTest("PROJECT_ID");
      // Managed rows that were disconnected have no org to cascade from.
      await db.deleteFrom("users").where("managedBy", "=", "platform").execute();
    }
  };
}

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn: withEnv(fn) });
}

interface Member {
  email: string;
  name: string | null;
  role: "owner" | "editor" | "viewer";
}

async function deliver(
  body: { projectId?: string; seq?: number; members: Member[] },
  opts: { secret?: string; timestamp?: number; signature?: string | null } = {},
): Promise<Response> {
  const raw = JSON.stringify({
    projectId: body.projectId ?? PROJECT_ID,
    seq: body.seq ?? nextSeq(),
    members: body.members,
  });
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Event-Timestamp": String(ts),
  };
  if (opts.signature !== null) {
    headers["X-Event-Signature"] = opts.signature ?? signEventBody(opts.secret ?? SECRET, ts, raw);
  }
  return await app.request("/api/platform/member-sync", { method: "POST", headers, body: raw });
}

function uniqueEmail(tag: string): string {
  return `${tag}-${crypto.randomUUID().slice(0, 8)}@member-sync.test.local`;
}

async function userByEmail(email: string) {
  return await db
    .selectFrom("users")
    .select(["id", "email", "name", "role", "organizationId", "managedBy", "tokenInvalidatedBefore"])
    .where("email", "=", email)
    .executeTakeFirst();
}

// ── Gate ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "member sync: 404 without the secret or PROJECT_ID, and with a short secret",
  ignore: !HAS_DB,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
    __setEnvForTest("PROJECT_ID", PROJECT_ID);
    try {
      assertEquals((await deliver({ members: [] })).status, 404);
      __setEnvForTest("ALCH_MEMBER_SYNC_SECRET", "short-secret");
      assertEquals((await deliver({ members: [] }, { secret: "short-secret" })).status, 404);
      __setEnvForTest("ALCH_MEMBER_SYNC_SECRET", SECRET);
      __deleteEnvForTest("PROJECT_ID");
      assertEquals((await deliver({ members: [] })).status, 404);
    } finally {
      __deleteEnvForTest("ALCH_MEMBER_SYNC_SECRET");
      __deleteEnvForTest("PROJECT_ID");
    }
  },
});

dbTest("member sync: a signature is required, must match, and must be fresh", async () => {
  const members = [{ email: uniqueEmail("nosig"), name: null, role: "viewer" as const }];
  assertEquals((await deliver({ members }, { signature: null })).status, 401);
  assertEquals((await deliver({ members }, { secret: "d".repeat(64) })).status, 401);
  assertEquals((await deliver({ members }, { signature: "v1=" + "0".repeat(64) })).status, 401);
  const stale = Math.floor(Date.now() / 1000) - 301;
  assertEquals((await deliver({ members }, { timestamp: stale })).status, 401);
  // Nothing was written by any refused delivery.
  assertEquals(await userByEmail(members[0].email), undefined);
});

dbTest("member sync: another project's delivery is 403", async () => {
  const members = [{ email: uniqueEmail("other"), name: null, role: "viewer" as const }];
  const res = await deliver({ projectId: "00000000-0000-4000-8000-000000000000", members });
  assertEquals(res.status, 403);
  assertEquals(await userByEmail(members[0].email), undefined);
});

dbTest("member sync: a body with one email twice is 400", async () => {
  const email = uniqueEmail("dup");
  const res = await deliver({
    members: [{ email, name: null, role: "viewer" }, { email: email.toUpperCase(), name: null, role: "editor" }],
  });
  assertEquals(res.status, 400);
});

// ── Reconcile ───────────────────────────────────────────────────────────────

dbTest("member sync: creates, updates, demotes, disconnects and re-attaches managed rows; native rows untouched", async () => {
  // The platform owner already uses the app (a native owner): that org is the target.
  const owner = await createIsolatedUser("owner");
  const nativeEditor = await db
    .insertInto("users")
    .values({
      email: uniqueEmail("native-editor"),
      name: "Native Editor",
      role: "editor",
      organizationId: owner.org.id,
      emailVerified: true,
    })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();
  try {
    const a = uniqueEmail("a");
    const b = uniqueEmail("b");
    const c = uniqueEmail("c");

    const res1 = await deliver({
      members: [
        { email: owner.user.email, name: "Owner", role: "owner" },
        { email: a, name: "Alice", role: "owner" },
        { email: b, name: "Bob", role: "editor" },
        { email: c, name: null, role: "viewer" },
      ],
    });
    assertEquals(res1.status, 200);
    const body1 = await res1.json();
    assertEquals(body1.ok, true);
    assertEquals(body1.applied, true);
    assertEquals(body1.orgId, owner.org.id);
    assertEquals(body1.created, 3);
    assertEquals(body1.updated, 0);
    assertEquals(body1.disconnected, 0);
    assertEquals(body1.skipped, [{ email: owner.user.email, reason: "app_account" }]);

    const ua = await userByEmail(a);
    const ub = await userByEmail(b);
    const uc = await userByEmail(c);
    assertExists(ua);
    assertExists(ub);
    assertExists(uc);
    // The native owner keeps the owner slot: a platform owner becomes admin.
    assertEquals(ua.role, "admin");
    assertEquals(ub.role, "editor");
    assertEquals(uc.role, "viewer");
    for (const u of [ua, ub, uc]) {
      assertEquals(u.managedBy, "platform");
      assertEquals(u.organizationId, owner.org.id);
    }
    assertEquals(uc.name, c.split("@")[0]);

    // The native rows are untouched.
    const ownerRow = await userByEmail(owner.user.email);
    assertEquals(ownerRow?.role, "owner");
    assertEquals(ownerRow?.managedBy, null);
    assertEquals((await userByEmail(nativeEditor.email))?.role, "editor");

    // A session minted before the change sees the new role on its next request.
    const bSession = { sub: ub.id, iat: Math.floor(Date.now() / 1000) - 60 };
    assertEquals((await resolveUser(bSession))?.role, "editor");

    // Second delivery: rename a, demote b, drop c.
    const res2 = await deliver({
      members: [
        { email: owner.user.email, name: "Owner", role: "owner" },
        { email: a, name: "Alice Smith", role: "owner" },
        { email: b, name: "Bob", role: "viewer" },
      ],
    });
    const body2 = await res2.json();
    assertEquals(body2.applied, true);
    assertEquals(body2.created, 0);
    assertEquals(body2.updated, 2);
    assertEquals(body2.disconnected, 1);
    assertEquals((await userByEmail(a))?.name, "Alice Smith");
    assertEquals((await userByEmail(b))?.role, "viewer");
    assertEquals((await resolveUser(bSession))?.role, "viewer");
    const ucGone = await userByEmail(c);
    assertEquals(ucGone?.organizationId, null);
    assertEquals(ucGone?.role, "viewer");
    assertExists(ucGone?.tokenInvalidatedBefore);
    assertEquals(await resolveUser({ sub: uc.id, iat: Math.floor(Date.now() / 1000) - 60 }), null);
    // The native editor was not in the desired set and is still attached.
    assertEquals((await userByEmail(nativeEditor.email))?.organizationId, owner.org.id);

    // The same body again changes nothing.
    const res3 = await deliver({
      members: [
        { email: owner.user.email, name: "Owner", role: "owner" },
        { email: a, name: "Alice Smith", role: "owner" },
        { email: b, name: "Bob", role: "viewer" },
      ],
    });
    const body3 = await res3.json();
    assertEquals([body3.created, body3.updated, body3.disconnected], [0, 0, 0]);

    // Listing c again re-attaches the same row.
    const res4 = await deliver({
      members: [
        { email: a, name: "Alice Smith", role: "owner" },
        { email: b, name: "Bob", role: "viewer" },
        { email: c, name: null, role: "editor" },
      ],
    });
    const body4 = await res4.json();
    assertEquals(body4.orgId, owner.org.id);
    assertEquals(body4.created, 0);
    assertEquals(body4.updated, 1);
    const ucBack = await userByEmail(c);
    assertEquals(ucBack?.id, uc.id);
    assertEquals(ucBack?.organizationId, owner.org.id);
    assertEquals(ucBack?.role, "editor");
  } finally {
    await owner.cleanup();
  }
});

dbTest("member sync: with no native owner, one platform owner becomes the owner", async () => {
  // A native editor whose email the platform lists as an owner picks the org.
  const editor = await createIsolatedUser("editor");
  try {
    const x = uniqueEmail("x");
    const y = uniqueEmail("y");
    const res = await deliver({
      members: [
        { email: editor.user.email, name: null, role: "owner" },
        { email: x, name: "X", role: "owner" },
        { email: y, name: "Y", role: "owner" },
      ],
    });
    const body = await res.json();
    assertEquals(body.orgId, editor.org.id);
    assertEquals((await userByEmail(x))?.role, "owner");
    assertEquals((await userByEmail(y))?.role, "admin");
    assertEquals((await userByEmail(editor.user.email))?.role, "editor");

    // The sitting managed owner keeps the slot on the next delivery even
    // when the order changes.
    await deliver({
      members: [
        { email: y, name: "Y", role: "owner" },
        { email: x, name: "X", role: "owner" },
      ],
    });
    assertEquals((await userByEmail(x))?.role, "owner");
    assertEquals((await userByEmail(y))?.role, "admin");

    // Demoting x hands the slot to y.
    await deliver({
      members: [
        { email: y, name: "Y", role: "owner" },
        { email: x, name: "X", role: "editor" },
      ],
    });
    assertEquals((await userByEmail(x))?.role, "editor");
    assertEquals((await userByEmail(y))?.role, "owner");
  } finally {
    await editor.cleanup();
  }
});

dbTest("member sync: a replayed or older seq is ignored", async () => {
  const owner = await createIsolatedUser("owner");
  try {
    const m = uniqueEmail("replay");
    const seq = nextSeq();
    const first = await deliver({
      seq,
      members: [{ email: owner.user.email, name: null, role: "owner" }, { email: m, name: null, role: "editor" }],
    });
    assertEquals((await first.json()).applied, true);

    const replay = await deliver({
      seq,
      members: [{ email: owner.user.email, name: null, role: "owner" }],
    });
    assertEquals(replay.status, 200);
    const replayBody = await replay.json();
    assertEquals(replayBody.applied, false);
    assertEquals(replayBody.reason, "stale_seq");
    const older = await deliver({ seq: seq - 1, members: [] });
    assertEquals((await older.json()).applied, false);

    // Neither ignored delivery disconnected m.
    assertEquals((await userByEmail(m))?.organizationId, owner.org.id);
  } finally {
    await owner.cleanup();
  }
});

dbTest("member sync: verification account addresses are skipped as reserved", async () => {
  const owner = await createIsolatedUser("owner");
  try {
    const reserved = verificationAccountEmail("admin");
    const res = await deliver({
      members: [{ email: owner.user.email, name: null, role: "owner" }, { email: reserved, name: null, role: "editor" }],
    });
    const body = await res.json();
    assert(body.skipped.some((s: { email: string; reason: string }) => s.email === reserved && s.reason === "reserved"));
    assertEquals((await userByEmail(reserved))?.managedBy ?? null, null);
  } finally {
    await owner.cleanup();
  }
});

// ── Sign-in and app-side guards ─────────────────────────────────────────────

async function verifyOtpAs(email: string): Promise<Response> {
  await db.deleteFrom("otps").where("email", "=", email).execute();
  await db
    .insertInto("otps")
    .values({ email, otpCode: "246810", expiresAt: new Date(Date.now() + 5 * 60_000) })
    .execute();
  return await app.request("/api/auth/verify-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, otpCode: "246810" }),
  });
}

dbTest("member sync: OTP sign-in lands a managed user in the synced org; a disconnected one gets no session", async () => {
  const owner = await createIsolatedUser("owner");
  try {
    const m = uniqueEmail("otp");
    const gone = uniqueEmail("otp-gone");
    await deliver({
      members: [
        { email: owner.user.email, name: null, role: "owner" },
        { email: m, name: "M", role: "editor" },
        { email: gone, name: "G", role: "viewer" },
      ],
    });
    await deliver({
      members: [{ email: owner.user.email, name: null, role: "owner" }, { email: m, name: "M", role: "editor" }],
    });

    const ok = await verifyOtpAs(m);
    assertEquals(ok.status, 200);
    const okBody = await ok.json();
    assertEquals(okBody.organization?.id, owner.org.id);
    const cookie = ok.headers.get("set-cookie") ?? "";
    const token = /session_id=([^;]+)/.exec(cookie)?.[1];
    assertExists(token);
    const me = await app.request("/api/auth/me", { headers: { cookie: `session_id=${token}` } });
    assertEquals(me.status, 200);
    const meUser = await resolveUser({ sub: okBody.user.id, iat: Math.floor(Date.now() / 1000) });
    assertEquals(meUser?.organizationId, owner.org.id);
    assertEquals(meUser?.role, "editor");

    const refused = await verifyOtpAs(gone);
    assertEquals(refused.status, 403);
    assertEquals(refused.headers.get("set-cookie"), null);
  } finally {
    await owner.cleanup();
  }
});

dbTest("member sync: the app refuses to change, remove or invite a managed member", async () => {
  const owner = await createIsolatedUser("owner");
  try {
    const m = uniqueEmail("guard");
    await deliver({
      members: [{ email: owner.user.email, name: null, role: "owner" }, { email: m, name: null, role: "editor" }],
    });
    const managed = await userByEmail(m);
    assertExists(managed);
    const cookie = `session_id=${await createSessionToken({ ...owner.user, role: "owner" })}`;
    const headers = { "content-type": "application/json", cookie };

    const role = await app.request(`/api/org/members/${managed.id}/role`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role: "viewer" }),
    });
    assertEquals(role.status, 403);
    const remove = await app.request(`/api/org/members/${managed.id}`, { method: "DELETE", headers });
    assertEquals(remove.status, 403);
    const transfer = await app.request(`/api/org/transfer-ownership`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: managed.id }),
    });
    assertEquals(transfer.status, 403);
    assertEquals((await userByEmail(m))?.role, "editor");

    // The members list marks the managed row.
    const list = await app.request(`/api/org/members`, { headers });
    const rows = (await list.json()).data as Array<{ id: string; managedBy: string | null }>;
    assertEquals(rows.find((r) => r.id === managed.id)?.managedBy, "platform");
    assertEquals(rows.find((r) => r.id === owner.user.id)?.managedBy, null);

    // An invite in another org cannot pull the managed account away.
    const other = await createIsolatedUser("owner");
    try {
      const otherCookie = `session_id=${await createSessionToken({ ...other.user, role: "owner" })}`;
      const invite = await app.request(`/api/org/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: otherCookie },
        body: JSON.stringify({ email: m, role: "editor" }),
      });
      assertEquals(invite.status, 403);
    } finally {
      await other.cleanup();
    }
  } finally {
    await owner.cleanup();
  }
});
