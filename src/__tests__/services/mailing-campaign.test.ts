/**
 * Campaigns (src/services/mailing/campaign.service.ts) against a real
 * database: the sender check, the warm-up ramp and its thresholds, hygiene
 * at the first send, provider feedback, and one-click unsubscribe.
 *
 * Other test files share this database, so every assertion reads THIS
 * test's campaign or addresses, never a global count, and every address is
 * unique to the test.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createIsolatedUser, dbTest, getTestDb } from "../helpers.ts";
import type { EmailContactOrigin } from "@/db/schema.ts";
import {
  _internalsForTest as senderSeam,
  addManualContact,
  addSignupContact,
  advanceCampaigns,
  campaignReport,
  campaignSource,
  cancelCampaign,
  createCampaign,
  recordProviderFeedback,
  resumeCampaign,
  SenderDomainRequiredError,
  startCampaign,
  unsubscribe,
  WARMUP_BATCH_INTERVAL_MS,
  WARMUP_BATCH_SIZES,
} from "@/services/mailing/index.ts";
import { checkCommunicationsSuppression } from "@/services/communications.service.ts";

const db = getTestDb();

const OWN_DOMAIN = () => ({
  fromEmail: "news@mail.yourbrand.com",
  platformEmailFrom: "noreply@chipp.ai",
  smtpConfigured: true,
});
const SHARED = () => ({
  fromEmail: "noreply@chipp.ai",
  platformEmailFrom: "noreply@chipp.ai",
  smtpConfigured: true,
});

function useSender(inputs: () => ReturnType<typeof OWN_DOMAIN>) {
  senderSeam.inputs = inputs;
}

const run = crypto.randomUUID().slice(0, 8);
let seq = 0;
/** A unique, hygiene-clean address on a real-looking domain. */
function addr(tag: string): string {
  seq++;
  return `${tag}.${run}.${seq}@inbox-${run}.com`;
}

async function seedContacts(
  organizationId: string,
  n: number,
  origin: EmailContactOrigin,
  tag = origin,
): Promise<string[]> {
  const emails = Array.from({ length: n }, () => addr(tag));
  for (let i = 0; i < emails.length; i += 500) {
    await db
      .insertInto("email_contacts")
      .values(emails.slice(i, i + 500).map((email) => ({ organizationId, email, origin })))
      .execute();
  }
  return emails;
}

async function draft(organizationId: string) {
  return await createCampaign({
    organizationId,
    userId: null,
    name: `Test ${run}`,
    subject: "Our November news",
    text: "Hello from the test.",
    html: "<p>Hello from the test.</p>",
  });
}

async function outboxFor(campaignId: string) {
  return await db
    .selectFrom("email_outbox")
    .selectAll()
    .where("source", "=", campaignSource(campaignId))
    .execute();
}

dbTest(
  "campaign: blocked on the shared platform sender, transactional mail unaffected",
  async () => {
    const { org, cleanup } = await createIsolatedUser("owner");
    try {
      useSender(SHARED);
      await seedContacts(org.id, 3, "signup");
      const c = await draft(org.id);
      const err = await assertRejects(
        () => startCampaign({ id: c.id, organizationId: org.id }),
        SenderDomainRequiredError,
      );
      assertEquals(err.statusCode, 409);
      assertEquals(err.code, "SENDER_DOMAIN_REQUIRED");
      assertStringIncludes(err.message, "noreply@chipp.ai");
      assertStringIncludes(err.message, "verify a sending domain");
      // Scheduling is checked too, at press time.
      await assertRejects(
        () =>
          startCampaign({
            id: c.id,
            organizationId: org.id,
            sendAt: new Date(Date.now() + 3600_000),
          }),
        SenderDomainRequiredError,
      );
      const report = await campaignReport({ id: c.id, organizationId: org.id });
      assertEquals(report.campaign.status, "draft");
      assertEquals(report.counts.total, 0);
    } finally {
      useSender(OWN_DOMAIN);
      await cleanup();
    }
  },
);

dbTest("campaign: a scheduled campaign pauses if the sender is shared when it fires", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    useSender(OWN_DOMAIN);
    await seedContacts(org.id, 2, "signup");
    const c = await draft(org.id);
    const now = new Date();
    const at = new Date(now.getTime() + 60_000);
    const scheduled = await startCampaign({ id: c.id, organizationId: org.id, sendAt: at, now });
    assertEquals(scheduled.status, "scheduled");

    useSender(SHARED);
    await advanceCampaigns({ now: new Date(at.getTime() + 1000) });
    const report = await campaignReport({ id: c.id, organizationId: org.id });
    assertEquals(report.campaign.status, "paused");
    assertStringIncludes(report.campaign.pausedReason ?? "", "Settings, go to Emails");
    assertEquals((await outboxFor(c.id)).length, 0);
  } finally {
    useSender(OWN_DOMAIN);
    await cleanup();
  }
});

