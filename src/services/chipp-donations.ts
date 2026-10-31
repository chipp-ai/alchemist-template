/**
 * Chipp Payments donations mirror: keeps this app's `chipp_donations`
 * table in step with the gifts Chipp settles.
 *
 * A donor gives through Stripe Checkout on the org's own Stripe account
 * (Chipp makes the session; this app holds no Stripe key and no webhook)
 * and needs no account in this app. So a gift is keyed on Chipp's purchase
 * id. Two ways in, one code path (`applyChippDonation`):
 *   - push: the `entitlement.changed` inbox event with kind = 'donation'
 *     (src/services/chipp-entitlements.ts routes it here);
 *   - confirm: the thank-you page names its gift (purchase id plus the
 *     Checkout Session id from the return URL) and the server reads it from
 *     Chipp (`confirmChippDonation`). That covers a Builder preview, which
 *     Chipp does not push to, and a missed delivery.
 *
 * Every write is ordered by Chipp's `seq`. A gift in another mode than
 * this app runs in (a test gift reaching a live app) is not written.
 *
 * Raw SQL on purpose: an app that installs these files from the
 * chipp-payments pack keeps its own src/db/schema.ts.
 */

import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/client.ts";
import { chippAccessMode, type ChippDonationReceipt, lookupChippDonation } from "@/lib/chipp-payments.ts";

const donationPayloadSchema = z.object({
  purchaseId: z.string().uuid(),
  productKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  kind: z.literal("donation"),
  mode: z.enum(["test", "live"]),
  status: z.string().max(32),
  interval: z.enum(["month", "year"]).nullish(),
  donorEmail: z.string().max(254).nullish(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().max(3).optional(),
  currentPeriodEnd: z.string().datetime().nullish(),
  seq: z.number().int().nonnegative(),
});

export type ChippDonationPayload = z.infer<typeof donationPayloadSchema>;

export type DonationApplyOutcome = "applied" | "stale" | "other_mode";

/** True when an inbox payload is a donation (sent by Chipp with kind = 'donation'). */
export function isDonationPayload(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "donation";
}

/** Applies one Chipp donation to the local mirror. Idempotent, ordered by seq. */
export async function applyChippDonation(raw: unknown): Promise<DonationApplyOutcome> {
  const p = donationPayloadSchema.parse(raw);
  if (p.mode !== chippAccessMode()) return "other_mode";
  const periodEnd = p.currentPeriodEnd ? new Date(p.currentPeriodEnd) : null;
  const res = await sql<{ id: string }>`
    INSERT INTO chipp_donations (chipp_purchase_id, product_key, donor_email, amount_cents, currency,
                                 billing_interval, status, current_period_end, chipp_seq, chipp_mode)
    VALUES (${p.purchaseId}, ${p.productKey}, ${p.donorEmail ?? null}, ${p.amountCents}, ${p.currency ?? "usd"},
            ${p.interval ?? null}, ${p.status}, ${periodEnd}, ${p.seq}, ${p.mode})
    ON CONFLICT (chipp_purchase_id) DO UPDATE SET
      donor_email = COALESCE(EXCLUDED.donor_email, chipp_donations.donor_email),
      status = EXCLUDED.status,
      current_period_end = EXCLUDED.current_period_end,
      chipp_seq = EXCLUDED.chipp_seq,
      updated_at = NOW()
    WHERE chipp_donations.chipp_seq < EXCLUDED.chipp_seq
    RETURNING id
  `.execute(db);
  return res.rows.length > 0 ? "applied" : "stale";
}

/**
 * Reads the donor's gift from Chipp and mirrors it. Returns what the
 * thank-you page shows. Chipp answers only for this app's own project
 * and mode, and only when the session id matches the gift.
 */
export async function confirmChippDonation(ref: { purchaseId: string; sessionId: string }): Promise<ChippDonationReceipt> {
  const receipt = await lookupChippDonation(ref);
  // A pending gift has nothing to mirror yet; the push or a later confirm settles it.
  if (receipt.status !== "pending" && receipt.seq !== undefined) {
    await applyChippDonation({
      purchaseId: receipt.purchaseId,
      productKey: receipt.productKey,
      kind: "donation",
      mode: chippAccessMode(),
      status: receipt.status,
      interval: receipt.interval,
      donorEmail: receipt.donorEmail ?? null,
      currentPeriodEnd: receipt.currentPeriodEnd ?? null,
      amountCents: receipt.amountCents,
      currency: receipt.currency,
      seq: receipt.seq,
    });
  }
  return receipt;
}

export interface DonationRow {
  chippPurchaseId: string;
  productKey: string;
  donorEmail: string | null;
  amountCents: number;
  currency: string;
  billingInterval: "month" | "year" | null;
  status: string;
  createdAt: Date;
}

/** The latest gifts in this app's current mode, newest first (for an admin page). */
export async function listChippDonations(limit = 50): Promise<DonationRow[]> {
  const res = await sql<DonationRow>`
    SELECT chipp_purchase_id AS "chippPurchaseId", product_key AS "productKey", donor_email AS "donorEmail",
           amount_cents AS "amountCents", currency, billing_interval AS "billingInterval", status,
           created_at AS "createdAt"
    FROM chipp_donations
    WHERE chipp_mode = ${chippAccessMode()}
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `.execute(db);
  return res.rows.map((r) => ({ ...r, amountCents: Number(r.amountCents), createdAt: new Date(r.createdAt) }));
}
