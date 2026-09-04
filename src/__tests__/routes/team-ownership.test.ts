/**
 * Ownership transfer + verify-first email change (route integration).
 *
 * These two flows exist because the owner role is otherwise a dead
 * end: the owner can't be removed, demoted, or leave, and on an
 * OTP-login app a wrong email means the next login code goes somewhere
 * the user can't read. Coverage:
 *
 *   POST /org/transfer-ownership
 *     - owner -> member succeeds; both roles swap in ONE transaction
 *     - admin gets 403 (org.transfer_ownership is owner-only)
 *     - self-transfer is 400
 *     - target outside the org is 404
 *
 *   POST /auth/me/email-change (+ /confirm)
 *     - request mints an OTP for the NEW address
 *     - taken address is 409 at request AND at confirm time
 *     - own address is 400
 *     - wrong code is 401 and burns an attempt; right code swaps the
 *       address and marks it verified
 */

import { assertEquals } from "@std/assert";
import { createIsolatedUser, getTestDb, withTestServer } from "../helpers.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
import { orgRoutes } from "@/api/routes/org/index.ts";
import { authRoutes } from "@/api/routes/auth/index.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function deno(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: !HAS_DB,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

function makeApp() {
  return withTestServer((app) => {
    app.route("/org", orgRoutes);
    app.route("/auth", authRoutes);
  });
}

async function cookieFor(user: {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}): Promise<string> {
  const token = await createSessionToken(user);
  return `session_id=${token}`;
}

/** Second user in the SAME org (createIsolatedUser always makes a fresh org). */
async function addMember(
  organizationId: string,
  role: "admin" | "editor" | "viewer",
) {
  const db = getTestDb();
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const row = await db
    .insertInto("users")
    .values({
      email: `member-${suffix}@test.local`,
      name: `Member ${suffix}`,
      role,
      organizationId,
      emailVerified: true,
    })
    .returning(["id", "email", "name", "role", "organizationId"])
    .executeTakeFirstOrThrow();
  // Inserted non-null above; narrow the nullable Selectable shape (same
  // narrowing createIsolatedUser does in helpers.ts).
  return { ...row, organizationId: row.organizationId as string };
}

// ── Transfer ownership ────────────────────────────────────────────────────

deno("transfer-ownership: owner hands off; both roles swap", async () => {
  const { user: owner, cleanup } = await createIsolatedUser("owner");
  try {
    const member = await addMember(owner.organizationId, "editor");
    const app = makeApp();

    const res = await app.request("/org/transfer-ownership", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: await cookieFor({ ...owner, role: "owner" }),
      },
      body: JSON.stringify({ userId: member.id }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.newOwnerId, member.id);
    assertEquals(body.data.previousOwnerId, owner.id);

    const db = getTestDb();
    const rows = await db
      .selectFrom("users")
      .select(["id", "role"])
      .where("organizationId", "=", owner.organizationId)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r.role]));
    assertEquals(byId.get(member.id), "owner");
    assertEquals(byId.get(owner.id), "admin");
  } finally {
    await cleanup();
  }
});

deno("transfer-ownership: admin gets 403 (owner-only capability)", async () => {
  const { user: owner, cleanup } = await createIsolatedUser("owner");
  try {
    const admin = await addMember(owner.organizationId, "admin");
    const editor = await addMember(owner.organizationId, "editor");
    const app = makeApp();

    const res = await app.request("/org/transfer-ownership", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: await cookieFor({ ...admin, role: "admin" }),
      },
      body: JSON.stringify({ userId: editor.id }),
    });
    assertEquals(res.status, 403);

    // Nothing moved.
    const db = getTestDb();
    const ownerRow = await db
      .selectFrom("users")
      .select("role")
      .where("id", "=", owner.id)
      .executeTakeFirstOrThrow();
    assertEquals(ownerRow.role, "owner");
  } finally {
    await cleanup();
  }
});

deno("transfer-ownership: self-transfer is 400", async () => {
  const { user: owner, cleanup } = await createIsolatedUser("owner");
  try {
    const app = makeApp();
    const res = await app.request("/org/transfer-ownership", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: await cookieFor({ ...owner, role: "owner" }),
      },
      body: JSON.stringify({ userId: owner.id }),
    });
    assertEquals(res.status, 400);
  } finally {
    await cleanup();
  }
});

