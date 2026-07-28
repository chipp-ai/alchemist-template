/**
 * Demo nightly re-seed loop -- DEMO_MODE spec item 3.
 *
 * Copies the multi-replica-safe loop shape from
 * `src/jobs/inbound-email-reaper.ts` (module-level `running` /
 * `shuttingDown` / `timerId` flags, `setTimeout(tick, 0)` kick-off so
 * ticks never overlap, a `pg_try_advisory_lock` on ONE dedicated
 * connection so only one replica re-seeds per cycle, `NODE_ENV=test`
 * immediate no-op, never-throw-at-boot).
 *
 * Differences from the reaper, both deliberate:
 *   - Gated on `isDemoMode()` (read live, per call) rather than a static
 *     "is this configured" check -- a customer deploy that never sets
 *     `DEMO_MODE=1` gets a loop that starts, takes one look, and stays
 *     permanently dormant. Re-checked every tick (not just at start) so
 *     flipping DEMO_MODE off mid-process (e.g. a config hot-reload) stops
 *     future re-seeds without a restart.
 *   - The FIRST tick fires almost immediately after boot (`setTimeout(tick, 0)`,
 *     same as the reaper) so a fresh demo deploy (or a pod restart) is
 *     seeded right away rather than waiting up to a full day. Subsequent
 *     ticks are spaced `DEMO_RESEED_INTERVAL_MS` apart (default 24h).
 *
 * The lock (`DEMO_RESEED_LOCK_ID`) is a budget optimization, not a
 * correctness requirement -- `seedDemo()` is itself idempotent (upserts by
 * stable key, scoped deletes) -- but taking it means N replicas booting at
 * once only pay the seed cost (and the wipe of accumulated public writes)
 * once per cycle instead of N times racing each other.
 */

import { sql } from "kysely";
import { db, isDatabaseConfigured } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { isDemoMode } from "@/config/demo-mode.ts";
import { seedDemo, type SeedDemoResult } from "../../scripts/seed-demo.ts";

const LOG_SOURCE = "demo-reseed-loop";

/**
 * Stable advisory-lock id for the demo nightly re-seed. Distinct from the
 * docs reindex lock (472026011), the inbound-email reaper lock
 * (749217530011), and the test-schema provisioning lock (494494).
 */
const DEMO_RESEED_LOCK_ID = 838291740022;

/** Re-seed cadence default -- once a day. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

let timerId: number | null = null;
let running = false;
let shuttingDown = false;

/** Env read that never throws (some test contexts run without --allow-env). */
function safeEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

/** Read a positive integer env var, clamped to [min, max]. Read lazily per tick. */
function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = safeEnv(key);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function intervalMs(): number {
  // Clamp [1h, 7d] -- ops can retune cadence without redeploying code, but
  // can't accidentally spin this into a hot loop or a once-a-month no-op.
  return envInt("DEMO_RESEED_INTERVAL_MS", DEFAULT_INTERVAL_MS, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
}

/**
 * Start the nightly re-seed loop. Synchronous, fire-and-forget, idempotent
 * (a second call while already running is a no-op). Dormant by construction
 * unless DEMO_MODE=1 -- a normal customer deploy never runs this loop's body.
 */
export function startDemoReseedLoop(): void {
  if (running || timerId !== null) return; // idempotent

  if ((safeEnv("NODE_ENV") ?? "development") === "test") {
    // Tests drive seedDemo() / runDemoReseedTick() directly; no background
    // timer in the suite.
    return;
  }

  if (!isDemoMode()) {
    log.info("demo reseed loop: DEMO_MODE is off -- staying dormant", { source: LOG_SOURCE });
    return;
  }

  if (!isDatabaseConfigured()) {
    log.info("demo reseed loop: database not configured -- staying dormant", {
      source: LOG_SOURCE,
    });
    return;
  }

  log.info("demo reseed loop starting", { source: LOG_SOURCE, intervalMs: intervalMs() });

  running = true;
  shuttingDown = false;
  timerId = setTimeout(tick, 0);
}

/**
 * Stop the loop. Idempotent. Safe even if the loop never started. Call
 * BEFORE closeDatabase() so no tick races the pool teardown.
 */
export function stopDemoReseedLoop(): void {
  shuttingDown = true;
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

/**
 * Run exactly one re-seed cycle: try the advisory lock on a dedicated
 * connection, and if acquired, run `seedDemo()` while holding it. Returns
 * `{ ran: false }` when the lock was held by a peer (another replica is
 * already re-seeding this cycle) or when DEMO_MODE is off. Exported so
 * tests can exercise the locking behavior directly without a background
 * timer, and so the scheduled `tick()` below has a single source of truth.
 */
export async function runDemoReseedCycle(): Promise<
  { ran: false } | { ran: true; result: SeedDemoResult }
> {
  if (!isDemoMode()) return { ran: false };

  return await db.connection().execute(async (conn) => {
    const lockRes = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(${DEMO_RESEED_LOCK_ID}) as locked
    `.execute(conn);
    if (!lockRes.rows[0]?.locked) {
      log.debug("demo reseed cycle skipped (lock held by peer)", { source: LOG_SOURCE });
      return { ran: false };
    }
    try {
      const result = await seedDemo();
      log.info("demo reseed cycle complete", { source: LOG_SOURCE, ...result });
      return { ran: true, result };
    } finally {
      await sql`select pg_advisory_unlock(${DEMO_RESEED_LOCK_ID})`.execute(conn);
    }
  });
}

async function tick(): Promise<void> {
  if (shuttingDown) return;
  timerId = null;

  try {
    await runDemoReseedCycle();
  } catch (err) {
    // DB / lock / seed threw -- log + reschedule. The loop NEVER dies.
    log.warn("demo reseed loop tick failed", { source: LOG_SOURCE }, err);
  }

  if (!shuttingDown) {
    timerId = setTimeout(tick, intervalMs());
  }
}

/** Test hook -- peek at runtime state. */
export function __peekDemoReseedLoopStateForTest(): {
  running: boolean;
  shuttingDown: boolean;
  timerScheduled: boolean;
} {
  return { running, shuttingDown, timerScheduled: timerId !== null };
}

/** Test hook -- fully reset module state (clears timer + flags). */
export function __resetDemoReseedLoopForTest(): void {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  running = false;
  shuttingDown = false;
}
