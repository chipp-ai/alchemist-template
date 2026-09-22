/**
 * Email outbox — durable, retried, at-most-once outbound email.
 *
 * Why an outbox instead of calling sendEmail() from a route:
 *   - The send survives a crash between "state committed" and "SMTP
 *     answered": the row is written in the caller's transaction and
 *     delivered by the job runner afterwards.
 *   - SMTP failures retry with backoff instead of surfacing as a 500 to a
 *     user who only wanted to save a form.
 *   - A sender-domain rejection fails the row immediately: retrying the
 *     same From cannot succeed (the fix is verifying the domain, not time).
 *   - `idempotencyKey` makes "once per user per event" a one-liner, which
 *     is what every scheduled digest needs.
 *   - An agent can verify "was the email sent?" by reading the row
 *     (GET /api/dev/outbox) instead of scraping the server log.
 *
 * Event-driven mail:
 *
 *   await db.transaction().execute(async (trx) => {
 *     await trx.updateTable("orders").set({ status: "shipped" })...;
 *     await enqueueEmail({
 *       to: customer.email,
 *       subject: "Your order shipped",
 *       text: ...,
 *       html: brandedEmailShell({ bodyHtml: ... }),
 *       organizationId: order.organizationId,
 *       idempotencyKey: `order.shipped:${order.id}`,
 *       source: "order.shipped",
 *     }, trx);
 *   });
 *
 * Scheduled mail: a job handler (src/jobs/) calls ctx.enqueueEmail.
 *
 * Delivery: `deliverDueEmails` is called by the runner every tick. It
 * claims due rows with FOR UPDATE SKIP LOCKED inside a short transaction
 * (so N replicas each take different rows), then sends outside the
 * transaction so a slow SMTP round-trip never holds a DB lock.
 */

import { type Kysely, sql } from "kysely";
import { db } from "@/db/client.ts";
import type { Database, EmailOutboxRow, EmailOutboxStatus } from "@/db/schema.ts";
import { isUnverifiedSenderRejection, sendEmail } from "@/services/email.ts";
import { log } from "@/lib/logger.ts";
import { BadRequestError } from "@/utils/errors.ts";

export type { EmailOutboxRow };

export interface EnqueueEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Deliver at or after this time. Default: now. */
  sendAt?: Date;
  /** Dedupe key. A second enqueue with the same key returns the first row. */
  idempotencyKey?: string;
  organizationId?: string | null;
  userId?: string | null;
  /** Origin tag for debugging: "invite", "job:org_digest", "order.shipped". */
  source?: string;
  /** Override the default of 5 delivery attempts. */
  maxAttempts?: number;
}

/** Backoff after the Nth failed attempt (1-based): 1m, 5m, 30m, 2h, 12h. */
export const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200] as const;

/** A row left in 'sending' longer than this is reclaimed (runner died mid-send). */
export const STALE_LOCK_MS = 10 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sending seam. Tests replace `sendEmailImpl` to observe delivery without
 * SMTP; production leaves it alone.
 */
export const _internalsForTest = {
  sendEmailImpl: sendEmail,
};

// ── Enqueue ─────────────────────────────────────────────────────────────

/**
 * Queue one email. Pass the caller's transaction as `executor` to make
 * the enqueue atomic with the state change that caused it.
 *
 * Returns `{ row, created }`; `created` is false when `idempotencyKey`
 * matched an existing row (nothing new was queued).
 */
export async function enqueueEmail(
  input: EnqueueEmailInput,
  executor: Kysely<Database> = db,
): Promise<{ row: EmailOutboxRow; created: boolean }> {
  const to = input.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) {
    throw new BadRequestError(`Invalid recipient email "${input.to}"`);
  }
  const subject = input.subject.trim();
  if (!subject) throw new BadRequestError("Email subject is required");
  if (!input.text.trim()) throw new BadRequestError("Email text body is required");
  if (input.maxAttempts !== undefined && (input.maxAttempts < 1 || input.maxAttempts > 20)) {
    throw new BadRequestError("maxAttempts must be between 1 and 20");
  }
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 512) {
    throw new BadRequestError("idempotencyKey must be 512 characters or fewer");
  }

  const values = {
    organizationId: input.organizationId ?? null,
    userId: input.userId ?? null,
    toEmail: to,
    subject,
    textBody: input.text,
    htmlBody: input.html ?? null,
    replyTo: input.replyTo ?? null,
    idempotencyKey,
    sendAt: input.sendAt ?? new Date(),
    source: input.source ?? null,
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
  };

  if (!idempotencyKey) {
    const row = await executor
      .insertInto("email_outbox")
      .values(values)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row, created: true };
  }

  // Partial unique index on idempotency_key WHERE NOT NULL: the ON CONFLICT
  // target must repeat the predicate for Postgres to pick that index.
  const inserted = await executor
    .insertInto("email_outbox")
    .values(values)
    .onConflict((oc) =>
      oc.column("idempotencyKey").where("idempotencyKey", "is not", null).doNothing()
    )
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { row: inserted, created: true };

  const existing = await executor
    .selectFrom("email_outbox")
    .selectAll()
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirstOrThrow();
  return { row: existing, created: false };
}

// ── Read + cancel ───────────────────────────────────────────────────────

