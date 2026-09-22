/**
 * Email outbox — enqueue, dedupe, delivery, retry, cancel.
 *
 * Sending is intercepted through `_internalsForTest.sendEmailImpl`; no
 * SMTP is involved. Every row is org-scoped to the isolated test user so
 * cleanup() cascades it away.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createIsolatedUser, getTestDb } from "../helpers.ts";
import {
  _internalsForTest,
  backoffSecondsForAttempt,
  cancelEmail,
  deliverDueEmails,
  enqueueEmail,
  getOutboxEmail,
  listOutbox,
  RETRY_BACKOFF_SECONDS,
  STALE_LOCK_MS,
} from "@/services/email-outbox.service.ts";
import type { SendEmailOptions } from "@/services/email.ts";
import { BadRequestError } from "@/utils/errors.ts";

const db = getTestDb();

const HAS_DB = !!(Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL"));

/** DB tests here touch the shared pool; sanitizer noise fails them otherwise. */
function dbTest(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

/** Swap the sender for the duration of `fn`; restores even on throw. */
async function withSender<T>(
  impl: (opts: SendEmailOptions) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = _internalsForTest.sendEmailImpl;
  _internalsForTest.sendEmailImpl = impl;
  try {
    return await fn();
  } finally {
    _internalsForTest.sendEmailImpl = original;
  }
}

dbTest("outbox: enqueue then deliver marks the row sent and calls the sender once", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  const sent: SendEmailOptions[] = [];
  try {
    const { row, created } = await enqueueEmail({
      to: user.email,
      subject: "Hello",
      text: "Body",
      html: "<p>Body</p>",
      replyTo: "support@test.local",
      organizationId: org.id,
      userId: user.id,
      source: "test.hello",
    });
    assert(created);
    assertEquals(row.status, "pending");
    assertEquals(row.attempts, 0);

    const result = await withSender(async (o) => {
      sent.push(o);
    }, () => deliverDueEmails({ now: new Date() }));

    assertEquals(result.claimed, 1);
    assertEquals(result.sent, 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].to, user.email);
    assertEquals(sent[0].subject, "Hello");
    assertEquals(sent[0].html, "<p>Body</p>");
    assertEquals(sent[0].replyTo, "support@test.local");

    const after = (await getOutboxEmail(row.id))!;
    assertEquals(after.status, "sent");
    assertEquals(after.attempts, 1);
    assert(after.sentAt !== null);
    assertEquals(after.lockedAt, null);
  } finally {
    await cleanup();
  }
});

dbTest("outbox: idempotencyKey makes a second enqueue a no-op", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const key = `test.once:${org.id}`;
    const first = await enqueueEmail({
      to: user.email,
      subject: "Once",
      text: "x",
      organizationId: org.id,
      idempotencyKey: key,
    });
    const second = await enqueueEmail({
      to: user.email,
      subject: "Once again",
      text: "y",
      organizationId: org.id,
      idempotencyKey: key,
    });
    assert(first.created);
    assert(!second.created);
    assertEquals(second.row.id, first.row.id);
    assertEquals(second.row.subject, "Once");

    const rows = await listOutbox({ organizationId: org.id });
    assertEquals(rows.length, 1);
  } finally {
    await cleanup();
  }
});

dbTest("outbox: a future sendAt is not claimed until the clock reaches it", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    const { row } = await enqueueEmail({
      to: user.email,
      subject: "Later",
      text: "x",
      organizationId: org.id,
      sendAt: later,
    });

    const early = await withSender(async () => {}, () => deliverDueEmails({ now }));
    assertEquals(early.claimed, 0);
    assertEquals((await getOutboxEmail(row.id))!.status, "pending");

    const onTime = await withSender(async () => {}, () => deliverDueEmails({ now: later }));
    assertEquals(onTime.sent, 1);
    assertEquals((await getOutboxEmail(row.id))!.status, "sent");
  } finally {
    await cleanup();
  }
});

dbTest("outbox: a failed send is retried with backoff, then fails permanently", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const now = new Date();
    const { row } = await enqueueEmail({
      to: user.email,
      subject: "Flaky",
      text: "x",
      organizationId: org.id,
      maxAttempts: 2,
    });
    const boom = async () => {
      throw new Error("SMTP 451 try later");
    };

    const first = await withSender(boom, () => deliverDueEmails({ now }));
    assertEquals(first, { claimed: 1, sent: 0, retried: 1, failed: 0 });
    const afterFirst = (await getOutboxEmail(row.id))!;
    assertEquals(afterFirst.status, "pending");
    assertEquals(afterFirst.attempts, 1);
    assertEquals(afterFirst.lastError, "SMTP 451 try later");
    assertEquals(
      afterFirst.sendAt.getTime(),
      now.getTime() + RETRY_BACKOFF_SECONDS[0] * 1000,
    );

    // Not due yet at the original clock.
    const tooSoon = await withSender(boom, () => deliverDueEmails({ now }));
    assertEquals(tooSoon.claimed, 0);

    // At the retry time the second (and last) attempt fails → permanent.
    const second = await withSender(boom, () => deliverDueEmails({ now: afterFirst.sendAt }));
    assertEquals(second, { claimed: 1, sent: 0, retried: 0, failed: 1 });
    const afterSecond = (await getOutboxEmail(row.id))!;
    assertEquals(afterSecond.status, "failed");
    assertEquals(afterSecond.attempts, 2);
  } finally {
    await cleanup();
  }
});

