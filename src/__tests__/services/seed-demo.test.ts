/**
 * Unit tests for scripts/seed-demo.ts -- the DEMO_MODE curated demo seed.
 *
 * Covers idempotency (run twice -> stable row counts, same org id) and the
 * "wipes accumulated public writes" contract (a stray purchase/invite
 * attached to the demo org is gone after a re-seed).
 */

import { assert, assertEquals } from "@std/assert";
import { db, ensureTestSchema } from "@/db/client.ts";
import { DEMO_ORG_SLUG, DEMO_USERS, seedDemo } from "../../../scripts/seed-demo.ts";

// Provision this worker's isolated test schema BEFORE any test runs (same
// top-level-await pattern as helpers.ts) -- pre-warms the DB connection
// pool outside any test's op-sanitizer boundary and makes `deno test
// --parallel` schema-isolated across worker processes.
await ensureTestSchema();

/** Deletes the demo org (cascades to demo users, purchases, invites). */
async function cleanupDemoOrg(): Promise<void> {
  await db.deleteFrom("organizations").where("slug", "=", DEMO_ORG_SLUG).execute();
}

// The postgres.js connection pool keeps a background keep-alive timer/read
// op alive across tests -- Deno's default op/resource sanitizer flags that
// as a "leak" even though it's normal pool behavior. Same pattern as
// product_service.test.ts's `test()` wrapper.
function test(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

test("seedDemo: creates the demo org + all demo users on first run", async () => {
  await cleanupDemoOrg();
  try {
    const result = await seedDemo();

    assert(result.orgId.length > 0);
    assertEquals(result.usersUpserted, DEMO_USERS.length);

    const org = await db
      .selectFrom("organizations")
      .selectAll()
      .where("slug", "=", DEMO_ORG_SLUG)
      .executeTakeFirstOrThrow();
    assertEquals(org.id, result.orgId);

    const users = await db
      .selectFrom("users")
      .select(["email", "role", "organizationId"])
      .where("organizationId", "=", result.orgId)
      .execute();
    assertEquals(users.length, DEMO_USERS.length);
    for (const demoUser of DEMO_USERS) {
      const row = users.find((u) => u.email === demoUser.email);
      assert(row, `expected demo user ${demoUser.email} to be seeded`);
      assertEquals(row!.role, demoUser.role);
    }
  } finally {
    await cleanupDemoOrg();
  }
});

test("seedDemo: idempotent -- running twice keeps the same org id and stable row counts", async () => {
  await cleanupDemoOrg();
  try {
    const first = await seedDemo();
    const second = await seedDemo();

    assertEquals(second.orgId, first.orgId);
    assertEquals(second.usersUpserted, DEMO_USERS.length);

    const orgs = await db
      .selectFrom("organizations")
      .select("id")
      .where("slug", "=", DEMO_ORG_SLUG)
      .execute();
    assertEquals(orgs.length, 1, "re-running the seed must not duplicate the demo org");

    const users = await db
      .selectFrom("users")
      .select("id")
      .where("organizationId", "=", first.orgId)
      .execute();
    assertEquals(users.length, DEMO_USERS.length, "re-running the seed must not duplicate demo users");
  } finally {
    await cleanupDemoOrg();
  }
});

test("seedDemo: wipes accumulated public writes (stray purchase + invite) on re-seed", async () => {
  await cleanupDemoOrg();
  try {
    const first = await seedDemo();

    // Simulate accumulated public writes against the demo org: a visitor's
    // test-mode checkout (purchase) and a pending team invite.
    const product = await db
      .insertInto("products")
      .values({
        productKey: `seed-demo-test-product-${Date.now()}`,
        name: "Scratch product for this test",
        type: "one_time",
        priceCents: 100,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("purchases")
      .values({
        organizationId: first.orgId,
        productId: product.id,
        status: "active",
      })
      .execute();

    const owner = await db
      .selectFrom("users")
      .select("id")
      .where("organizationId", "=", first.orgId)
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("invites")
      .values({
        organizationId: first.orgId,
        invitedBy: owner.id,
        email: "stray-visitor-invite@example.com",
        role: "viewer",
        token: `seed-demo-test-token-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .execute();

    const beforePurchases = await db
      .selectFrom("purchases")
      .select("id")
      .where("organizationId", "=", first.orgId)
      .execute();
    const beforeInvites = await db
      .selectFrom("invites")
      .select("id")
      .where("organizationId", "=", first.orgId)
      .execute();
    assertEquals(beforePurchases.length, 1);
    assertEquals(beforeInvites.length, 1);

    const second = await seedDemo();
    assertEquals(second.orgId, first.orgId);
    assertEquals(second.purchasesWiped, 1);
    assertEquals(second.invitesWiped, 1);

    const afterPurchases = await db
      .selectFrom("purchases")
      .select("id")
      .where("organizationId", "=", first.orgId)
      .execute();
    const afterInvites = await db
      .selectFrom("invites")
      .select("id")
      .where("organizationId", "=", first.orgId)
      .execute();
    assertEquals(afterPurchases.length, 0, "purchases scoped to the demo org must be wiped on re-seed");
    assertEquals(afterInvites.length, 0, "invites scoped to the demo org must be wiped on re-seed");

    // Cleanup the scratch product row (not FK'd to the org, so seedDemo
    // doesn't touch it).
    await db.deleteFrom("products").where("id", "=", product.id).execute();
  } finally {
    await cleanupDemoOrg();
  }
});
