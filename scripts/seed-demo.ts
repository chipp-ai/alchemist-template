/**
 * DEMO_MODE seed -- idempotent, curated, obviously-fictional content for
 * this template's public live-demo deployment ("Acme Metrics").
 *
 * Safe to re-run any number of times (idempotency is the whole contract --
 * both the CLI and the nightly re-seed loop in
 * `src/jobs/demo-reseed-loop.ts` call this on every run):
 *
 *   - Upserts (`ON CONFLICT`) the stable demo org (by slug) and stable demo
 *     users (by email) -- re-running never duplicates rows or changes ids.
 *   - WIPES accumulated public writes scoped to the demo org -- test-mode
 *     purchases from a visitor clicking "buy" on the demo product catalog,
 *     and any pending team invites -- so the demo resets to a clean,
 *     curated state instead of accumulating visitor noise forever.
 *   - Best-effort demo product catalog via the template's built-in Stripe
 *     monetization layer (`src/services/product.service.ts`). Only
 *     attempted when Stripe is configured; skipped (logged, non-fatal)
 *     otherwise so the seed still succeeds with no Stripe creds at all
 *     (sandbox, CI, a fresh demo deploy before Stripe is wired up). This
 *     script does NOT re-check the key is test-mode -- `main.ts` already
 *     refuses to boot under DEMO_MODE with a live-mode key
 *     (`assertNoLiveStripeKeyInDemoMode`), so by the time this ever runs
 *     in a demo deployment, Stripe (if configured at all) is guaranteed
 *     test-mode.
 *
 * Fictional names only: this is a public demo, so invented brand/person
 * names are fine here (the banner + naming make fictionality explicit) --
 * never a realistic persona or a real organization.
 *
 * Run directly:  `deno run --env --allow-all scripts/seed-demo.ts`
 * Run nightly:   `src/jobs/demo-reseed-loop.ts` (active only when
 *                `DEMO_MODE=1`; dormant loop is a no-op otherwise).
 */

import { db, isDatabaseConfigured } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { getStripe } from "@/lib/stripe.ts";
import { createProduct, type NewProductInput } from "@/services/product.service.ts";
import { ConflictError } from "@/utils/errors.ts";

const LOG_SOURCE = "seed-demo";

/** Stable natural key for the demo org -- upsert target, never regenerated. */
export const DEMO_ORG_SLUG = "acme-metrics-demo";
export const DEMO_ORG_NAME = "Acme Metrics (Demo)";

/** Stable, obviously-fictional demo personas -- upserted by email. */
export const DEMO_USERS: ReadonlyArray<
  { email: string; name: string; role: "owner" | "admin" | "editor" }
> = [
  { email: "demo-owner@acme-metrics.example", name: "Nova Higgins", role: "owner" },
  { email: "demo-admin@acme-metrics.example", name: "Baxter Quill", role: "admin" },
  { email: "demo-editor@acme-metrics.example", name: "Wren Okafor", role: "editor" },
];

/** Stable demo product-catalog rows -- upserted by productKey (Stripe-backed). */
export const DEMO_PRODUCTS: ReadonlyArray<NewProductInput> = [
  {
    productKey: "acme-metrics-pro-dashboard",
    name: "Pro Dashboard Pack",
    description: "Fictional demo add-on -- extra charts + CSV exports for Acme Metrics.",
    type: "one_time",
    priceCents: 4900,
  },
  {
    productKey: "acme-metrics-team-plan",
    name: "Acme Metrics Team Plan",
    description: "Fictional demo subscription -- one seat on the Acme Metrics workspace.",
    type: "subscription",
    priceCents: 1900,
    interval: "month",
  },
];

export interface SeedDemoResult {
  orgId: string;
  usersUpserted: number;
  purchasesWiped: number;
  invitesWiped: number;
  productsCreated: number;
  productsSkippedReason?: string;
}

const SKIPPED_RESULT: SeedDemoResult = {
  orgId: "",
  usersUpserted: 0,
  purchasesWiped: 0,
  invitesWiped: 0,
  productsCreated: 0,
  productsSkippedReason: "db-not-configured",
};

/**
 * Idempotent demo seed. Safe to call repeatedly (CLI, boot, nightly loop).
 * Never throws on a missing/misconfigured Stripe -- only a DB failure
 * propagates, since the org + users are the load-bearing part of the demo.
 */
export async function seedDemo(): Promise<SeedDemoResult> {
  if (!isDatabaseConfigured()) {
    log.info("seed-demo: database not configured -- skipping", { source: LOG_SOURCE });
    return SKIPPED_RESULT;
  }

  const org = await db
    .insertInto("organizations")
    .values({
      name: DEMO_ORG_NAME,
      slug: DEMO_ORG_SLUG,
      subscriptionTier: "FREE",
    })
    .onConflict((oc) => oc.column("slug").doUpdateSet({ name: DEMO_ORG_NAME }))
    .returningAll()
    .executeTakeFirstOrThrow();

  let usersUpserted = 0;
  for (const demoUser of DEMO_USERS) {
    await db
      .insertInto("users")
      .values({
        email: demoUser.email,
        name: demoUser.name,
        role: demoUser.role,
        organizationId: org.id,
        emailVerified: true,
      })
      .onConflict((oc) =>
        oc.column("email").doUpdateSet({
          name: demoUser.name,
          role: demoUser.role,
          organizationId: org.id,
          emailVerified: true,
        })
      )
      .execute();
    usersUpserted++;
  }

  // Wipe accumulated public writes scoped to the demo org -- visitor
  // test-mode checkouts and any pending team invites -- BEFORE re-seeding
  // so the demo resets to a clean, curated state on every run instead of
  // growing forever.
  const wipedPurchases = await db
    .deleteFrom("purchases")
    .where("organizationId", "=", org.id)
    .executeTakeFirst();
  const wipedInvites = await db
    .deleteFrom("invites")
    .where("organizationId", "=", org.id)
    .executeTakeFirst();

  let productsCreated = 0;
  let productsSkippedReason: string | undefined;
  const stripe = getStripe();
  if (!stripe) {
    productsSkippedReason = "stripe-not-configured";
    log.info("seed-demo: Stripe not configured -- skipping demo product catalog", {
      source: LOG_SOURCE,
    });
  } else {
    for (const product of DEMO_PRODUCTS) {
      try {
        await createProduct(product, stripe);
        productsCreated++;
      } catch (err) {
        if (err instanceof ConflictError) continue; // already seeded -- idempotent no-op
        log.warn(
          "seed-demo: failed to create demo product (non-fatal)",
          { source: LOG_SOURCE, productKey: product.productKey },
          err,
        );
      }
    }
  }

  const result: SeedDemoResult = {
    orgId: org.id,
    usersUpserted,
    purchasesWiped: Number(wipedPurchases.numDeletedRows ?? 0),
    invitesWiped: Number(wipedInvites.numDeletedRows ?? 0),
    productsCreated,
    productsSkippedReason,
  };

  log.info("seed-demo: seed complete", { source: LOG_SOURCE, ...result });
  return result;
}

if (import.meta.main) {
  const result = await seedDemo();
  console.log(JSON.stringify(result, null, 2));
}