export async function getOutboxEmail(id: string): Promise<EmailOutboxRow | undefined> {
  return await db.selectFrom("email_outbox").selectAll().where("id", "=", id).executeTakeFirst();
}

export interface ListOutboxOptions {
  organizationId?: string | null;
  status?: EmailOutboxStatus;
  limit?: number;
}

/** Most recent first. */
export async function listOutbox(opts: ListOutboxOptions = {}): Promise<EmailOutboxRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  let q = db.selectFrom("email_outbox").selectAll().orderBy("createdAt", "desc").limit(limit);
  if (opts.organizationId !== undefined) {
    q = opts.organizationId === null
      ? q.where("organizationId", "is", null)
      : q.where("organizationId", "=", opts.organizationId);
  }
  if (opts.status) q = q.where("status", "=", opts.status);
  return await q.execute();
}

/** Cancel a pending email. Returns false when it already left 'pending'. */
export async function cancelEmail(id: string): Promise<boolean> {
  const res = await db
    .updateTable("email_outbox")
    .set({ status: "cancelled" })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

// ── Delivery ────────────────────────────────────────────────────────────

export interface DeliverDueOptions {
  /** Wall clock. Injected for tests and the dev tick route. */
  now?: Date;
  /** Max rows to claim in one pass. */
  limit?: number;
}

export interface DeliverDueResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

export function backoffSecondsForAttempt(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1), RETRY_BACKOFF_SECONDS.length) - 1;
  return RETRY_BACKOFF_SECONDS[idx];
}

/**
 * Claim every due row (pending, or sending with a stale lock), bump its
 * attempt counter, and try to send it. Safe to call from several
 * replicas at once.
 */
export async function deliverDueEmails(opts: DeliverDueOptions = {}): Promise<DeliverDueResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  const result: DeliverDueResult = { claimed: 0, sent: 0, retried: 0, failed: 0 };

  const claimed = await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("email_outbox")
      .selectAll()
      .where("sendAt", "<=", now)
      .where((eb) =>
        eb.or([
          eb("status", "=", "pending"),
          eb.and([eb("status", "=", "sending"), eb("lockedAt", "<", staleBefore)]),
        ])
      )
      .orderBy("sendAt", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return [];
    await trx
      .updateTable("email_outbox")
      .set({ status: "sending", lockedAt: now, attempts: sql<number>`attempts + 1` })
      .where("id", "in", rows.map((r) => r.id))
      .execute();
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });

  result.claimed = claimed.length;

  for (const row of claimed) {
    try {
      // The transport applies the per-org communications gate (a muted
      // workspace is suppressed there, not here) and tags the dev mailbox
      // capture with the row's source so tests can assert on it.
      await _internalsForTest.sendEmailImpl({
        to: row.toEmail,
        subject: row.subject,
        text: row.textBody,
        html: row.htmlBody ?? undefined,
        replyTo: row.replyTo ?? undefined,
        organizationId: row.organizationId,
        kind: row.source ?? undefined,
      });
      await db
        .updateTable("email_outbox")
        .set({ status: "sent", sentAt: now, lockedAt: null, lastError: null })
        .where("id", "=", row.id)
        .execute();
      result.sent++;
      log.info("Outbox email sent", {
        source: "email-outbox",
        id: row.id,
        to: row.toEmail,
        origin: row.source,
        attempt: row.attempts,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A sender-domain rejection is permanent: the From header stays wrong
      // until someone verifies the domain, so no retry can ever succeed.
      // Fail the row now with the fix in the error text instead of burning
      // five attempts (1m..12h backoff) on the same doomed send.
      if (isUnverifiedSenderRejection(err)) {
        const lastError =
          `${message} -- retrying the same From cannot succeed. Verify the sending domain (or restore the platform sender), then re-enqueue.`;
        await db
          .updateTable("email_outbox")
          .set({ status: "failed", lockedAt: null, lastError })
          .where("id", "=", row.id)
          .execute();
        result.failed++;
        log.error("Outbox email failed: sender domain not verified", {
          source: "email-outbox",
          id: row.id,
          to: row.toEmail,
          origin: row.source,
        }, err);
        continue;
      }
      const exhausted = row.attempts >= row.maxAttempts;
      if (exhausted) {
        await db
          .updateTable("email_outbox")
          .set({ status: "failed", lockedAt: null, lastError: message })
          .where("id", "=", row.id)
          .execute();
        result.failed++;
        log.error("Outbox email failed permanently", {
          source: "email-outbox",
          id: row.id,
          to: row.toEmail,
          origin: row.source,
          attempts: row.attempts,
        }, err);
      } else {
        const retryAt = new Date(now.getTime() + backoffSecondsForAttempt(row.attempts) * 1000);
        await db
          .updateTable("email_outbox")
          .set({ status: "pending", sendAt: retryAt, lockedAt: null, lastError: message })
          .where("id", "=", row.id)
          .execute();
        result.retried++;
        log.warn("Outbox email send failed, will retry", {
          source: "email-outbox",
          id: row.id,
          to: row.toEmail,
          origin: row.source,
          attempt: row.attempts,
          retryAt: retryAt.toISOString(),
        }, err);
      }
    }
  }

  return result;
}
