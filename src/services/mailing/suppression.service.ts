/**
 * Suppression: the addresses this app must stop mailing, and the two ways
 * it learns about them.
 *
 *   1. Provider feedback (`recordProviderFeedback`). The mail provider
 *      reports a hard bounce or a spam complaint. The address is suppressed
 *      APP-WIDE (it is a property of the mailbox, whoever sent to it), every
 *      contact row for it is marked suppressed, and the campaign send it
 *      belongs to is marked bounced/complained so the warm-up thresholds
 *      see it. Reaches the app through `POST /api/email-feedback`
 *      (src/api/routes/email-feedback), token-gated, dormant until the
 *      platform sets `EMAIL_FEEDBACK_TOKEN` and starts forwarding.
 *   2. One-click unsubscribe (`unsubscribe`). The recipient hits
 *      "Unsubscribe" in their mail client. Ordinary mail from THAT
 *      workspace stops: an app user's personal communications switch turns
 *      off (they can turn it back on in Settings), and anyone else gets a
 *      workspace-scoped suppression row. Their contact rows in that
 *      workspace become unsubscribed.
 *
 * The communications gate (communications.service.ts) reads
 * `email_suppressions` on every ordinary send, so a suppressed address is
 * skipped by digests, alerts and campaigns alike. Auth-critical mail (the
 * sign-in code) is never gated: suppressing it is a lockout.
 */

import { type Kysely, sql } from "kysely";
import { db } from "@/db/client.ts";
import type { Database, EmailSuppressionReason } from "@/db/schema.ts";
import { log } from "@/lib/logger.ts";
import { setUserCommunicationsEnabled } from "@/services/communications.service.ts";
import { normalizeAddress } from "@/services/mailing/hygiene.ts";
import type { UnsubscribeTarget } from "@/services/mailing/unsubscribe-token.ts";

const LOG_SOURCE = "mailing";

/** Provider feedback lands on the address's latest campaign send within this window. */
export const FEEDBACK_MATCH_WINDOW_DAYS = 30;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export interface SuppressInput {
  email: string;
  reason: EmailSuppressionReason;
  /** NULL = app-wide. */
  organizationId?: string | null;
  source?: string;
  detail?: string | null;
}

/** Add (or refresh) one suppression row, and mark matching contacts. Idempotent. */
export async function suppressAddress(
  input: SuppressInput,
  executor: Kysely<Database> = db,
): Promise<void> {
  const email = normalizeAddress(input.email);
  const organizationId = input.organizationId ?? null;
  const detail = input.detail ? input.detail.slice(0, 1000) : null;
  const source = input.source ? input.source.slice(0, 64) : null;

  // The unique index is on (email, COALESCE(org, zero uuid)), an
  // expression, so the conflict target is written in raw SQL.
  await sql`
    INSERT INTO email_suppressions (email, organization_id, reason, source, detail)
    VALUES (${email}, ${organizationId}, ${input.reason}, ${source}, ${detail})
    ON CONFLICT (email, COALESCE(organization_id, ${ZERO_UUID}::uuid))
    DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source,
                  detail = EXCLUDED.detail, updated_at = NOW()
  `.execute(executor);

  const now = new Date();
  if (input.reason === "unsubscribed") {
    let q = executor
      .updateTable("email_contacts")
      .set({ status: "unsubscribed", unsubscribedAt: now })
      .where("email", "=", email)
      .where("status", "=", "subscribed");
    if (organizationId) q = q.where("organizationId", "=", organizationId);
    await q.execute();
    return;
  }

  let q = executor
    .updateTable("email_contacts")
    .set({ status: "suppressed", suppressedAt: now, suppressedReason: input.reason })
    .where("email", "=", email)
    .where("status", "!=", "suppressed");
  if (organizationId) q = q.where("organizationId", "=", organizationId);
  await q.execute();
}

/** True when ordinary mail to this address (from this workspace) is suppressed. */
export async function isAddressSuppressed(
  email: string,
  organizationId: string | null,
): Promise<boolean> {
  const row = await db
    .selectFrom("email_suppressions")
    .select(["id"])
    .where("email", "=", normalizeAddress(email))
    .where((eb) =>
      organizationId
        ? eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)])
        : eb("organizationId", "is", null)
    )
    .executeTakeFirst();
  return !!row;
}

// ── Provider feedback ────────────────────────────────────────────────────

export type ProviderFeedbackType = "hard_bounce" | "complaint" | "soft_bounce" | "unsubscribe";

export interface ProviderFeedbackEvent {
  type: ProviderFeedbackType;
  email: string;
  /** When the provider knows which campaign it was (a custom header echoed back). */
  campaignId?: string | null;
  /** Workspace, for an unsubscribe. Ignored for bounces and complaints (app-wide). */
  organizationId?: string | null;
  occurredAt?: Date;
  detail?: string | null;
}