dbTest("campaign: signups go at once, imported contacts ramp in batches", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    useSender(OWN_DOMAIN);
    await seedContacts(org.id, 10, "signup");
    await seedContacts(org.id, 300, "import");
    const c = await draft(org.id);
    const t0 = new Date();
    await startCampaign({ id: c.id, organizationId: org.id, now: t0 });

    await advanceCampaigns({ now: t0 });
    let r = await campaignReport({ id: c.id, organizationId: org.id });
    assertEquals(r.counts.queued, 10 + WARMUP_BATCH_SIZES[0]);
    assertEquals(r.counts.coldPending, 300 - WARMUP_BATCH_SIZES[0]);
    assertEquals(r.campaign.status, "sending");

    // Same tick again: the next cold batch waits for the interval.
    await advanceCampaigns({ now: new Date(t0.getTime() + 60_000) });
    r = await campaignReport({ id: c.id, organizationId: org.id });
    assertEquals(r.counts.queued, 10 + WARMUP_BATCH_SIZES[0]);

    const t1 = new Date(t0.getTime() + WARMUP_BATCH_INTERVAL_MS);
    await advanceCampaigns({ now: t1 });
    r = await campaignReport({ id: c.id, organizationId: org.id });
    assertEquals(r.counts.queued, 10 + WARMUP_BATCH_SIZES[0] + WARMUP_BATCH_SIZES[1]);

    const t2 = new Date(t1.getTime() + WARMUP_BATCH_INTERVAL_MS);
    await advanceCampaigns({ now: t2 });
    r = await campaignReport({ id: c.id, organizationId: org.id });
    assertEquals(r.counts.queued, 310);
    assertEquals(r.campaign.status, "sent");

    // One outbox row per recipient, each with a footer unsubscribe link.
    const rows = await outboxFor(c.id);
    assertEquals(rows.length, 310);
    assertEquals(new Set(rows.map((x) => x.toEmail)).size, 310);
    assertStringIncludes(rows[0].textBody, "/api/unsubscribe/");
    assertStringIncludes(rows[0].htmlBody ?? "", "Unsubscribe</a>");

    // Mailed once: no longer cold for the next campaign.
    const stillCold = await db
      .selectFrom("email_contacts")
      .select(["id"])
      .where("organizationId", "=", org.id)
      .where("firstSentAt", "is", null)
      .execute();
    assertEquals(stillCold.length, 0);
    const next = await draft(org.id);
    await startCampaign({ id: next.id, organizationId: org.id, now: t2 });
    await advanceCampaigns({ now: t2 });
    const r2 = await campaignReport({ id: next.id, organizationId: org.id });
    assertEquals(r2.counts.queued, 310);
  } finally {
    await cleanup();
  }
});

dbTest(
  "campaign: hard bounces over the threshold pause the ramp; resume starts a fresh window",
  async () => {
    const { org, cleanup } = await createIsolatedUser("owner");
    try {
      useSender(OWN_DOMAIN);
      const emails = await seedContacts(org.id, 400, "import");
      const c = await draft(org.id);
      const t0 = new Date();
      await startCampaign({ id: c.id, organizationId: org.id, now: t0 });
      await advanceCampaigns({ now: t0 });

      const sent = await db
        .selectFrom("email_campaign_recipients")
        .select(["email"])
        .where("campaignId", "=", c.id)
        .where("status", "=", "queued")
        .execute();
      assertEquals(sent.length, WARMUP_BATCH_SIZES[0]);

      // 5 of 50 bounce: 10%, over the 2% line.
      for (const s of sent.slice(0, 5)) {
        const res = await recordProviderFeedback({ type: "hard_bounce", email: s.email });
        assertEquals(res.action, "suppressed");
        assert(res.campaignRecipientId);
      }

      const t1 = new Date(t0.getTime() + WARMUP_BATCH_INTERVAL_MS);
      await advanceCampaigns({ now: t1 });
      let r = await campaignReport({ id: c.id, organizationId: org.id });
      assertEquals(r.campaign.status, "paused");
      assertStringIncludes(r.campaign.pausedReason ?? "", "5 hard bounces");
      assertStringIncludes(r.campaign.pausedReason ?? "", "first 50 imported contacts");
      assertEquals(r.counts.bounced, 5);
      assertEquals(r.counts.queued, 45);
      assertEquals(r.counts.pending, 350);

      // The bounced addresses are suppressed app-wide, contact rows too.
      const bounced = sent[0].email;
      const contact = await db
        .selectFrom("email_contacts")
        .select(["status", "suppressedReason"])
        .where("email", "=", bounced)
        .executeTakeFirstOrThrow();
      assertEquals(contact.status, "suppressed");
      assertEquals(contact.suppressedReason, "hard_bounce");
      const gate = await checkCommunicationsSuppression({ to: bounced, organizationId: org.id });
      assertEquals(gate, { suppressed: true, reason: "address_suppressed" });

      // Paused means paused: a later tick releases nothing.
      await advanceCampaigns({ now: new Date(t1.getTime() + WARMUP_BATCH_INTERVAL_MS) });
      r = await campaignReport({ id: c.id, organizationId: org.id });
      assertEquals(r.counts.pending, 350);

      // Resume judges what follows on its own.
      const t2 = new Date(t1.getTime() + 2 * WARMUP_BATCH_INTERVAL_MS);
      await resumeCampaign({ id: c.id, organizationId: org.id, now: t2 });
      await advanceCampaigns({ now: t2 });
      r = await campaignReport({ id: c.id, organizationId: org.id });
      assertEquals(r.campaign.status, "sending");
      assertEquals(r.counts.pending, 350 - WARMUP_BATCH_SIZES[1]);
      assert(emails.length === 400);
    } finally {
      await cleanup();
    }
  },
);

