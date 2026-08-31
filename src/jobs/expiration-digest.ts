/**
 * Expiration-digest scheduler -- A SCAFFOLD for "email me before X expires".
 *
 * The loop only. The scan and the message live in
 * src/services/expiration-digest.ts; adapt THAT by registering a provider.
 * Copy this file's shape for any other periodic alert.
 *
 * Boot-time invariants (same contract as the inbound-email reaper, which
 * is the template's reference job):
 *   - Idempotent: calling `startExpirationDigestJob()` twice is a no-op.
 *   - NODE_ENV=test -> returns immediately. Tests call
 *     `runExpirationDigest()` directly; no background timer in the suite.
 *   - No provider registered, or no database -> log ONE info line and stay
 *     dormant. That is the DEFAULT state of a fresh template checkout.
 *   - Never throws at boot.
 *
 * Loop shape: `setTimeout`, not `setInterval`, so ticks cannot overlap.
 * Each tick takes a `pg_try_advisory_lock` on ONE dedicated connection, so
 * only one pod sends when a project runs several. The lock matters more
 * here than for an idempotent drain: without it, N pods means N copies of
 * the same digest in someone's inbox.
 *
 * Gating that is NOT this file's job: whether a given recipient actually
 * receives the mail is the communications gate's call (org toggle +
 * per-user preference), applied inside `sendEmail`.
 *
 * Env tuning (read PER TICK so ops can retune without a restart):
 *   EXPIRATION_DIGEST_INTERVAL_MS  (default 86400000 = 24h, clamp 1m..7d)
 *   EXPIRATION_DIGEST_WITHIN_DAYS  (default 30, clamp 1..365)
 */

import { sql } from "kysely";
import { db, isDatabaseConfigured } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import {
  DEFAULT_WITHIN_DAYS,
  hasExpiringRecordsProvider,
  runExpirationDigest,
} from "@/services/expiration-digest.ts";

const LOG_SOURCE = "expiration-digest-job";

/**
 * Stable advisory-lock id for this job. Distinct from the inbound-email
 * reaper (749217530011), the docs reindex (472026011), and test-schema
 * provisioning (494494). Fits in a Postgres bigint.
 */
const DIGEST_LOCK_ID = 749217530012;

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = safeEnv(key);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function intervalMs(): number {
  return envInt(
    "EXPIRATION_DIGEST_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
    60_000,
    7 * 24 * 60 * 60 * 1000,
  );
}

function withinDays(): number {
  return envInt("EXPIRATION_DIGEST_WITHIN_DAYS", DEFAULT_WITHIN_DAYS, 1, 365);
}

/**
 * Start the digest loop. Synchronous, to match the fire-and-forget shape
 * main.ts expects. Idempotent.
 */
export function startExpirationDigestJob(): void {
  if (running || timerId !== null) return;

  if ((safeEnv("NODE_ENV") ?? "development") === "test") return;

  if (!isDatabaseConfigured() || !hasExpiringRecordsProvider()) {
    log.info("expiration digest not configured -- staying dormant", {
      source: LOG_SOURCE,
      feature: "boot",
      databaseConfigured: isDatabaseConfigured(),
      providerRegistered: hasExpiringRecordsProvider(),
    });
    return;
  }

  running = true;
  shuttingDown = false;
  log.info("expiration digest job started", {
    source: LOG_SOURCE,
    feature: "boot",
    intervalMs: intervalMs(),
    withinDays: withinDays(),
  });
  schedule(intervalMs());
}

/** Stop the loop. Called from shutdown() BEFORE the pool is closed. */
export function stopExpirationDigestJob(): void {
  shuttingDown = true;
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

function schedule(delayMs: number): void {
  if (shuttingDown) return;
  timerId = setTimeout(() => {
    timerId = null;
    void tick();
  }, delayMs);
}

async function tick(): Promise<void> {
  if (shuttingDown) return;
  try {
    await withAdvisoryLock(async () => {
      await runExpirationDigest({ withinDays: withinDays() });
    });
  } catch (err) {
    // The loop NEVER dies. A failed tick logs and reschedules; the service
    // itself already emits ONE aggregate error for per-org failures.
    log.warn("expiration digest tick failed", { source: LOG_SOURCE, feature: "tick" }, err);
  } finally {
    schedule(intervalMs());
  }
}

/**
 * Run `fn` while holding the job's SESSION advisory lock on ONE dedicated
 * connection (taken, held, and released on that same connection -- pooling
 * safe; session locks are per-connection). A pod that loses the race skips
 * this tick.
 *
 * A session lock on a dedicated connection, NOT a transaction lock: the
 * work inside sends email, and holding an open transaction across a
 * network round-trip is how a periodic job ends up blocking a migration.
 */
async function withAdvisoryLock(fn: () => Promise<void>): Promise<void> {
  await db.connection().execute(async (conn) => {
    const got = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(${DIGEST_LOCK_ID}) as locked
    `.execute(conn);
    if (!got.rows[0]?.locked) {
      log.info("expiration digest tick skipped -- another pod holds the lock", {
        source: LOG_SOURCE,
        feature: "tick",
      });
      return;
    }
    try {
      await fn();
    } finally {
      await sql`select pg_advisory_unlock(${DIGEST_LOCK_ID})`.execute(conn);
    }
  });
}
