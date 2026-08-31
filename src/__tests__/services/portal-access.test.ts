/**
 * Portal access -- mint, claim, revoke, re-send.
 *
 * The end-user lane's contract, stated as tests:
 *
 *   - minting AUTO-PROVISIONS a viewer account for a new address
 *   - minting NEVER downgrades an account that already exists
 *   - the emailed link is captured in the dev mailbox, so "the invite
 *     never arrived and there was no way to see why" cannot recur silently
 *   - claiming is repeatable (it is a portal, not a one-shot invite)
 *   - revoking kills the link, and a re-send retires the previous one
 *   - every read and write is org-scoped in its WHERE clause
 */

import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createIsolatedUser } from "../helpers.ts";
import { db } from "@/db/client.ts";
import {
  claimPortalAccess,
  issuePortalAccess,
  listPortalAccess,
  listPortalAccessForUser,
  PORTAL_ROLE,
  resendPortalAccess,
  revokePortalAccess,
} from "@/services/portal-access.service.ts";
import { clearCapturedEmails, lastCapturedEmail, listCapturedEmails } from "@/services/email.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}@portal.test.local`;
}

/** Portal users live outside the org cascade when they pre-existed; clean up. */
async function deleteUsers(emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  await db.deleteFrom("users").where("email", "in", emails).execute();
}

// ── Mint ──────────────────────────────────────────────────────────────────

