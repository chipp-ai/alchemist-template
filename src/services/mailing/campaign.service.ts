/**
 * Campaigns: one newsletter (announcement, promo, any send to the mailing
 * list), with every safeguard a bulk send needs built in.
 *
 *   create (draft) -> start | schedule -> sending -> sent
 *                                      \-> paused -> resume | cancel
 *
 * What starting a campaign checks, in order, and why:
 *
 *   1. Sender (sender-policy.ts). A campaign never goes out from the shared
 *      platform sender. Blocked with SENDER_DOMAIN_REQUIRED and a message
 *      that says how to verify a domain. Checked again at every release,
 *      because a scheduled campaign starts later than it was approved.
 *   2. The workspace's email is on (the org communications toggle). A
 *      campaign that would be silently muted at delivery is refused up
 *      front instead.
 *   3. List hygiene (hygiene.ts) on every recipient, at snapshot time:
 *      invalid, typo, test/role and suppressed addresses are skipped with a
 *      reason. Dedupe is structural: one contact per address per workspace,
 *      one recipient row per contact per campaign.
 *
 * Warm-up for cold recipients. A contact that did not subscribe through
 * this app (imported, or added by hand) and has never been mailed is COLD.
 * Cold recipients are released in growing batches (`WARMUP_BATCH_SIZES`),
 * at most one batch per `WARMUP_BATCH_INTERVAL_MS`, and before each batch
 * the hard-bounce and complaint rates of the cold sends so far are checked
 * against `WARMUP_MAX_HARD_BOUNCE_RATE` / `WARMUP_MAX_COMPLAINT_RATE`. Over
 * a threshold, the campaign PAUSES with the numbers in `pausedReason`. The
 * 2026-11-04 list (8.7% hard bounces) would have stopped after its first
 * 50 sends instead of after 12,000. Organic (signup) and already-mailed
 * recipients are not held back.
 *
 * The thresholds only see what provider feedback reports (feedback via
 * `POST /api/email-feedback`, suppression.service.ts). Until the platform
 * forwards bounces, the ramp still spaces the sends out, but it cannot
 * pause on its own. `mailingReadiness()` says which state an app is in.
 *
 * Delivery is the outbox: each released recipient is one `email_outbox`
 * row (idempotency key `campaign:<id>:<contactId>`), delivered by the job
 * runner through the transport, which adds the one-click unsubscribe
 * headers and applies the communications gate (suppression list included).
 *
 * The runner calls `advanceCampaigns()` every tick (src/jobs/runner.ts).
 * Each campaign row is claimed with FOR UPDATE SKIP LOCKED, so replicas
 * never release the same batch twice.
 */

import { type Kysely, sql } from "kysely";
import { db } from "@/db/client.ts";
import type {
  Database,
  EmailCampaignRecipientStatus,
  EmailCampaignRow,
  EmailCampaignStatus,
} from "@/db/schema.ts";
import { BRAND } from "@/config/brand.ts";
import { log } from "@/lib/logger.ts";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "@/utils/errors.ts";
import { enqueueEmail } from "@/services/email-outbox.service.ts";
import { escapeHtml } from "@/lib/safe-html.ts";
import { getOrgCommunicationsEnabled } from "@/services/communications.service.ts";
import { bulkSenderStatus } from "@/services/mailing/sender-policy.ts";
import { checkAddress } from "@/services/mailing/hygiene.ts";
import { unsubscribeUrl } from "@/services/mailing/unsubscribe-token.ts";
import { getEnv } from "@/lib/env.ts";

const LOG_SOURCE = "mailing";

// ── Warm-up thresholds (named so a reviewer can find and argue with them) ──

/**
 * Cold batch sizes, in order. After the last one, every later batch is the
 * last size. 50 is small enough that a bad list costs the sender almost
 * nothing, and large enough to measure a bounce rate.
 */
export const WARMUP_BATCH_SIZES: readonly number[] = Object.freeze([
  50,
  200,
  500,
  1000,
  2500,
  5000,
]);

/**
 * Minimum time between two cold batches. Bounces and complaints arrive
 * minutes to hours after a send; the next batch waits for them.
 */
export const WARMUP_BATCH_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Pause when more than this share of released cold sends hard-bounced.
 * Mailbox providers start filtering a sender at a few percent; 2% is the
 * commonly cited ceiling for a healthy list.
 */
export const WARMUP_MAX_HARD_BOUNCE_RATE = 0.02;

