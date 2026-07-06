/**
 * Inbound-email extraction reaper -- the background loop that drives
 * `processInboundEmailBatch`. Ported from the Valor Victoria customer
 * repo (src/services/vv/email/reaper.ts) and adapted to template
 * patterns (advisory lock on a dedicated connection, per docs/reindex.ts).
 *
 * Captured `inbound_email` rows pile up at status='received'. This loop
 * drains them (and re-picks stale `failed` rows) on an interval. The
 * actual projection lives in extract.service.ts; this file is ONLY the
 * loop + boot/shutdown wiring.
 *
 * Boot-time invariants:
 *   - Idempotent: `startInboundEmailReaper()` is safe to call repeatedly.
 *   - NODE_ENV=test -> returns immediately. Tests drive
 *     `extractInboundEmail` / `processInboundEmailBatch` directly; no
 *     background timer runs during the suite.
 *   - DB or LLM proxy unconfigured -> log ONE info line + return. The pod
 *     stays healthy with the reaper dormant. Storage is deliberately NOT
 *     required -- it only affects attachment readability, and body-only
 *     extraction is still useful. NEVER throws at boot.
 *   - No extraction profile registered -> the loop still runs but every
 *     drain no-ops cheaply (`skipped: "no-profile"`); dormant by default.
 *
 * Loop shape (when configured):
 *   `tick()` runs via `setTimeout` (NOT `setInterval`) so ticks NEVER
 *   overlap -- a slow LLM extraction can't fan out parallel drains. Each
 *   tick takes a `pg_try_advisory_lock` on ONE dedicated connection (held
 *   + released on that same connection -- pooling safe) so that across
 *   multiple pods only ONE drains per tick. The lock is a BUDGET
 *   optimization, not correctness: applyData is idempotent per the
 *   profile contract, so a duplicate claim only wastes LLM spend.
 *
 * Error handling: a thrown tick (DB, lock, drain) logs `warn` and
 * reschedules. The loop NEVER dies. The drain catches per-row internally,
 * and each email's terminal status is set in `extractInboundEmail`'s own
 * catch, so a bad row can never re-loop forever.
 *
 * Env tuning (read PER TICK so ops can retune without a restart):
 *   INBOUND_EMAIL_POLL_INTERVAL_MS  (default 60000, clamp 1s..1h)
 *   INBOUND_EMAIL_BATCH_SIZE        (default 5, clamp 1..50)
 *   INBOUND_EMAIL_RETRY_AFTER_MS    (default 1800000 = 30 min, clamp 0..24h)
 */

import { sql } from "kysely";
import { db, isDatabaseConfigured } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { LLM_CONFIG } from "@/config/llm.ts";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_RETRY_AFTER_MS,
  processInboundEmailBatch,
} from "@/services/inbound-email/extract.service.ts";

const LOG_SOURCE = "inbound-email-reaper";

/**
 * Stable advisory-lock id for the inbound-email reaper. Distinct from the
 * docs reindex lock (472026011) and the test-schema provisioning lock
 * (494494). Fits in a Postgres bigint.
 */
const REAPER_LOCK_ID = 749217530011;

/** Poll cadence default -- how often the reaper drains the queue. */
const DEFAULT_POLL_INTERVAL_MS = 60_000; // 60s

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

/**
 * Read a positive integer env var, clamped to [min, max]. Falls back to
 * `fallback` when unset / empty / non-numeric. Read lazily per tick so
 * ops can retune without a restart.
 */
function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = safeEnv(key);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function pollIntervalMs(): number {
  return envInt("INBOUND_EMAIL_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS, 1_000, 60 * 60 * 1000);
}
function batchSize(): number {
  return envInt("INBOUND_EMAIL_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 50);
}
function retryAfterMs(): number {
  // min 0 (allow "retry immediately"); max 24h.
  return envInt("INBOUND_EMAIL_RETRY_AFTER_MS", DEFAULT_RETRY_AFTER_MS, 0, 24 * 60 * 60 * 1000);
}

/**
 * Start the reaper loop. Synchronous to match the fire-and-forget shape
 * main.ts expects. Idempotent: a second call while a loop is already
 * running is a no-op.
 */
export function startInboundEmailReaper(): void {
  if (running || timerId !== null) return; // idempotent

  if ((safeEnv("NODE_ENV") ?? "development") === "test") {
    // Tests drive the drain directly; no background timer in the suite.
    return;
  }

  if (!isDatabaseConfigured() || !LLM_CONFIG.configured) {
    log.info("inbound-email reaper not configured -- staying dormant", {
      source: LOG_SOURCE,
      feature: "boot",
      databaseConfigured: isDatabaseConfigured(),
      llmConfigured: LLM_CONFIG.configured,
    });
    return;
  }

  log.info("inbound-email reaper starting", {
    source: LOG_SOURCE,
    feature: "boot",
    pollIntervalMs: pollIntervalMs(),
    batchSize: batchSize(),
    retryAfterMs: retryAfterMs(),
  });

  running = true;
  shuttingDown = false;
  // Kick the first tick on the event loop without blocking the caller.
  timerId = setTimeout(tick, 0);
}

/**
 * Stop the reaper loop. Idempotent. Safe to call from a shutdown handler
 * even if the loop never started. Call BEFORE closeDatabase().
 */
export function stopInboundEmailReaper(): void {
  shuttingDown = true;
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
}

async function tick(): Promise<void> {
  if (shuttingDown) return;
  timerId = null;

  try {
    // ONE dedicated connection for lock + drain + unlock (pooling safe --
    // session advisory locks are per-connection; see docs/reindex.ts).
    await db.connection().execute(async (conn) => {
      const lockRes = await sql<{ locked: boolean }>`
        select pg_try_advisory_lock(${REAPER_LOCK_ID}) as locked
      `.execute(conn);
      if (!lockRes.rows[0]?.locked) {
        log.debug("inbound-email reaper tick skipped (lock held by peer)", {
          source: LOG_SOURCE,
        });
        return;
      }
      try {
        const result = await processInboundEmailBatch(
          {},
          { batchSize: batchSize(), retryAfterMs: retryAfterMs() },
        );
        if (result.claimed > 0) {
          log.info("inbound-email reaper drained batch", {
            source: LOG_SOURCE,
            feature: "tick",
            claimed: result.claimed,
            processed: result.processed,
          });
        }
      } finally {
        await sql`select pg_advisory_unlock(${REAPER_LOCK_ID})`.execute(conn);
      }
    });
  } catch (err) {
    // DB / lock / drain threw -- log + reschedule. NEVER kill the loop.
    log.warn("inbound-email reaper tick failed", { source: LOG_SOURCE, feature: "tick" }, err);
  }

  if (!shuttingDown) {
    timerId = setTimeout(tick, pollIntervalMs());
  }
}

/** Test hook -- peek at runtime state. */
export function __peekInboundEmailReaperStateForTest(): {
  running: boolean;
  shuttingDown: boolean;
  timerScheduled: boolean;
} {
  return { running, shuttingDown, timerScheduled: timerId !== null };
}

/** Test hook -- fully reset module state (clears timer + flags). */
export function __resetInboundEmailReaperForTest(): void {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  running = false;
  shuttingDown = false;
}