dbTest("mint: auto-provisions a viewer account and emails the link", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("newcomer");
  try {
    clearCapturedEmails();
    const issued = await issuePortalAccess({
      organizationId: ctx.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-1",
      subjectLabel: "Jordan Ellis",
      createdByUserId: ctx.user.id,
    });

    assertEquals(issued.provisionedUser, true);
    assertEquals(issued.replacedPrevious, false);
    assertStringIncludes(issued.url, "/#/portal/claim/");
    assertStringIncludes(issued.url, issued.token);

    const provisioned = await db
      .selectFrom("users")
      .select(["role", "organizationId", "emailVerified"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    assertEquals(provisioned.role, PORTAL_ROLE);
    assertEquals(provisioned.organizationId, ctx.org.id);
    assertEquals(provisioned.emailVerified, true);

    // The link is observable. This is the whole point of the dev mailbox:
    // "the email never arrived and nobody could see why" ends here.
    const mail = lastCapturedEmail({ kind: "portal_link" });
    assertEquals(mail?.to, email);
    assertStringIncludes(mail?.text ?? "", issued.url);
    assertStringIncludes(mail?.html ?? "", "Jordan Ellis");
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("mint: NEVER downgrades an account that already exists", async () => {
  const admin = await createIsolatedUser("owner");
  const other = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    // Issue a portal link to a person who is already an owner elsewhere.
    const issued = await issuePortalAccess({
      organizationId: admin.org.id,
      email: other.user.email,
      subjectType: "employee",
      subjectId: "emp-2",
      createdByUserId: admin.user.id,
    });
    assertEquals(issued.provisionedUser, false);

    const unchanged = await db
      .selectFrom("users")
      .select(["role", "organizationId"])
      .where("id", "=", other.user.id)
      .executeTakeFirstOrThrow();
    assertEquals(unchanged.role, "owner", "an existing account must keep its role");
    assertEquals(
      unchanged.organizationId,
      other.org.id,
      "an existing account must keep its org",
    );
  } finally {
    clearCapturedEmails();
    await admin.cleanup();
    await other.cleanup();
  }
});

dbTest("mint: sendEmail=false mints a link without sending anything", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("quiet");
  try {
    clearCapturedEmails();
    const issued = await issuePortalAccess({
      organizationId: ctx.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-3",
      sendEmail: false,
    });
    assertEquals(listCapturedEmails({ kind: "portal_link" }).length, 0);
    // The link still works; the admin just delivers it themselves.
    const claimed = await claimPortalAccess(issued.token);
    assertEquals(claimed.email, email);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("mint: the portal link is AUTH-CRITICAL, so a muted org still sends it", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("muted-org");
  try {
    clearCapturedEmails();
    await db
      .updateTable("organizations")
      .set({ communicationsEnabled: false })
      .where("id", "=", ctx.org.id)
      .execute();

    await issuePortalAccess({
      organizationId: ctx.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-4",
    });

    // Suppressing this one would lock the recipient out of the portal
    // entirely, which is a lockout, not a quiet inbox.
    assertEquals(listCapturedEmails({ kind: "portal_link" }).length, 1);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

// ── Claim ─────────────────────────────────────────────────────────────────

dbTest("claim: exchanges the token for the bound identity, repeatably", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("claimer");
  try {
    const issued = await issuePortalAccess({
      organizationId: ctx.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-5",
    });

    const first = await claimPortalAccess(issued.token);
    assertEquals(first.email, email);
    assertEquals(first.organizationId, ctx.org.id);
    assertEquals(first.role, PORTAL_ROLE);
    assertEquals(first.access.subjectId, "emp-5");

    // A portal is somewhere people come BACK to. Unlike an invite, the
    // token is not consumed.
    const second = await claimPortalAccess(issued.token);
    assertEquals(second.userId, first.userId);

    const row = await db
      .selectFrom("portal_access_tokens")
      .select(["lastUsedAt"])
      .where("id", "=", issued.access.id)
      .executeTakeFirstOrThrow();
    assertNotEquals(row.lastUsedAt, null);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("claim: the raw token is never stored, only its hash", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("hashed");
  try {
    const issued = await issuePortalAccess({
      organizationId: ctx.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-6",
    });

    const row = await db
      .selectFrom("portal_access_tokens")
      .select(["tokenHash"])
      .where("id", "=", issued.access.id)
      .executeTakeFirstOrThrow();

    assertNotEquals(row.tokenHash, issued.token);
    assertEquals(row.tokenHash.length, 64, "SHA-256 hex");
    // A database read cannot mint a session.
    await assertRejects(() => claimPortalAccess(row.tokenHash));
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("claim: an unknown, revoked, or expired token all fail the same way", async () => {
  const ctx = await createIsolatedUser("owner");
  const revokedEmail = uniqueEmail("revoked");
  const expiredEmail = uniqueEmail("expired");
  try {
    await assertRejects(() => claimPortalAccess("not-a-real-token"));

    const revoked = await issuePortalAccess({
      organizationId: ctx.org.id,
      email: revokedEmail,
      subjectType: "employee",
      subjectId: "emp-7",
    });
    await revokePortalAccess({ accessId: revoked.access.id, organizationId: ctx.org.id });
    await assertRejects(() => claimPortalAccess(revoked.token));

    const expired = await issuePortalAccess({
      organizationId: ctx.org.id,
      email: expiredEmail,
      subjectType: "employee",
      subjectId: "emp-8",
    });
    await db
      .updateTable("portal_access_tokens")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("id", "=", expired.access.id)
      .execute();
    await assertRejects(() => claimPortalAccess(expired.token));
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([revokedEmail, expiredEmail]);
  }
});

// ── Revoke + re-send ──────────────────────────────────────────────────────

dbTest("revoke: is org-scoped and idempotent", async () => {
  const owner = await createIsolatedUser("owner");
  const stranger = await createIsolatedUser("owner");
  const email = uniqueEmail("scoped");
  try {
    const issued = await issuePortalAccess({
      organizationId: owner.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-9",
    });

    // Another org's admin cannot revoke it, even holding the id.
    await revokePortalAccess({ accessId: issued.access.id, organizationId: stranger.org.id });
    const stillLive = await claimPortalAccess(issued.token);
    assertEquals(stillLive.access.id, issued.access.id);

    await revokePortalAccess({ accessId: issued.access.id, organizationId: owner.org.id });
    await assertRejects(() => claimPortalAccess(issued.token));

    // Second revoke: a no-op, not an error.
    await revokePortalAccess({ accessId: issued.access.id, organizationId: owner.org.id });
  } finally {
    clearCapturedEmails();
    await owner.cleanup();
    await stranger.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("resend: issues a fresh link and retires the previous one", async () => {
  const ctx = await createIsolatedUser("owner");
  const email = uniqueEmail("resend");
  try {
    clearCapturedEmails();
    const first = await issuePortalAccess({
      organizationId: ctx.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-10",
    });

    const second = await resendPortalAccess({
      accessId: first.access.id,
      organizationId: ctx.org.id,
      subjectLabel: "Jordan Ellis",
      requestedByUserId: ctx.user.id,
    });

    assertNotEquals(second.token, first.token);
    assertEquals(second.replacedPrevious, true);

    // The old link is dead; the new one works. A forwarded copy of the
    // old URL stops working the moment an admin re-sends.
    await assertRejects(() => claimPortalAccess(first.token));
    const claimed = await claimPortalAccess(second.token);
    assertEquals(claimed.access.subjectId, "emp-10");

    // Both sends are observable.
    assertEquals(listCapturedEmails({ kind: "portal_link", to: email }).length, 2);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([email]);
  }
});

dbTest("resend: another org's id is a 404, not a cross-tenant re-issue", async () => {
  const owner = await createIsolatedUser("owner");
  const stranger = await createIsolatedUser("owner");
  const email = uniqueEmail("cross-tenant");
  try {
    const issued = await issuePortalAccess({
      organizationId: owner.org.id,
      email,
      subjectType: "employee",
      subjectId: "emp-11",
    });

    await assertRejects(() =>
      resendPortalAccess({
        accessId: issued.access.id,
        organizationId: stranger.org.id,
      })
    );
  } finally {
    clearCapturedEmails();
    await owner.cleanup();
    await stranger.cleanup();
    await deleteUsers([email]);
  }
});

// ── Reads ─────────────────────────────────────────────────────────────────

dbTest("list: admin listing is org-scoped and hides revoked links by default", async () => {
  const owner = await createIsolatedUser("owner");
  const stranger = await createIsolatedUser("owner");
  const liveEmail = uniqueEmail("live");
  const goneEmail = uniqueEmail("gone");
  try {
    const live = await issuePortalAccess({
      organizationId: owner.org.id,
      email: liveEmail,
      subjectType: "employee",
      subjectId: "emp-12",
    });
    const gone = await issuePortalAccess({
      organizationId: owner.org.id,
      email: goneEmail,
      subjectType: "employee",
      subjectId: "emp-13",
    });
    await revokePortalAccess({ accessId: gone.access.id, organizationId: owner.org.id });

    const active = await listPortalAccess({ organizationId: owner.org.id });
    assertEquals(active.length, 1);
    assertEquals(active[0].id, live.access.id);

    const all = await listPortalAccess({
      organizationId: owner.org.id,
      includeInactive: true,
    });
    assertEquals(all.length, 2);

    // A neighbouring org sees none of it.
    assertEquals(
      (await listPortalAccess({ organizationId: stranger.org.id, includeInactive: true })).length,
      0,
    );

    const narrowed = await listPortalAccess({
      organizationId: owner.org.id,
      subjectType: "employee",
      subjectId: "emp-12",
    });
    assertEquals(narrowed.length, 1);
  } finally {
    clearCapturedEmails();
    await owner.cleanup();
    await stranger.cleanup();
    await deleteUsers([liveEmail, goneEmail]);
  }
});

dbTest("me: a portal user sees only their OWN bindings", async () => {
  const ctx = await createIsolatedUser("owner");
  const mine = uniqueEmail("mine");
  const theirs = uniqueEmail("theirs");
  try {
    const a = await issuePortalAccess({
      organizationId: ctx.org.id,
      email: mine,
      subjectType: "employee",
      subjectId: "emp-14",
    });
    await issuePortalAccess({
      organizationId: ctx.org.id,
      email: theirs,
      subjectType: "employee",
      subjectId: "emp-15",
    });

    const own = await listPortalAccessForUser(a.access.userId);
    assertEquals(own.length, 1);
    assertEquals(own[0].subjectId, "emp-14");
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
    await deleteUsers([mine, theirs]);
  }
});