dbTest("outbox: a sender-domain rejection fails the row on the first attempt", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const { row } = await enqueueEmail({
      to: user.email,
      subject: "Branded",
      text: "x",
      organizationId: org.id,
      maxAttempts: 5,
    });
    const boom = async () => {
      throw new Error("550-From header sender domain not verified (acme.test)");
    };
    const result = await withSender(boom, () => deliverDueEmails({ now: new Date() }));
    assertEquals(result, { claimed: 1, sent: 0, retried: 0, failed: 1 });
    const after = (await getOutboxEmail(row.id))!;
    assertEquals(after.status, "failed");
    assertEquals(after.attempts, 1);
    assertStringIncludes(after.lastError ?? "", "cannot succeed");
    assertStringIncludes(after.lastError ?? "", "acme.test");
  } finally {
    await cleanup();
  }
});

dbTest("outbox: backoff table is 1m, 5m, 30m, 2h, 12h and clamps", () => {
  assertEquals(backoffSecondsForAttempt(1), 60);
  assertEquals(backoffSecondsForAttempt(2), 300);
  assertEquals(backoffSecondsForAttempt(3), 1800);
  assertEquals(backoffSecondsForAttempt(4), 7200);
  assertEquals(backoffSecondsForAttempt(5), 43200);
  assertEquals(backoffSecondsForAttempt(50), 43200);
  assertEquals(backoffSecondsForAttempt(0), 60);
});

dbTest("outbox: a row stuck in 'sending' past the stale window is reclaimed", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const now = new Date();
    const { row } = await enqueueEmail({
      to: user.email,
      subject: "Orphaned",
      text: "x",
      organizationId: org.id,
    });
    // Simulate a runner that died mid-send 11 minutes ago.
    await db
      .updateTable("email_outbox")
      .set({
        status: "sending",
        lockedAt: new Date(now.getTime() - STALE_LOCK_MS - 60_000),
        attempts: 1,
      })
      .where("id", "=", row.id)
      .execute();

    const result = await withSender(async () => {}, () => deliverDueEmails({ now }));
    assertEquals(result.sent, 1);
    const after = (await getOutboxEmail(row.id))!;
    assertEquals(after.status, "sent");
    assertEquals(after.attempts, 2);
  } finally {
    await cleanup();
  }
});

dbTest("outbox: a freshly locked 'sending' row is NOT reclaimed", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const now = new Date();
    const { row } = await enqueueEmail({
      to: user.email,
      subject: "In flight",
      text: "x",
      organizationId: org.id,
    });
    await db
      .updateTable("email_outbox")
      .set({ status: "sending", lockedAt: new Date(now.getTime() - 5_000) })
      .where("id", "=", row.id)
      .execute();
    const result = await withSender(async () => {}, () => deliverDueEmails({ now }));
    assertEquals(result.claimed, 0);
  } finally {
    await cleanup();
  }
});

dbTest("outbox: cancel works only while pending", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    const { row } = await enqueueEmail({
      to: user.email,
      subject: "Cancel me",
      text: "x",
      organizationId: org.id,
      sendAt: new Date(Date.now() + 60_000),
    });
    assert(await cancelEmail(row.id));
    assertEquals((await getOutboxEmail(row.id))!.status, "cancelled");
    assert(!(await cancelEmail(row.id)));

    const claimed = await withSender(
      async () => {},
      () => deliverDueEmails({ now: new Date(Date.now() + 120_000) }),
    );
    assertEquals(claimed.claimed, 0);
  } finally {
    await cleanup();
  }
});

dbTest("outbox: enqueue inside a rolled-back transaction leaves no row", async () => {
  const { org, user, cleanup } = await createIsolatedUser("owner");
  try {
    await assertRejects(() =>
      db.transaction().execute(async (trx) => {
        await enqueueEmail({
          to: user.email,
          subject: "Never",
          text: "x",
          organizationId: org.id,
        }, trx);
        throw new Error("abort");
      })
    );
    assertEquals((await listOutbox({ organizationId: org.id })).length, 0);
  } finally {
    await cleanup();
  }
});

dbTest("outbox: rejects a malformed recipient and empty subject", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    await assertRejects(
      () => enqueueEmail({ to: "not-an-email", subject: "x", text: "x", organizationId: org.id }),
      BadRequestError,
    );
    await assertRejects(
      () => enqueueEmail({ to: "a@b.co", subject: "   ", text: "x", organizationId: org.id }),
      BadRequestError,
    );
  } finally {
    await cleanup();
  }
});