/**
 * Pause when more than this share of released cold sends drew a spam
 * complaint. Gmail's bulk-sender rules ask for under 0.1% and act at 0.3%.
 */
export const WARMUP_MAX_COMPLAINT_RATE = 0.001;

/** Rates are not judged on fewer cold sends than this. */
export const WARMUP_MIN_SAMPLE = 20;

/** Warm recipients released per campaign per runner tick. Bounds one tick's work. */
export const CAMPAIGN_RELEASE_CHUNK = 500;

/** Campaigns advanced per runner tick. */
export const CAMPAIGNS_PER_TICK = 10;

/** The 409 a blocked sender gets. The SPA keys its "verify a domain" help on the code. */
export class SenderDomainRequiredError extends AppError {
  constructor(message: string) {
    super(message, 409, "SENDER_DOMAIN_REQUIRED");
    this.name = "SenderDomainRequiredError";
  }
}

// ── Create / edit ────────────────────────────────────────────────────────

export interface CampaignContent {
  name: string;
  subject: string;
  text: string;
  html?: string | null;
}

function cleanContent(input: CampaignContent): CampaignContent {
  const name = input.name?.trim() ?? "";
  const subject = input.subject?.trim() ?? "";
  if (!name || name.length > 200) {
    throw new BadRequestError("Campaign name must be 1-200 characters.");
  }
  if (!subject || subject.length > 300) {
    throw new BadRequestError("Subject must be 1-300 characters.");
  }
  if (!input.text?.trim()) throw new BadRequestError("A plain-text body is required.");
  return { name, subject, text: input.text, html: input.html ?? null };
}

