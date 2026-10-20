/**
 * Chipp Payments mirror: keeps this app's own `products` and `purchases`
 * tables in step with the sales Chipp settles.
 *
 * Two ways in, one code path (`applyChippEntitlement`):
 *   - push: Chipp POSTs a signed `entitlement.changed` event to
 *     /api/events/inbox (EVENTS_INBOX_SECRET), and the event consumer runs
 *     the handler registered by `registerChippEntitlementHandlers()`.
 *   - pull: `syncChippEntitlements(orgId)` reads /entitlements from the
 *     broker. The checkout success return and the billing page call it, so
 *     a preview (which Chipp cannot push to) and a missed delivery both
 *     catch up.
 *
 * Every write is idempotent and ordered by Chipp's `seq`: a change whose
 * seq is not newer than the row's is ignored, so an old event that arrives
 * late never undoes a newer one.
 *
 * Every row records the mode Chipp sold in (`chipp_mode`). A sale in any
 * other mode than the one this app runs in (`chippAccessMode()`) is not
 * written, and `product.service.ts` counts only rows of the current mode, so
 * a test-card sale can never unlock a live app.
 *
 * `requirePurchase`, `hasActiveEntitlement` and `billingStore` keep their
 * API: they read the local `purchases` table, which this module fills.
 */

import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { registerEventHandler } from "@/lib/events.ts";
import {
  chippAccessMode,
  type ChippCatalog,
  chippPaymentsActive,
  type ChippProduct,
  customerRefForOrg,
  fetchChippEntitlements,
  listChippProducts,
  orgIdFromCustomerRef,
} from "@/lib/chipp-payments.ts";

export const ENTITLEMENT_CHANGED_TOPIC = "entitlement.changed";

const payloadSchema = z.object({
  purchaseId: z.string().uuid(),
  productKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  customerRef: z.string().min(1).max(128),
  mode: z.enum(["test", "live"]),
  status: z.string().max(32),
  entitled: z.boolean(),
  disputeStatus: z.string().max(16).optional(),
  currentPeriodEnd: z.string().datetime().nullish(),
  amountCents: z.number().int().nonnegative().optional(),
  currency: z.string().max(3).optional(),
  seq: z.number().int().nonnegative(),
});

export type ChippEntitlementPayload = z.infer<typeof payloadSchema>;

/** Pure: the local purchase_status for a Chipp sale. */
export function localPurchaseStatus(
  p: Pick<ChippEntitlementPayload, "status" | "entitled">,
): "active" | "past_due" | "canceled" | "refunded" {
  if (p.status === "refunded") return "refunded";
  if (!p.entitled) return "canceled";
  return p.status === "past_due" ? "past_due" : "active";
}

/** Upserts one catalog product by key. Never touches a product sold with the app's own Stripe key. */
async function upsertMirrorProduct(p: ChippProduct): Promise<string | null> {
  const row = await sql<{ id: string }>`
    INSERT INTO products (product_key, name, description, type, price_cents, currency, billing_interval, active)
    VALUES (${p.key}, ${p.name}, ${p.description}, ${p.kind}::product_type, ${p.amountCents}, ${p.currency},
            ${p.kind === "subscription" ? p.interval : null}, TRUE)
    ON CONFLICT (product_key) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      price_cents = EXCLUDED.price_cents,
      currency = EXCLUDED.currency,
      billing_interval = EXCLUDED.billing_interval,
      active = TRUE,
      updated_at = NOW()
    WHERE products.stripe_product_id IS NULL
    RETURNING id
  `.execute(db);
  if (row.rows[0]) return row.rows[0].id;
  const existing = await db.selectFrom("products").select(["id"]).where("productKey", "=", p.key)
    .executeTakeFirst();
  return existing?.id ?? null;
}

/** Mirrors Chipp's catalog into `products` (no Stripe ids). Returns key -> product id. */
export async function syncChippCatalog(given?: ChippCatalog): Promise<Map<string, string>> {
  const catalog = given ?? await listChippProducts();
  const out = new Map<string, string>();
  for (const p of catalog.products) {
    const id = await upsertMirrorProduct(p);
    if (id) out.set(p.key, id);
  }
  return out;
}

