/**
 * Unit tests for src/jobs/demo-reseed-loop.ts -- the DEMO_MODE nightly
 * re-seed loop.
 *
 * Covers:
 *   - `startDemoReseedLoop()` is a hard no-op under NODE_ENV=test (the
 *     loop's own gate, same as the inbound-email reaper) -- no background
 *     timer starts, ever, during the suite.
 *   - `runDemoReseedCycle()` (the per-cycle unit the scheduled tick calls)
 *     is dormant when DEMO_MODE is off: it never touches the database.
 *   - Multi-replica safety: two concurrent cycles (simulating two pods
 *     racing the same tick) under DEMO_MODE=1 only let ONE of them
 *     actually run the seed -- the advisory lock skips the other.
 */

import { assert, assertEquals } from "@std/assert";
import { db, ensureTestSchema } from "@/db/client.ts";
import { DEMO_ORG_SLUG } from "../../scripts/seed-demo.ts";
import {
  __peekDemoReseedLoopStateForTest,
  __resetDemoReseedLoopForTest,
  runDemoReseedCycle,
  startDemoReseedLoop,
  stopDemoReseedLoop,
} from "@/jobs/demo-reseed-loop.ts";

await ensureTestSchema();

/** Runs `fn` with env vars temporarily overridden, restoring them after. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) prev[key] = Deno.env.get(key);
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };
  apply(overrides);
  try {
    await fn();
  } finally {
    apply(prev);
  }
}

/** Runs `fn` with DEMO_MODE temporarily overridden, restoring it after. */
function withDemoMode(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  return withEnv({ DEMO_MODE: value }, fn);
}

async function cleanupDemoOrg(): Promise<void> {
  await db.deleteFrom("organizations").where("slug", "=", DEMO_ORG_SLUG).execute();
}

// The postgres.js pool's background keep-alive timer/read trips Deno's
// default op/resource sanitizer -- same pattern as product_service.test.ts.
function test(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

test("startDemoReseedLoop: no-op under NODE_ENV=test, even with DEMO_MODE=1 and the DB configured", async () => {
  // Force NODE_ENV=test explicitly rather than relying on ambient sandbox
  // env -- this asserts the loop's OWN gate (mirrors
  // inbound-email-reaper's "NODE_ENV=test -> immediate no-op") regardless
  // of what the surrounding shell happens to export.
  await withEnv({ NODE_ENV: "test", DEMO_MODE: "1" }, async () => {
    __resetDemoReseedLoopForTest();
    startDemoReseedLoop();
    const state = __peekDemoReseedLoopStateForTest();
    assertEquals(state.running, false, "loop must stay dormant during the test suite");
    assertEquals(state.timerScheduled, false, "no background timer may be scheduled in tests");
    stopDemoReseedLoop(); // idempotent no-op safety net
  });
});

test("startDemoReseedLoop: no-op when DEMO_MODE is off, even outside NODE_ENV=test", async () => {
  await withEnv({ NODE_ENV: "production", DEMO_MODE: undefined }, async () => {
    __resetDemoReseedLoopForTest();
    startDemoReseedLoop();
    const state = __peekDemoReseedLoopStateForTest();
    assertEquals(state.running, false, "a normal (non-demo) deploy must never start this loop");
    assertEquals(state.timerScheduled, false);
    stopDemoReseedLoop();
  });
});

test("runDemoReseedCycle: dormant (no DB write) when DEMO_MODE is off", async () => {
  await withDemoMode(undefined, async () => {
    await cleanupDemoOrg(); // sanity: nothing to begin with
    const outcome = await runDemoReseedCycle();
    assertEquals(outcome.ran, false);

    const org = await db
      .selectFrom("organizations")
      .select("id")
      .where("slug", "=", DEMO_ORG_SLUG)
      .executeTakeFirst();
    assertEquals(org, undefined, "DEMO_MODE off must never write the demo org");
  });
});

test("runDemoReseedCycle: two concurrent cycles under DEMO_MODE=1 -- only one actually seeds (advisory lock)", async () => {
  await withDemoMode("1", async () => {
    await cleanupDemoOrg();
    try {
      const [a, b] = await Promise.all([runDemoReseedCycle(), runDemoReseedCycle()]);

      const ranCount = [a, b].filter((o) => o.ran).length;
      assertEquals(
        ranCount,
        1,
        "exactly one concurrent cycle should win the advisory lock and run the seed",
      );

      // The demo org must exist exactly once regardless of which cycle won.
      const orgs = await db
        .selectFrom("organizations")
        .select("id")
        .where("slug", "=", DEMO_ORG_SLUG)
        .execute();
      assertEquals(orgs.length, 1);

      const winner = a.ran ? a : b;
      assert(winner.ran);
      assert(winner.result.orgId.length > 0);
    } finally {
      await cleanupDemoOrg();
    }
  });
});