export async function createCampaign(
  input: CampaignContent & { organizationId: string; userId: string | null },
): Promise<EmailCampaignRow> {
  const c = cleanContent(input);
  return await db
    .insertInto("email_campaigns")
    .values({
      organizationId: input.organizationId,
      createdBy: input.userId,
      name: c.name,
      subject: c.subject,
      textBody: c.text,
      htmlBody: c.html ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateCampaign(
  input: CampaignContent & { id: string; organizationId: string },
): Promise<EmailCampaignRow> {
  const c = cleanContent(input);
  const row = await db
    .updateTable("email_campaigns")
    .set({ name: c.name, subject: c.subject, textBody: c.text, htmlBody: c.html ?? null })
    .where("id", "=", input.id)
    .where("organizationId", "=", input.organizationId)
    .where("status", "=", "draft")
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    await getCampaign({ id: input.id, organizationId: input.organizationId });
    throw new ConflictError("Only a draft campaign can be edited.");
  }
  return row;
}

export async function getCampaign(
  opts: { id: string; organizationId: string },
): Promise<EmailCampaignRow> {
  const row = await db
    .selectFrom("email_campaigns")
    .selectAll()
    .where("id", "=", opts.id)
    // Org-scoped in the WHERE clause (CWE-639): another workspace's id is a 404.
    .where("organizationId", "=", opts.organizationId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("Campaign", opts.id);
  return row;
}

export async function listCampaigns(opts: { organizationId: string; limit?: number }) {
  return await db
    .selectFrom("email_campaigns")
    .selectAll()
    .where("organizationId", "=", opts.organizationId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .execute();
}

// ── Start / schedule ─────────────────────────────────────────────────────

/** Throws SenderDomainRequiredError when campaigns may not send from this deployment. */
export function assertBulkSenderAllowed(): void {
  const status = bulkSenderStatus();
  if (!status.allowed) throw new SenderDomainRequiredError(status.message);
}

/**
 * Start a draft now, or schedule it (`sendAt` in the future). Both run the
 * sender check, so a builder learns about the missing domain when they
 * press the button, not when the schedule fires.
 */
export async function startCampaign(opts: {
  id: string;
  organizationId: string;
  sendAt?: Date | null;
  now?: Date;
}): Promise<EmailCampaignRow> {
  const now = opts.now ?? new Date();
  assertBulkSenderAllowed();
  if (!(await getOrgCommunicationsEnabled(opts.organizationId))) {
    throw new BadRequestError(
      "This workspace's email is turned off (Settings, Notifications). Turn it on before sending a campaign.",
    );
  }

  return await db.transaction().execute(async (trx) => {
    const campaign = await trx
      .selectFrom("email_campaigns")
      .selectAll()
      .where("id", "=", opts.id)
      .where("organizationId", "=", opts.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!campaign) throw new NotFoundError("Campaign", opts.id);
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw new ConflictError(`A ${campaign.status} campaign cannot be started again.`);
    }

    const subscribed = await trx
      .selectFrom("email_contacts")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("organizationId", "=", opts.organizationId)
      .where("status", "=", "subscribed")
      .executeTakeFirst();
    if (Number(subscribed?.n ?? 0) === 0) {
      throw new BadRequestError("There is nobody subscribed on this workspace's list yet.");
    }

    if (opts.sendAt && opts.sendAt.getTime() > now.getTime()) {
      return await trx
        .updateTable("email_campaigns")
        .set({ status: "scheduled", scheduledAt: opts.sendAt })
        .where("id", "=", campaign.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    await snapshotRecipients(trx, campaign);
    return await trx
      .updateTable("email_campaigns")
      .set({
        status: "sending",
        startedAt: now,
        scheduledAt: campaign.scheduledAt ?? now,
        healthWindowStart: now,
        nextColdBatchAt: now,
      })
      .where("id", "=", campaign.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
 * Freeze who this campaign goes to, and skip, with a reason, everyone who
 * must not get it. Idempotent (ON CONFLICT DO NOTHING).
 */
async function snapshotRecipients(
  trx: Kysely<Database>,
  campaign: EmailCampaignRow,
): Promise<void> {
  await sql`
    INSERT INTO email_campaign_recipients (campaign_id, contact_id, email, cold)
    SELECT ${campaign.id}::uuid, c.id, c.email,
           (c.origin <> 'signup' AND c.first_sent_at IS NULL)
      FROM email_contacts c
     WHERE c.organization_id = ${campaign.organizationId}::uuid
       AND c.status = 'subscribed'
    ON CONFLICT (campaign_id, contact_id) DO NOTHING
  `.execute(trx);

  // Suppressed since they were added (a bounce from another workspace's
  // mail, an unsubscribe that has not reached the contact row).
  await sql`
    UPDATE email_campaign_recipients r
       SET status = 'skipped',
           skip_reason = 'Address is suppressed (' || replace(s.reason, '_', ' ') || ').'
      FROM email_suppressions s
     WHERE r.campaign_id = ${campaign.id}::uuid
       AND r.status = 'pending'
       AND s.email = r.email
       AND (s.organization_id IS NULL OR s.organization_id = ${campaign.organizationId}::uuid)
  `.execute(trx);

  // Hygiene before the first send: the import already screened its rows,
  // but contacts arrive by other doors too.
  const pending = await trx
    .selectFrom("email_campaign_recipients")
    .select(["id", "email"])
    .where("campaignId", "=", campaign.id)
    .where("status", "=", "pending")
    .execute();
  const byReason = new Map<string, string[]>();
  for (const r of pending) {
    const check = checkAddress(r.email);
    if (check.ok) continue;
    const reason = `Email ${check.reason}`.slice(0, 500);
    byReason.set(reason, [...(byReason.get(reason) ?? []), r.id]);
  }
  for (const [reason, ids] of byReason) {
    for (let i = 0; i < ids.length; i += 1000) {
      await trx
        .updateTable("email_campaign_recipients")
        .set({ status: "skipped", skipReason: reason })
        .where("id", "in", ids.slice(i, i + 1000))
        .execute();
    }
  }
}

// ── Pause / resume / cancel ──────────────────────────────────────────────

export async function pauseCampaign(opts: { id: string; organizationId: string; reason?: string }) {
  const row = await db
    .updateTable("email_campaigns")
    .set({ status: "paused", pausedReason: opts.reason ?? "Paused by an admin." })
    .where("id", "=", opts.id)
    .where("organizationId", "=", opts.organizationId)
    .where("status", "in", ["scheduled", "sending"])
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    const c = await getCampaign(opts);
    throw new ConflictError(`A ${c.status} campaign cannot be paused.`);
  }
  return row;
}

/**
 * Resume a paused campaign. The warm-up health window restarts here: the
 * person has had the chance to clean the list (the bounced addresses are
 * already suppressed), so what comes next is judged on its own.
 */
export async function resumeCampaign(opts: { id: string; organizationId: string; now?: Date }) {
  const now = opts.now ?? new Date();
  assertBulkSenderAllowed();
  const c = await getCampaign(opts);
  if (c.status !== "paused") throw new ConflictError(`A ${c.status} campaign cannot be resumed.`);
  if (!c.startedAt) {
    // Paused before it ever started (a scheduled campaign): back to scheduled.
    return await db
      .updateTable("email_campaigns")
      .set({ status: "scheduled", pausedReason: null })
      .where("id", "=", c.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return await db
    .updateTable("email_campaigns")
    .set({ status: "sending", pausedReason: null, healthWindowStart: now, nextColdBatchAt: now })
    .where("id", "=", c.id)
    .where("status", "=", "paused")
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function cancelCampaign(opts: { id: string; organizationId: string }) {
  const c = await getCampaign(opts);
  if (c.status === "sent" || c.status === "cancelled") {
    throw new ConflictError(`A ${c.status} campaign cannot be cancelled.`);
  }
  return await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("email_campaign_recipients")
      .set({ status: "skipped", skipReason: "Campaign cancelled." })
      .where("campaignId", "=", c.id)
      .where("status", "=", "pending")
      .execute();
    // Released but not delivered yet: stop those too.
    await trx
      .updateTable("email_outbox")
      .set({ status: "cancelled" })
      .where("source", "=", campaignSource(c.id))
      .where("status", "=", "pending")
      .execute();
    return await trx
      .updateTable("email_campaigns")
      .set({ status: "cancelled", completedAt: new Date() })
      .where("id", "=", c.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

// ── The runner step ──────────────────────────────────────────────────────

export interface AdvanceResult {
  campaigns: number;
  queued: number;
  paused: number;
  completed: number;
}

function campaignsEnabled(): boolean {
  try {
    const v = (getEnv("MAILING_CAMPAIGNS_ENABLED") ?? "1").toLowerCase();
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
}

/** One pass over live campaigns. Called by the job runner every tick. */
export async function advanceCampaigns(opts: { now?: Date } = {}): Promise<AdvanceResult> {
  const now = opts.now ?? new Date();
  const result: AdvanceResult = { campaigns: 0, queued: 0, paused: 0, completed: 0 };
  if (!campaignsEnabled()) return result;

  const live = await db
    .selectFrom("email_campaigns")
    .select(["id"])
    .where((eb) =>
      eb.or([
        eb("status", "=", "sending"),
        eb.and([eb("status", "=", "scheduled"), eb("scheduledAt", "<=", now)]),
      ])
    )
    .orderBy("updatedAt", "asc")
    .limit(CAMPAIGNS_PER_TICK)
    .execute();

  for (const { id } of live) {
    try {
      const step = await advanceOne(id, now);
      if (!step) continue;
      result.campaigns++;
      result.queued += step.queued;
      if (step.outcome === "paused") result.paused++;
      if (step.outcome === "sent") result.completed++;
    } catch (err) {
      log.error("Campaign advance failed", { source: LOG_SOURCE, campaignId: id }, err as Error);
    }
  }
  return result;
}

interface StepResult {
  queued: number;
  outcome: "sending" | "paused" | "sent";
}

async function advanceOne(id: string, now: Date): Promise<StepResult | null> {
  return await db.transaction().execute(async (trx) => {
    const campaign = await trx
      .selectFrom("email_campaigns")
      .selectAll()
      .where("id", "=", id)
      .where("status", "in", ["scheduled", "sending"])
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!campaign) return null;

    // The sender is re-checked at every release: a schedule set last week
    // runs on whatever this pod is configured with now.
    const sender = bulkSenderStatus();
    if (!sender.allowed) {
      await setPaused(trx, campaign.id, sender.message);
      return { queued: 0, outcome: "paused" as const };
    }

    let c = campaign;
    if (c.status === "scheduled") {
      await snapshotRecipients(trx, c);
      c = await trx
        .updateTable("email_campaigns")
        .set({ status: "sending", startedAt: now, healthWindowStart: now, nextColdBatchAt: now })
        .where("id", "=", c.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    const health = await coldHealth(trx, c);
    if (health.unhealthy) {
      await setPaused(trx, c.id, health.reason);
      log.warn("Campaign paused by warm-up threshold", {
        source: LOG_SOURCE,
        feature: "warmup",
        campaignId: c.id,
        organizationId: c.organizationId,
        released: health.released,
        bounced: health.bounced,
        complained: health.complained,
      });
      return { queued: 0, outcome: "paused" as const };
    }

    let queued = 0;

    // Warm recipients: subscribed through the app, or mailed before.
    const warm = await trx
      .selectFrom("email_campaign_recipients")
      .select(["id", "contactId", "email"])
      .where("campaignId", "=", c.id)
      .where("status", "=", "pending")
      .where("cold", "=", false)
      .limit(CAMPAIGN_RELEASE_CHUNK)
      .execute();
    queued += await release(trx, c, warm, 0, now);

    // Cold recipients: one ramp batch, when its time has come.
    if (!c.nextColdBatchAt || c.nextColdBatchAt.getTime() <= now.getTime()) {
      const size = WARMUP_BATCH_SIZES[Math.min(c.warmupStep, WARMUP_BATCH_SIZES.length - 1)];
      const cold = await trx
        .selectFrom("email_campaign_recipients")
        .select(["id", "contactId", "email"])
        .where("campaignId", "=", c.id)
        .where("status", "=", "pending")
        .where("cold", "=", true)
        .orderBy("createdAt", "asc")
        .limit(size)
        .execute();
      if (cold.length > 0) {
        queued += await release(trx, c, cold, c.warmupStep + 1, now);
        await trx
          .updateTable("email_campaigns")
          .set({
            warmupStep: c.warmupStep + 1,
            nextColdBatchAt: new Date(now.getTime() + WARMUP_BATCH_INTERVAL_MS),
          })
          .where("id", "=", c.id)
          .execute();
      }
    }

    const left = await trx
      .selectFrom("email_campaign_recipients")
      .select(["id"])
      .where("campaignId", "=", c.id)
      .where("status", "=", "pending")
      .limit(1)
      .executeTakeFirst();
    if (!left) {
      await trx
        .updateTable("email_campaigns")
        .set({ status: "sent", completedAt: now })
        .where("id", "=", c.id)
        .execute();
      return { queued, outcome: "sent" as const };
    }
    return { queued, outcome: "sending" as const };
  });
}

async function setPaused(trx: Kysely<Database>, id: string, reason: string): Promise<void> {
  await trx
    .updateTable("email_campaigns")
    .set({ status: "paused", pausedReason: reason.slice(0, 2000) })
    .where("id", "=", id)
    .execute();
}

export function campaignSource(campaignId: string): string {
  return `campaign:${campaignId}`;
}

/** Queue one batch into the outbox, inside the campaign's transaction. */
async function release(
  trx: Kysely<Database>,
  c: EmailCampaignRow,
  rows: ReadonlyArray<{ id: string; contactId: string; email: string }>,
  batch: number,
  now: Date,
): Promise<number> {
  if (rows.length === 0) return 0;
  for (const r of rows) {
    const content = withUnsubscribeFooter(c, r.email);
    const { row: outbox } = await enqueueEmail({
      to: r.email,
      subject: c.subject,
      text: content.text,
      html: content.html ?? undefined,
      organizationId: c.organizationId,
      idempotencyKey: `campaign:${c.id}:${r.contactId}`,
      source: campaignSource(c.id),
      sendAt: now,
    }, trx);
    await trx
      .updateTable("email_campaign_recipients")
      .set({ status: "queued", outboxId: outbox.id, queuedAt: now, batch })
      .where("id", "=", r.id)
      .execute();
  }
  const contactIds = rows.map((r) => r.contactId);
  for (let i = 0; i < contactIds.length; i += 1000) {
    await trx
      .updateTable("email_contacts")
      .set({ firstSentAt: now })
      .where("id", "in", contactIds.slice(i, i + 1000))
      .where("firstSentAt", "is", null)
      .execute();
  }
  return rows.length;
}

/** The visible unsubscribe link every campaign carries (CAN-SPAM, and basic decency). */
export function withUnsubscribeFooter(
  c: Pick<EmailCampaignRow, "textBody" | "htmlBody" | "organizationId">,
  email: string,
): { text: string; html: string | null } {
  const url = unsubscribeUrl({ email, organizationId: c.organizationId });
  const text =
    `${c.textBody.trimEnd()}\n\n--\nYou are receiving this because you are on the ${BRAND.name} mailing list.\nUnsubscribe: ${url}\n`;
  if (!c.htmlBody) return { text, html: null };
  const footer =
    `<p style="font-size:12px;color:#6b7280;margin-top:32px">You are receiving this because you are on the ${
      escapeHtml(BRAND.name)
    } mailing list. <a href="${escapeHtml(url)}">Unsubscribe</a>.</p>`;
  const html = /<\/body>/i.test(c.htmlBody)
    ? c.htmlBody.replace(/<\/body>/i, `${footer}</body>`)
    : `${c.htmlBody}${footer}`;
  return { text, html };
}

// ── Health + report ──────────────────────────────────────────────────────

interface ColdHealth {
  released: number;
  bounced: number;
  complained: number;
  unhealthy: boolean;
  reason: string;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;
}

async function coldHealth(trx: Kysely<Database>, c: EmailCampaignRow): Promise<ColdHealth> {
  const since = c.healthWindowStart ?? c.startedAt ?? new Date(0);
  const row = await trx
    .selectFrom("email_campaign_recipients")
    .select((eb) => [
      eb.fn.count<string>("id").filterWhere("status", "in", ["queued", "bounced", "complained"]).as(
        "released",
      ),
      eb.fn.count<string>("id").filterWhere("status", "=", "bounced").as("bounced"),
      eb.fn.count<string>("id").filterWhere("status", "=", "complained").as("complained"),
    ])
    .where("campaignId", "=", c.id)
    .where("cold", "=", true)
    .where("queuedAt", ">=", since)
    .executeTakeFirst();
  const released = Number(row?.released ?? 0);
  const bounced = Number(row?.bounced ?? 0);
  const complained = Number(row?.complained ?? 0);
  const base = { released, bounced, complained, unhealthy: false, reason: "" };
  if (released < WARMUP_MIN_SAMPLE) return base;

  const bounceRate = bounced / released;
  const complaintRate = complained / released;
  const problems: string[] = [];
  if (bounceRate > WARMUP_MAX_HARD_BOUNCE_RATE) {
    problems.push(
      `${bounced} hard bounces (${pct(bounceRate)}, the limit is ${
        pct(WARMUP_MAX_HARD_BOUNCE_RATE)
      })`,
    );
  }
  if (complaintRate > WARMUP_MAX_COMPLAINT_RATE) {
    problems.push(
      `${complained} spam complaints (${pct(complaintRate)}, the limit is ${
        pct(WARMUP_MAX_COMPLAINT_RATE)
      })`,
    );
  }
  if (problems.length === 0) return base;
  return {
    ...base,
    unhealthy: true,
    reason: `Paused to protect your sender: the first ${released} imported contacts produced ` +
      `${problems.join(" and ")}. A list like this usually holds many old or never-confirmed ` +
      "addresses, and mailing the rest would get your sending domain filtered or blocked. The " +
      "addresses that bounced or complained are already suppressed. Check where the list came " +
      "from and remove anyone who did not ask for your email, then resume, or cancel the campaign.",
  };
}

export interface CampaignReport {
  campaign: EmailCampaignRow;
  counts: Record<EmailCampaignRecipientStatus, number> & { total: number; coldPending: number };
  warmup: {
    nextBatchSize: number | null;
    nextBatchAt: Date | null;
    thresholds: { maxHardBounceRate: number; maxComplaintRate: number; minSample: number };
  };
  /** Up to 200 skipped recipients with their reasons. */
  skipped: Array<{ email: string; reason: string | null }>;
}

export async function campaignReport(
  opts: { id: string; organizationId: string },
): Promise<CampaignReport> {
  const campaign = await getCampaign(opts);
  const rows = await db
    .selectFrom("email_campaign_recipients")
    .select((eb) => ["status", "cold", eb.fn.countAll<string>().as("n")])
    .where("campaignId", "=", campaign.id)
    .groupBy(["status", "cold"])
    .execute();
  const counts = {
    pending: 0,
    queued: 0,
    skipped: 0,
    bounced: 0,
    complained: 0,
    total: 0,
    coldPending: 0,
  };
  for (const r of rows) {
    const n = Number(r.n);
    counts[r.status] += n;
    counts.total += n;
    if (r.status === "pending" && r.cold) counts.coldPending += n;
  }
  const skipped = await db
    .selectFrom("email_campaign_recipients")
    .select(["email", "skipReason"])
    .where("campaignId", "=", campaign.id)
    .where("status", "=", "skipped")
    .limit(200)
    .execute();
  const live: EmailCampaignStatus[] = ["sending", "scheduled", "paused"];
  return {
    campaign,
    counts,
    warmup: {
      nextBatchSize: counts.coldPending > 0 && live.includes(campaign.status)
        ? Math.min(
          counts.coldPending,
          WARMUP_BATCH_SIZES[Math.min(campaign.warmupStep, WARMUP_BATCH_SIZES.length - 1)],
        )
        : null,
      nextBatchAt: counts.coldPending > 0 ? campaign.nextColdBatchAt : null,
      thresholds: {
        maxHardBounceRate: WARMUP_MAX_HARD_BOUNCE_RATE,
        maxComplaintRate: WARMUP_MAX_COMPLAINT_RATE,
        minSample: WARMUP_MIN_SAMPLE,
      },
    },
    skipped: skipped.map((s) => ({ email: s.email, reason: s.skipReason })),
  };
}