export interface ProviderFeedbackResult {
  email: string;
  type: ProviderFeedbackType;
  /** What changed: "suppressed", "unsubscribed", or "ignored" (a soft bounce). */
  action: "suppressed" | "unsubscribed" | "ignored";
  /** The campaign send it was matched to, if any. */
  campaignRecipientId: string | null;
}

/**
 * Apply one provider event. Idempotent: the same bounce reported twice
 * changes nothing the second time.
 *
 * A soft bounce (mailbox full, greylisting) is recorded in the log only. It
 * is not a reason to stop mailing someone, and counting it toward the
 * warm-up bounce rate would pause healthy lists.
 */
export async function recordProviderFeedback(
  event: ProviderFeedbackEvent,
): Promise<ProviderFeedbackResult> {
  const email = normalizeAddress(event.email);
  const base = { email, type: event.type, campaignRecipientId: null };

  if (event.type === "soft_bounce") {
    log.info("Soft bounce reported; not suppressing", {
      source: LOG_SOURCE,
      feature: "provider-feedback",
      email,
    });
    return { ...base, action: "ignored" };
  }

  if (event.type === "unsubscribe") {
    await suppressAddress({
      email,
      reason: "unsubscribed",
      organizationId: event.organizationId ?? null,
      source: "provider-feedback",
      detail: event.detail,
    });
    return { ...base, action: "unsubscribed" };
  }

  return await db.transaction().execute(async (trx) => {
    await suppressAddress({
      email,
      reason: event.type === "hard_bounce" ? "hard_bounce" : "complaint",
      organizationId: null,
      source: "provider-feedback",
      detail: event.detail,
    }, trx);

    // Land the event on the send it belongs to, so the campaign's warm-up
    // health check counts it. Only a 'queued' row moves: a send already
    // marked bounced stays bounced, and a later complaint about the same
    // send does not undo the bounce.
    const since = new Date(
      (event.occurredAt ?? new Date()).getTime() - FEEDBACK_MATCH_WINDOW_DAYS * 86_400_000,
    );
    let q = trx
      .selectFrom("email_campaign_recipients")
      .select(["id"])
      .where("email", "=", email)
      .where("status", "=", "queued")
      .where("queuedAt", ">=", since)
      .orderBy("queuedAt", "desc")
      .limit(1);
    if (event.campaignId) q = q.where("campaignId", "=", event.campaignId);
    const match = await q.executeTakeFirst();

    if (match) {
      await trx
        .updateTable("email_campaign_recipients")
        .set({ status: event.type === "hard_bounce" ? "bounced" : "complained" })
        .where("id", "=", match.id)
        .execute();
    }

    log.info("Provider feedback applied", {
      source: LOG_SOURCE,
      feature: "provider-feedback",
      email,
      type: event.type,
      matchedSend: !!match,
    });
    return { ...base, action: "suppressed" as const, campaignRecipientId: match?.id ?? null };
  });
}

// ── One-click unsubscribe ────────────────────────────────────────────────

/**
 * Stop this workspace's ordinary mail to the address the token names.
 * Idempotent; a second click is a no-op that still answers "done".
 */
export async function unsubscribe(target: UnsubscribeTarget): Promise<void> {
  const email = normalizeAddress(target.email);
  const orgId = target.organizationId;

  // An app user: their personal switch, so Settings shows the truth and
  // they can turn mail back on themselves. Only when the token's workspace
  // is theirs (or the token names none).
  const user = await db
    .selectFrom("users")
    .select(["id", "organizationId"])
    .where("email", "=", email)
    .executeTakeFirst();
  const userMatches = !!user && (!orgId || user.organizationId === orgId);

  await db.transaction().execute(async (trx) => {
    if (!userMatches) {
      await suppressAddress({
        email,
        reason: "unsubscribed",
        organizationId: orgId,
        source: "one-click",
      }, trx);
    } else {
      // Contacts still flip; the user's own preference is set below.
      let q = trx
        .updateTable("email_contacts")
        .set({ status: "unsubscribed", unsubscribedAt: new Date() })
        .where("email", "=", email)
        .where("status", "=", "subscribed");
      if (orgId) q = q.where("organizationId", "=", orgId);
      await q.execute();
    }
  });
  if (userMatches && user) await setUserCommunicationsEnabled(user.id, false);

  log.info("One-click unsubscribe applied", {
    source: LOG_SOURCE,
    feature: "unsubscribe",
    email,
    organizationId: orgId,
    appUser: userMatches,
  });
}