async function productIdForKey(productKey: string): Promise<string | null> {
  const row = await db.selectFrom("products").select(["id"]).where("productKey", "=", productKey)
    .executeTakeFirst();
  if (row) return row.id;
  // A product the builder added after this app last synced.
  return (await syncChippCatalog()).get(productKey) ?? null;
}

export type ApplyOutcome = "applied" | "stale" | "other_mode" | "unknown_org" | "unknown_product";

/** Applies one Chipp entitlement to the local mirror. Idempotent, ordered by seq. */
export async function applyChippEntitlement(raw: unknown): Promise<ApplyOutcome> {
  const p = payloadSchema.parse(raw);
  // A sale in another mode (a test sale reaching a live app) grants nothing.
  if (p.mode !== chippAccessMode()) return "other_mode";
  const orgId = orgIdFromCustomerRef(p.customerRef);
  if (!orgId) return "unknown_org";
  const org = await db.selectFrom("organizations").select(["id"]).where("id", "=", orgId)
    .executeTakeFirst();
  if (!org) return "unknown_org";
  const productId = await productIdForKey(p.productKey);
  if (!productId) return "unknown_product";

  const status = localPurchaseStatus(p);
  const periodEnd = p.currentPeriodEnd ? new Date(p.currentPeriodEnd) : null;
  const res = await sql<{ id: string }>`
    INSERT INTO purchases (organization_id, product_id, status, amount_cents, currency, current_period_end,
                           canceled_at, source, chipp_purchase_id, chipp_seq, chipp_mode)
    VALUES (${orgId}, ${productId}, ${status}::purchase_status, ${p.amountCents ?? 0}, ${
    p.currency ?? "usd"
  },
            ${periodEnd}, ${
    status === "canceled" ? new Date() : null
  }, 'chipp_payments', ${p.purchaseId}, ${p.seq}, ${p.mode})
    ON CONFLICT (chipp_purchase_id) WHERE chipp_purchase_id IS NOT NULL DO UPDATE SET
      status = EXCLUDED.status,
      current_period_end = EXCLUDED.current_period_end,
      canceled_at = CASE WHEN EXCLUDED.status = 'canceled' THEN COALESCE(purchases.canceled_at, NOW()) ELSE NULL END,
      chipp_seq = EXCLUDED.chipp_seq,
      chipp_mode = EXCLUDED.chipp_mode,
      updated_at = NOW()
    WHERE purchases.chipp_seq IS NULL OR purchases.chipp_seq < EXCLUDED.chipp_seq
    RETURNING id
  `.execute(db);
  return res.rows.length > 0 ? "applied" : "stale";
}

/** Pulls the org's entitlements from Chipp and applies them. Never throws. */
export async function syncChippEntitlements(organizationId: string): Promise<number> {
  if (!chippPaymentsActive()) return 0;
  try {
    const ref = customerRefForOrg(organizationId);
    const rows = await fetchChippEntitlements(ref);
    // The broker answers for this app's own mode.
    const mode = chippAccessMode();
    let applied = 0;
    for (const r of rows) {
      const outcome = await applyChippEntitlement({ ...r, mode: r.mode ?? mode, customerRef: ref });
      if (outcome === "applied") applied++;
    }
    return applied;
  } catch (err) {
    log.warn("Chipp Payments entitlement sync failed; the next sync or push will catch up", {
      source: "chipp-payments",
      organizationId,
    }, err);
    return 0;
  }
}

/** The inbox handler for `entitlement.changed`. A malformed payload fails the delivery (dead-letters after retries). */
export async function handleEntitlementChanged(
  event: { payload: Record<string, unknown> },
): Promise<void> {
  const outcome = await applyChippEntitlement(event.payload);
  if (outcome === "unknown_org" || outcome === "unknown_product" || outcome === "other_mode") {
    // A sale for an org this database does not have (another environment),
    // a product Chipp no longer lists, or a sale in another mode than this
    // app's. Nothing to grant here.
    log.info("Chipp Payments entitlement skipped", { source: "chipp-payments", outcome });
  }
}

/** Registers the inbox handler. Call from src/events/handlers.ts. */
export function registerChippEntitlementHandlers(): void {
  registerEventHandler(ENTITLEMENT_CHANGED_TOPIC, handleEntitlementChanged, {
    retries: 8,
    name: "handleEntitlementChanged",
  });
}
