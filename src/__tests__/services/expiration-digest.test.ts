/**
 * Expiring-records digest scaffold.
 *
 * The scaffold's promise is that a customer app writes one query and gets
 * scheduling, gating, a branded email, and these tests for free. So the
 * assertions are about the SCAFFOLD's contract, not about any domain:
 *
 *   - dormant with no provider registered (the default checkout state)
 *   - the digest reaches the org's owner/admins with the found records
 *   - it is ORDINARY mail: a muted org receives nothing
 *   - one org's failure does not abort the run
 *
 * Every assertion reads the dev mailbox. The scheduled job itself is not
 * started here: it returns immediately under NODE_ENV=test, and the run
 * function is the unit worth testing.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createIsolatedUser } from "../helpers.ts";
import {
  clearExpiringRecordsProvider,
  hasExpiringRecordsProvider,
  registerExpiringRecordsProvider,
  runExpirationDigest,
} from "@/services/expiration-digest.ts";
import {
  clearCapturedEmails,
  lastCapturedEmail,
  listCapturedEmails,
  setOrgCommunicationsEnabled,
  setUserCommunicationsEnabled,
} from "@/services/email.ts";

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

/** A provider that returns a fixed set of rows for any org. */
function registerFixedProvider(count = 2) {
  registerExpiringRecordsProvider({
    recordLabel: "certifications",
    findExpiring: () =>
      Promise.resolve(
        Array.from({ length: count }, (_, i) => ({
          id: `rec-${i}`,
          label: `Certification ${i}`,
          expiresAt: daysFromNow(i + 1),
          detail: `Holder ${i}`,
        })),
      ),
  });
}

dbTest("digest: dormant with no provider registered", async () => {
  clearExpiringRecordsProvider();
  clearCapturedEmails();
  assertEquals(hasExpiringRecordsProvider(), false);

  const result = await runExpirationDigest();
  assertEquals(result.skipped, "no-provider");
  assertEquals(result.emailsSent, 0);
  assertEquals(listCapturedEmails({ kind: "expiration_digest" }).length, 0);
});

dbTest("digest: sends the org's owner a digest of what it found", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    registerFixedProvider(3);

    const result = await runExpirationDigest({ organizationId: ctx.org.id, withinDays: 30 });
    assertEquals(result.orgsScanned, 1);
    assertEquals(result.orgsWithExpiring, 1);
    assertEquals(result.recordsFound, 3);
    assertEquals(result.emailsSent, 1);
    assertEquals(result.failures, 0);

    const captured = lastCapturedEmail({ kind: "expiration_digest" });
    assertEquals(captured?.to, ctx.user.email);
    assertStringIncludes(captured?.subject ?? "", "3 certifications");
    assertStringIncludes(captured?.text ?? "", "Certification 0");
    // Rendered through the shared shell, not a hand-rolled body.
    assertStringIncludes(captured?.html ?? "", "<!doctype html>");
  } finally {
    clearExpiringRecordsProvider();
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("digest: found records are ordered soonest-first", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    registerExpiringRecordsProvider({
      recordLabel: "contracts",
      findExpiring: () =>
        Promise.resolve([
          { id: "b", label: "Later contract", expiresAt: daysFromNow(20) },
          { id: "a", label: "Sooner contract", expiresAt: daysFromNow(2) },
        ]),
    });

    await runExpirationDigest({ organizationId: ctx.org.id });

    const text = lastCapturedEmail({ kind: "expiration_digest" })?.text ?? "";
    assertEquals(
      text.indexOf("Sooner contract") < text.indexOf("Later contract"),
      true,
      "the soonest expiry must lead the digest",
    );
  } finally {
    clearExpiringRecordsProvider();
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("digest: nothing expiring means no email at all", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    registerExpiringRecordsProvider({
      recordLabel: "licenses",
      findExpiring: () => Promise.resolve([]),
    });

    const result = await runExpirationDigest({ organizationId: ctx.org.id });
    assertEquals(result.orgsWithExpiring, 0);
    assertEquals(result.emailsSent, 0);
    assertEquals(listCapturedEmails({ kind: "expiration_digest" }).length, 0);
  } finally {
    clearExpiringRecordsProvider();
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("digest: it is ORDINARY mail -- a muted org receives nothing", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    registerFixedProvider(2);
    await setOrgCommunicationsEnabled(ctx.org.id, false);

    // The run still does its work and reports the send attempt; the gate
    // is what drops the message, one layer down.
    await runExpirationDigest({ organizationId: ctx.org.id });
    assertEquals(listCapturedEmails({ kind: "expiration_digest" }).length, 0);
  } finally {
    clearExpiringRecordsProvider();
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("digest: an opted-out admin is skipped", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    registerFixedProvider(1);
    await setUserCommunicationsEnabled(ctx.user.id, false);

    await runExpirationDigest({ organizationId: ctx.org.id });
    assertEquals(listCapturedEmails({ kind: "expiration_digest" }).length, 0);
  } finally {
    clearExpiringRecordsProvider();
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("digest: a throwing provider is counted, never fatal", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    registerExpiringRecordsProvider({
      recordLabel: "widgets",
      findExpiring: () => Promise.reject(new Error("domain query blew up")),
    });

    const result = await runExpirationDigest({ organizationId: ctx.org.id });
    assertEquals(result.failures, 1);
    assertEquals(result.emailsSent, 0);
  } finally {
    clearExpiringRecordsProvider();
    clearCapturedEmails();
    await ctx.cleanup();
  }
});

dbTest("digest: a custom recipients list replaces the owner/admin default", async () => {
  const ctx = await createIsolatedUser("owner");
  try {
    clearCapturedEmails();
    registerExpiringRecordsProvider({
      recordLabel: "permits",
      findExpiring: () =>
        Promise.resolve([{ id: "p1", label: "Permit 1", expiresAt: daysFromNow(4) }]),
      recipients: () => Promise.resolve([{ email: "ops-desk@test.local" }]),
    });

    await runExpirationDigest({ organizationId: ctx.org.id });

    const sent = listCapturedEmails({ kind: "expiration_digest" });
    assertEquals(sent.length, 1);
    assertEquals(sent[0].to, "ops-desk@test.local");
  } finally {
    clearExpiringRecordsProvider();
    clearCapturedEmails();
    await ctx.cleanup();
  }
});