dbTest("campaign: one complaint in the first batch pauses it", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    useSender(OWN_DOMAIN);
    await seedContacts(org.id, 120, "import");
    const c = await draft(org.id);
    const t0 = new Date();
    await startCampaign({ id: c.id, organizationId: org.id, now: t0 });
    await advanceCampaigns({ now: t0 });
    const one = await db
      .selectFrom("email_campaign_recipients")
      .select(["email"])
      .where("campaignId", "=", c.id)
      .where("status", "=", "queued")
      .executeTakeFirstOrThrow();
    await recordProviderFeedback({ type: "complaint", email: one.email, campaignId: c.id });
    await advanceCampaigns({ now: new Date(t0.getTime() + WARMUP_BATCH_INTERVAL_MS) });
    const r = await campaignReport({ id: c.id, organizationId: org.id });
    assertEquals(r.campaign.status, "paused");
    assertStringIncludes(r.campaign.pausedReason ?? "", "1 spam complaints");
    assertEquals(r.counts.complained, 1);
  } finally {
    await cleanup();
  }
});

dbTest("campaign: a soft bounce changes nothing", async () => {
  const email = addr("soft");
  const res = await recordProviderFeedback({ type: "soft_bounce", email });
  assertEquals(res.action, "ignored");
  const row = await db.selectFrom("email_suppressions").select(["id"]).where("email", "=", email)
    .executeTakeFirst();
  assertEquals(row, undefined);
});

dbTest(
  "campaign: hygiene and suppression skip recipients at the first send, with reasons",
  async () => {
    const { org, cleanup } = await createIsolatedUser("owner");
    try {
      useSender(OWN_DOMAIN);
      const good = await seedContacts(org.id, 2, "signup");
      const typo = `pat.${run}@gmail.co`;
      const probe = `probe+${run}@inbox-${run}.com`;
      const blocked = addr("blocked");
      // Bounced BEFORE this contact row existed (app code that inserted it
      // directly, past the import's screening): the snapshot still catches it.
      await recordProviderFeedback({ type: "hard_bounce", email: blocked });
      await db.insertInto("email_contacts").values([
        { organizationId: org.id, email: typo, origin: "signup" },
        { organizationId: org.id, email: probe, origin: "signup" },
        { organizationId: org.id, email: blocked, origin: "signup" },
        { organizationId: org.id, email: addr("unsub"), origin: "signup", status: "unsubscribed" },
      ]).execute();

      const c = await draft(org.id);
      await startCampaign({ id: c.id, organizationId: org.id });
      const r = await campaignReport({ id: c.id, organizationId: org.id });
      // The unsubscribed contact is never a recipient at all.
      assertEquals(r.counts.total, 5);
      assertEquals(r.counts.skipped, 3);
      const reasons = Object.fromEntries(r.skipped.map((s) => [s.email, s.reason ?? ""]));
      assertStringIncludes(reasons[typo], "gmail.com");
      assertStringIncludes(reasons[probe], "test or system address");
      assertStringIncludes(reasons[blocked], "suppressed");

      await advanceCampaigns();
      const sent = await outboxFor(c.id);
      assertEquals(sent.map((x) => x.toEmail).sort(), [...good].sort());
    } finally {
      await cleanup();
    }
  },
);

