/**
 * Communications gate -- suppression, the auth-critical bypass, and the
 * test-send bypass.
 *
 * The ordering here is the whole feature. A customer project shipped a
 * comms toggle that also blocked its own "send test email" button, so the
 * one path an admin uses to prove delivery failed exactly when they needed
 * it. These tests pin all three rules:
 *
 *   ordinary mail   -> suppressed by the org toggle OR the user preference
 *   auth-critical   -> never suppressed by either
 *   test send       -> never suppressed, and marked [TEST]
 *
 * Assertions read the dev mailbox. A suppressed message is ABSENT from it,
 * which is the cleanest possible statement of "we did not send that".
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createIsolatedUser } from "../helpers.ts";
import { db } from "@/db/client.ts";
import {
  checkCommunicationsSuppression,
  clearCapturedEmails,
  getUserCommunicationsEnabled,
  lastCapturedEmail,
  listCapturedEmails,
  sendEmail,
  sendTestEmail,
  setOrgCommunicationsEnabled,
  setUserCommunicationsEnabled,
  TEST_EMAIL_SUBJECT_PREFIX,
  userWantsCommunications,
} from "@/services/email.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

function pureTest(name: string, fn: () => void) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

/** Ordinary (non-auth-critical) send used by the suppression cases. */
function sendOrdinary(to: string, organizationId?: string) {
  return sendEmail({
    to,
    organizationId,
    kind: "unit_ordinary",
    subject: "Ordinary notification",
    text: "Ordinary notification",
  });
}

// ── Preference parsing (no DB) ────────────────────────────────────────────

pureTest("preference: absent, null, or malformed reads as opted IN", () => {
  assertEquals(userWantsCommunications({}), true);
  assertEquals(userWantsCommunications(null), true);
  assertEquals(userWantsCommunications(undefined), true);
  assertEquals(userWantsCommunications("not json"), true);
  assertEquals(userWantsCommunications({ communicationsEnabled: true }), true);
  // Only the literal false mutes. A truthy-but-odd value never silently
  // silences someone.
  assertEquals(userWantsCommunications({ communicationsEnabled: 0 }), true);
  assertEquals(userWantsCommunications({ communicationsEnabled: false }), false);
  // A JSONB column read back as a string still parses.
  assertEquals(userWantsCommunications('{"communicationsEnabled":false}'), false);
});

// ── Org master toggle ─────────────────────────────────────────────────────

dbTest("gate: org toggle OFF suppresses ordinary mail", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    await setOrgCommunicationsEnabled(ctx.org.id, false);

    const check = await checkCommunicationsSuppression({
      to: ctx.user.email,
      organizationId: ctx.org.id,
    });
    assertEquals(check.suppressed, true);
    assertEquals(check.reason, "org_disabled");

    await sendOrdinary(ctx.user.email, ctx.org.id);
    assertEquals(listCapturedEmails({ kind: "unit_ordinary" }).length, 0);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("gate: org toggle ON (the default) lets ordinary mail through", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    // Never touched -- the column default must be ON, or every existing
    // org goes silent the moment the migration lands.
    const check = await checkCommunicationsSuppression({
      to: ctx.user.email,
      organizationId: ctx.org.id,
    });
    assertEquals(check.suppressed, false);

    await sendOrdinary(ctx.user.email, ctx.org.id);
    assertEquals(listCapturedEmails({ kind: "unit_ordinary" }).length, 1);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("gate: the recipient's own org applies when the caller passes none", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    await setOrgCommunicationsEnabled(ctx.org.id, false);

    // No organizationId argument: the gate resolves it from the recipient.
    await sendOrdinary(ctx.user.email);
    assertEquals(listCapturedEmails({ kind: "unit_ordinary" }).length, 0);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

// ── Per-user preference ───────────────────────────────────────────────────

dbTest("gate: per-user opt-out suppresses ordinary mail to that user only", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    assertEquals(await getUserCommunicationsEnabled(ctx.user.id), true);
    await setUserCommunicationsEnabled(ctx.user.id, false);
    assertEquals(await getUserCommunicationsEnabled(ctx.user.id), false);

    await sendOrdinary(ctx.user.email, ctx.org.id);
    assertEquals(listCapturedEmails({ kind: "unit_ordinary" }).length, 0);

    // A different address in the same org is unaffected.
    await sendOrdinary(`bystander-${ctx.org.slug}@test.local`, ctx.org.id);
    assertEquals(listCapturedEmails({ kind: "unit_ordinary" }).length, 1);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("preference write MERGES -- it never clobbers other preferences", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    await db
      .updateTable("users")
      .set({ preferences: { timezone: "America/Chicago", theme: "dark" } })
      .where("id", "=", ctx.user.id)
      .execute();

    await setUserCommunicationsEnabled(ctx.user.id, false);

    const row = await db
      .selectFrom("users")
      .select(["preferences"])
      .where("id", "=", ctx.user.id)
      .executeTakeFirstOrThrow();
    const prefs = row.preferences as Record<string, unknown>;
    assertEquals(prefs.timezone, "America/Chicago");
    assertEquals(prefs.theme, "dark");
    assertEquals(prefs.communicationsEnabled, false);
  } finally {
    await ctx.cleanup();
  }
});

// ── Auth-critical bypass ──────────────────────────────────────────────────

dbTest("bypass: auth-critical mail ignores BOTH switches", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    await setOrgCommunicationsEnabled(ctx.org.id, false);
    await setUserCommunicationsEnabled(ctx.user.id, false);

    // Belt and braces: the OTP kind, and a raw auth-critical send.
    await sendEmail({
      to: ctx.user.email,
      organizationId: ctx.org.id,
      kind: "unit_auth_critical",
      authCritical: true,
      subject: "Your sign-in code",
      text: "123456",
    });

    assertEquals(listCapturedEmails({ kind: "unit_auth_critical" }).length, 1);
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

// ── Test-send bypass ──────────────────────────────────────────────────────

dbTest("bypass: sendTestEmail delivers through a fully muted org", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    await setOrgCommunicationsEnabled(ctx.org.id, false);
    await setUserCommunicationsEnabled(ctx.user.id, false);

    // expiration_digest is ORDINARY mail -- suppressed on the normal path,
    // delivered here. That contrast is the regression this test guards.
    const rendered = await sendTestEmail({
      kind: "expiration_digest",
      to: ctx.user.email,
      organizationId: ctx.org.id,
    });

    const captured = lastCapturedEmail({ kind: "expiration_digest" });
    assertEquals(captured?.to, ctx.user.email);
    assertStringIncludes(captured?.subject ?? "", TEST_EMAIL_SUBJECT_PREFIX);
    assertStringIncludes(rendered.subject, TEST_EMAIL_SUBJECT_PREFIX);
    // Sample data, not an empty shell.
    assertStringIncludes(captured?.html ?? "", "Sample record A");
  } finally {
    clearCapturedEmails();
    await ctx.cleanup();
  }
});