deno("transfer-ownership: target outside the org is 404", async () => {
  const { user: owner, cleanup } = await createIsolatedUser("owner");
  const { user: outsider, cleanup: cleanup2 } = await createIsolatedUser("editor");
  try {
    const app = makeApp();
    const res = await app.request("/org/transfer-ownership", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: await cookieFor({ ...owner, role: "owner" }),
      },
      body: JSON.stringify({ userId: outsider.id }),
    });
    assertEquals(res.status, 404);
  } finally {
    await cleanup();
    await cleanup2();
  }
});

// ── Email change ──────────────────────────────────────────────────────────

deno("email-change: request mints an OTP; confirm swaps the address", async () => {
  const { user, cleanup } = await createIsolatedUser("owner");
  try {
    const app = makeApp();
    const cookie = await cookieFor({ ...user, role: "owner" });
    const newEmail = `changed-${Date.now().toString(36)}@test.local`;

    const req = await app.request("/auth/me/email-change", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: newEmail }),
    });
    assertEquals(req.status, 200);

    const db = getTestDb();
    const otp = await db
      .selectFrom("otps")
      .selectAll()
      .where("email", "=", newEmail)
      .executeTakeFirstOrThrow();

    // Wrong code burns an attempt without changing anything.
    const bad = await app.request("/auth/me/email-change/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        email: newEmail,
        otpCode: otp.otpCode === "000000" ? "000001" : "000000",
      }),
    });
    assertEquals(bad.status, 401);

    const good = await app.request("/auth/me/email-change/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: newEmail, otpCode: otp.otpCode }),
    });
    assertEquals(good.status, 200);

    const row = await db
      .selectFrom("users")
      .select(["email", "emailVerified"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    assertEquals(row.email, newEmail);
    assertEquals(row.emailVerified, true);

    // The consumed OTP is gone: the code can't be replayed.
    const leftover = await db
      .selectFrom("otps")
      .select("id")
      .where("email", "=", newEmail)
      .executeTakeFirst();
    assertEquals(leftover, undefined);
  } finally {
    await cleanup();
  }
});

deno("email-change: own address is 400, taken address is 409", async () => {
  const { user, cleanup } = await createIsolatedUser("owner");
  try {
    const other = await addMember(user.organizationId, "viewer");
    const app = makeApp();
    const cookie = await cookieFor({ ...user, role: "owner" });

    const own = await app.request("/auth/me/email-change", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: user.email }),
    });
    assertEquals(own.status, 400);

    const taken = await app.request("/auth/me/email-change", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: other.email }),
    });
    assertEquals(taken.status, 409);
    const body = await taken.json();
    assertEquals(body.code, "EMAIL_IN_USE");
  } finally {
    await cleanup();
  }
});

deno("email-change: address claimed between request and confirm is 409", async () => {
  const { user, cleanup } = await createIsolatedUser("owner");
  try {
    const app = makeApp();
    const cookie = await cookieFor({ ...user, role: "owner" });
    const newEmail = `raced-${Date.now().toString(36)}@test.local`;

    const req = await app.request("/auth/me/email-change", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: newEmail }),
    });
    assertEquals(req.status, 200);

    const db = getTestDb();
    const otp = await db
      .selectFrom("otps")
      .selectAll()
      .where("email", "=", newEmail)
      .executeTakeFirstOrThrow();

    // Someone signs up with the address before the confirm lands.
    await db
      .insertInto("users")
      .values({
        email: newEmail,
        name: "Racer",
        role: "owner",
        organizationId: user.organizationId,
        emailVerified: true,
      })
      .execute();

    const res = await app.request("/auth/me/email-change/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: newEmail, otpCode: otp.otpCode }),
    });
    assertEquals(res.status, 409);

    // The caller's address is unchanged.
    const row = await db
      .selectFrom("users")
      .select("email")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    assertEquals(row.email, user.email);
  } finally {
    await cleanup();
  }
});