dbTest("campaign: cancel skips the rest and stops undelivered outbox rows", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    useSender(OWN_DOMAIN);
    await seedContacts(org.id, 80, "import");
    const c = await draft(org.id);
    const t0 = new Date(Date.now() + 86_400_000); // future: outbox rows stay pending
    await startCampaign({ id: c.id, organizationId: org.id, now: t0 });
    await advanceCampaigns({ now: t0 });
    await cancelCampaign({ id: c.id, organizationId: org.id });
    const r = await campaignReport({ id: c.id, organizationId: org.id });
    assertEquals(r.campaign.status, "cancelled");
    assertEquals(r.counts.pending, 0);
    assertEquals(r.counts.skipped, 30);
    const statuses = new Set((await outboxFor(c.id)).map((x) => x.status));
    assertEquals([...statuses], ["cancelled"]);
  } finally {
    await cleanup();
  }
});

dbTest("campaign: another workspace's campaign is a 404", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    const c = await draft(a.org.id);
    await assertRejects(() => campaignReport({ id: c.id, organizationId: b.org.id }));
    await assertRejects(() => startCampaign({ id: c.id, organizationId: b.org.id }));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("unsubscribe: a contact is unsubscribed in that workspace only", async () => {
  const a = await createIsolatedUser("owner");
  const b = await createIsolatedUser("owner");
  try {
    const email = addr("both");
    await db.insertInto("email_contacts").values([
      { organizationId: a.org.id, email, origin: "signup" },
      { organizationId: b.org.id, email, origin: "signup" },
    ]).execute();
    await unsubscribe({ email, organizationId: a.org.id });
    const rows = await db.selectFrom("email_contacts").select(["organizationId", "status"])
      .where("email", "=", email).execute();
    const byOrg = Object.fromEntries(rows.map((r) => [r.organizationId, r.status]));
    assertEquals(byOrg[a.org.id], "unsubscribed");
    assertEquals(byOrg[b.org.id], "subscribed");
    assertEquals(
      (await checkCommunicationsSuppression({ to: email, organizationId: a.org.id })).suppressed,
      true,
    );
    assertEquals(
      (await checkCommunicationsSuppression({ to: email, organizationId: b.org.id })).suppressed,
      false,
    );
    // Idempotent.
    await unsubscribe({ email, organizationId: a.org.id });
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

dbTest("unsubscribe: an app user's own switch turns off, so Settings shows the truth", async () => {
  const { user, org, cleanup } = await createIsolatedUser("viewer");
  try {
    await unsubscribe({ email: user.email, organizationId: org.id });
    const gate = await checkCommunicationsSuppression({ to: user.email, organizationId: org.id });
    assertEquals(gate, { suppressed: true, reason: "user_opted_out" });
    const row = await db.selectFrom("email_suppressions").select(["id"]).where(
      "email",
      "=",
      user.email,
    )
      .executeTakeFirst();
    assertEquals(row, undefined);
  } finally {
    await cleanup();
  }
});

dbTest(
  "contacts: a signup is organic; signing up again undoes only your own unsubscribe",
  async () => {
    const { org, cleanup } = await createIsolatedUser("owner");
    try {
      const email = addr("signup");
      const first = await addSignupContact({ organizationId: org.id, email: email.toUpperCase() });
      assertEquals(first.email, email);
      assertEquals(first.origin, "signup");
      assertEquals(first.consentCollectedInApp, true);

      await unsubscribe({ email, organizationId: org.id });
      const again = await addSignupContact({ organizationId: org.id, email });
      assertEquals(again.id, first.id);
      assertEquals(again.status, "subscribed");
      assertEquals(
        (await checkCommunicationsSuppression({ to: email, organizationId: org.id })).suppressed,
        false,
      );

      // A bounce is not undone by a signup.
      const gone = addr("gone");
      await recordProviderFeedback({ type: "hard_bounce", email: gone });
      await assertRejects(() => addSignupContact({ organizationId: org.id, email: gone }));
      // Nor is a typo let in.
      await assertRejects(() =>
        addSignupContact({ organizationId: org.id, email: "pat@hotmial.com" })
      );
    } finally {
      await cleanup();
    }
  },
);

dbTest("contacts: adding one by hand needs the same attestation, and is cold", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  try {
    const email = addr("manual");
    await assertRejects(() =>
      addManualContact({ organizationId: org.id, userId: user.id, email, attestation: {} })
    );
    const row = await addManualContact({
      organizationId: org.id,
      userId: user.id,
      email,
      attestation: { listSource: "event", listSourceDetail: "Spring trade show", optedIn: true },
    });
    assertEquals(row.origin, "manual");
    assertEquals(row.consentSource, "event");
    assertEquals(row.consentAttestedBy, user.id);
    assertEquals(row.firstSentAt, null);
    await assertRejects(() =>
      addManualContact({
        organizationId: org.id,
        userId: user.id,
        email,
        attestation: { listSource: "event", listSourceDetail: "Again", optedIn: true },
      })
    );
  } finally {
    await cleanup();
  }
});
