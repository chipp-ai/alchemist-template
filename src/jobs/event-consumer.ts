/**
 * Event consumer: the loop that turns event_deliveries rows into handler
 * runs and webhook POSTs. Publishing lives in src/lib/events.ts; this
 * file is ONLY the loop, the wake-up and the boot/shutdown wiring.
 *
 * Loop shape (the same as the other src/jobs loops):
 *   - `tick()` runs via setTimeout, never setInterval, so ticks NEVER
 *     overlap. A slow webhook cannot fan out parallel drains.
 *   - each tick takes the Redis lock `event-consumer` (SET NX EX with an
 *     owner token) with a SHORT TTL and refreshes it from a timer while
 *     the tick runs, so across replicas one pod drains at a time and a
 *     holder that dies, is OOM-killed or loses Redis for a moment stalls
 *     the others for one TTL at most, never a whole batch's worth. The
 *     lock is a de-duplication optimization, not correctness:
 *     claimDeliveries uses FOR UPDATE SKIP LOCKED, so two pods that both
 *     got the lock (Redis down, fail-open) still never run the same
 *     delivery. Never a Postgres advisory lock: behind pgbouncer's
 *     transaction pooling a dead holder's lock is never released.
 *   - a full batch reschedules immediately; a short one waits the poll
 *     interval. Polling is the guarantee.
 *   - the wake-up: a dedicated Redis connection subscribes to the
 *     project's `events` channel (src/lib/events.ts nudge). A message
 *     runs a tick now, or marks one to run right after the current tick
 *     finishes. No Redis means polling only.
 *   - a thrown tick logs and reschedules. The loop NEVER dies.
 *
 * Each tick also requeues stale `running` rows (a claimer that died
 * mid-handler) and, once per sweep interval, runs the retention sweep.
 *
 * Boot-time invariants:
 *   - Idempotent: `startEventConsumer()` twice is one loop.
 *   - NODE_ENV=test returns immediately unless the caller passes
 *     `runInTestEnv: true` (the consumer's own tests do).
 *   - DB unconfigured: one info line, stays dormant. Never throws at boot.
 *   - Boot syncs event_subscriptions from the handler registry BEFORE the
 *     first tick. A nudge that lands during the sync coalesces into that
 *     first tick (the boot counts as a tick in flight), so there is never
 *     a second loop in one process.
 *   - Every claim passes this process's registered (topic, handler) pairs
 *     (`getRunnableHandlers`), so no delivery is claimed for a handler
 *     this pod cannot run, including during a rolling deploy where an
 *     old pod is still ticking next to a new one.
 *   - `stopEventConsumer()` resolves only after the tick in flight has
 *     written its outcomes (bounded by one handler timeout), and main.ts
 *     awaits it before `closeDatabase()`.
 *
 * Env tuning (read PER TICK so ops can retune without a restart):
 *   EVENTS_POLL_INTERVAL_MS          default 5000    clamp 250ms..1h
 *   EVENTS_BATCH_SIZE                default 25      clamp 1..200
 *   EVENTS_CONCURRENCY               default 4       clamp 1..32
 *   EVENTS_HANDLER_TIMEOUT_MS        default 30000   clamp 1s..10min
 *   EVENTS_LOCK_TTL_S                default 60      clamp 10s..1h
 *                                    (refreshed every third of it while a
 *                                    tick runs; short is safe, long stalls)
 *   EVENTS_STALE_CLAIM_MS            default 600000  clamp 1min..24h
 *                                    (floored in code: a claimed row can
 *                                    wait ceil(batch/concurrency) rounds
 *                                    before its handler starts, so the
 *                                    floor is that many (timeout + write)
 *                                    plus a minute; a raised value is
 *                                    logged at boot)
 *   EVENTS_RETENTION_DELIVERIES_DAYS default 7       clamp 0..3650 (0 = off)
 *   EVENTS_RETENTION_EVENTS_DAYS     default 90      clamp 0..3650 (0 = off)
 *   EVENTS_RETENTION_SWEEP_MS        default 3600000 clamp 1min..24h
 */

import { isDatabaseConfigured } from "@/db/client.ts";
import {
  claimDeliveries,
  DEFAULT_HANDLER_TIMEOUT_MS,
  EVENTS_CHANNEL,
  getRunnableHandlers,
  processDelivery,
  requeueStaleDeliveries,
  sweepEventRetention,
  syncSubscriptionsFromRegistry,
} from "@/lib/events.ts";
import { log } from "@/lib/logger.ts";
import {
  acquireLock,
  redisSubscribe,
  type RedisSubscriptionHandle,
  refreshLock,
  releaseLock,
} from "@/lib/redis.ts";

const LOG_SOURCE = "event-consumer";

/** Redis lock name for the tick (`acquireLock` prefixes it per project). */
const CONSUMER_LOCK_NAME = "event-consumer";
/** Redis lock that throttles the retention sweep across pods. */
const RETENTION_LOCK_NAME = "event-retention-sweep";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_LOCK_TTL_S = 60;
const DEFAULT_STALE_CLAIM_MS = 10 * 60 * 1_000;
/** Bound on one claim / complete / fail write (mirrors events.ts). */
const WRITE_TIMEOUT_MS = 5_000;
/** Slack added to the computed stale-claim floor. */
const STALE_CLAIM_SLACK_MS = 60_000;
const DEFAULT_RETENTION_DELIVERIES_DAYS = 7;
const DEFAULT_RETENTION_EVENTS_DAYS = 90;
const DEFAULT_RETENTION_SWEEP_MS = 60 * 60 * 1_000;

export type SubscribeFn = typeof redisSubscribe;

export interface EventConsumerOptions {
  /** Injected in tests: a fake nudge source. Defaults to redisSubscribe. */
  subscribe?: SubscribeFn;
  /** Tests only: narrow claims to these topics so parallel files stay apart. */
  topics?: string[];
  /** Tests only: run even when NODE_ENV=test. */
  runInTestEnv?: boolean;
  /** Overrides the env value for this loop (tests). */
  pollIntervalMs?: number;
  batchSize?: number;
  handlerTimeoutMs?: number;
}

let timerId: ReturnType<typeof setTimeout> | null = null;
let running = false;
let shuttingDown = false;
let tickInFlight = false;
/** The tick (or the boot sync) in flight; `stopEventConsumer` awaits it. */
let currentTick: Promise<void> | null = null;
let wakeRequested = false;
let subscription: RedisSubscriptionHandle | null = null;
let options: EventConsumerOptions = {};
let lastSweepAt = 0;
let ticks = 0;
let consumerId = "";

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

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function pollIntervalMs(): number {
  return options.pollIntervalMs ??
    envInt("EVENTS_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS, 250, HOUR_MS);
}
function batchSize(): number {
  return options.batchSize ?? envInt("EVENTS_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 200);
}
function concurrency(): number {
  return envInt("EVENTS_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 32);
}
function handlerTimeoutMs(): number {
  return options.handlerTimeoutMs ??
    envInt("EVENTS_HANDLER_TIMEOUT_MS", DEFAULT_HANDLER_TIMEOUT_MS, 1_000, 10 * 60 * 1_000);
}
function lockTtlSeconds(): number {
  return envInt("EVENTS_LOCK_TTL_S", DEFAULT_LOCK_TTL_S, 10, 3_600);
}
/**
 * A claimed row can sit in this process's queue for
 * ceil(batch / concurrency) - 1 rounds before its handler even starts,
 * and `claimed_at` is set at claim time. The floor covers every round
 * plus the status write, plus slack, so a peer's reaper never requeues a
 * row this pod is still going to run (which would run it on two pods).
 */
function staleClaimFloorMs(): number {
  const rounds = Math.ceil(batchSize() / concurrency());
  return rounds * (handlerTimeoutMs() + WRITE_TIMEOUT_MS) + STALE_CLAIM_SLACK_MS;
}
function staleClaimMs(): number {
  const configured = envInt("EVENTS_STALE_CLAIM_MS", DEFAULT_STALE_CLAIM_MS, 60_000, DAY_MS);
  return Math.max(configured, staleClaimFloorMs());
}
function retentionDeliveriesDays(): number {
  return envInt("EVENTS_RETENTION_DELIVERIES_DAYS", DEFAULT_RETENTION_DELIVERIES_DAYS, 0, 3_650);
}
function retentionEventsDays(): number {
  return envInt("EVENTS_RETENTION_EVENTS_DAYS", DEFAULT_RETENTION_EVENTS_DAYS, 0, 3_650);
}
function retentionSweepMs(): number {
  return envInt("EVENTS_RETENTION_SWEEP_MS", DEFAULT_RETENTION_SWEEP_MS, 60_000, DAY_MS);
}

function hostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return "unknown-host";
  }
}

/**
 * Start the consumer. Synchronous to match the fire-and-forget shape
 * main.ts expects; the registry sync and the first tick happen on the
 * event loop. Idempotent.
 */
export function startEventConsumer(opts: EventConsumerOptions = {}): void {
  if (running || timerId !== null) return; // idempotent

  if ((safeEnv("NODE_ENV") ?? "development") === "test" && !opts.runInTestEnv) {
    return;
  }
  if (!isDatabaseConfigured()) {
    log.info("event consumer not configured (no database); staying dormant", {
      source: LOG_SOURCE,
      feature: "boot",
    });
    return;
  }

  options = opts;
  running = true;
  shuttingDown = false;
  wakeRequested = false;
  consumerId = `${hostname()}#${Deno.pid}`;

  log.info("event consumer starting", {
    source: LOG_SOURCE,
    feature: "boot",
    consumerId,
    pollIntervalMs: pollIntervalMs(),
    batchSize: batchSize(),
    concurrency: concurrency(),
    handlerTimeoutMs: handlerTimeoutMs(),
    lockTtlSeconds: lockTtlSeconds(),
    staleClaimMs: staleClaimMs(),
  });
  const configuredStale = envInt("EVENTS_STALE_CLAIM_MS", DEFAULT_STALE_CLAIM_MS, 60_000, DAY_MS);
  if (staleClaimMs() > configuredStale) {
    log.warn("EVENTS_STALE_CLAIM_MS raised to the computed floor", {
      source: LOG_SOURCE,
      feature: "boot",
      configuredMs: configuredStale,
      effectiveMs: staleClaimMs(),
      batchSize: batchSize(),
      concurrency: concurrency(),
      handlerTimeoutMs: handlerTimeoutMs(),
    });
  }

  // The wake-up. A message is a hint that something is due; the tick
  // finds out what. Malformed messages are ignored on purpose.
  const subscribe = opts.subscribe ?? redisSubscribe;
  subscription = subscribe(EVENTS_CHANNEL, () => wakeEventConsumer());

  // Sync BEFORE the first tick so the registry's subscriptions exist for
  // fanout. A failed sync is an error (stale subscriptions mean silently
  // dropped fanout), but the loop still starts: polling existing
  // deliveries is better than nothing, and the next boot retries.
  //
  // The boot counts as a tick in flight: a nudge that lands during the
  // sync sets wakeRequested instead of scheduling a tick of its own,
  // which would leave two loops running in one process for its lifetime.
  tickInFlight = true;
  timerId = setTimeout(() => {
    timerId = null;
    currentTick = (async () => {
      try {
        await syncSubscriptionsFromRegistry();
      } catch (err) {
        log.error("event subscriptions failed to sync at boot", {
          source: LOG_SOURCE,
          feature: "boot",
        }, err);
      } finally {
        tickInFlight = false;
      }
      if (!shuttingDown) await tick();
    })();
  }, 0);
}

/**
 * Run a tick as soon as possible. Called by the Redis subscription; safe
 * to call from anywhere (a route that just published, a test). Coalesces:
 * many wakes during one tick cause exactly one extra tick.
 */
export function wakeEventConsumer(): void {
  if (!running || shuttingDown) return;
  if (tickInFlight) {
    wakeRequested = true;
    return;
  }
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  timerId = setTimeout(scheduleTick, 0);
}

/** The only way a tick starts: records its promise so stop can await it. */
function scheduleTick(): void {
  currentTick = tick();
}

/**
 * Stop the loop and the subscription. Idempotent. Resolves once the tick
 * in flight has finished its current batch (bounded by one handler
 * timeout plus a status write), because its status writes are what keep
 * the ledger honest: a row left `running` while the pool is torn down
 * is re-run ten minutes later as a duplicate. main.ts awaits this BEFORE
 * closeDatabase().
 */
export async function stopEventConsumer(): Promise<void> {
  shuttingDown = true;
  running = false;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  try {
    subscription?.close();
  } catch (err) {
    log.warn("event consumer subscription close failed", {
      source: LOG_SOURCE,
      feature: "shutdown",
    }, err);
  }
  subscription = null;

  const inFlight = currentTick;
  if (inFlight === null) return;
  const boundMs = handlerTimeoutMs() + WRITE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), boundMs);
  });
  try {
    const result = await Promise.race([inFlight.then(() => "done" as const), bound]);
    if (result === "timeout") {
      log.error("event consumer stopped with a tick still in flight", {
        source: LOG_SOURCE,
        feature: "shutdown",
        waitedMs: boundMs,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Never rejects. */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** One batch: claim, process, report. Returns how many were claimed. */
async function drainOnce(): Promise<number> {
  const claimed = await claimDeliveries(batchSize(), {
    claimedBy: consumerId,
    topics: options.topics,
    runnableHandlers: getRunnableHandlers(),
  });
  if (claimed.length === 0) return 0;

  const counts = { done: 0, skipped: 0, released: 0, failed: 0, dead: 0 };
  const timeoutMs = handlerTimeoutMs();
  await forEachLimited(claimed, concurrency(), async (delivery) => {
    // processDelivery never throws; the guard is for a bug in it.
    try {
      const outcome = await processDelivery(delivery, { handlerTimeoutMs: timeoutMs });
      counts[outcome.outcome]++;
    } catch (err) {
      counts.failed++;
      log.error("processDelivery threw; the stale-claim reaper will requeue the row", {
        source: LOG_SOURCE,
        feature: "tick",
        deliveryId: delivery.id,
      }, err);
    }
  });

  log.info("event consumer drained a batch", {
    source: LOG_SOURCE,
    feature: "tick",
    claimed: claimed.length,
    ...counts,
  });
  return claimed.length;
}

async function maybeSweepRetention(): Promise<void> {
  const interval = retentionSweepMs();
  if (Date.now() - lastSweepAt < interval) return;
  lastSweepAt = Date.now();
  // Across pods: whoever wins this lock sweeps; the TTL is the interval,
  // so without Redis every pod sweeps on its own clock (harmless).
  if (!(await acquireLock(RETENTION_LOCK_NAME, Math.floor(interval / 1_000)))) return;
  await sweepEventRetention({
    doneDeliveriesAfterDays: retentionDeliveriesDays(),
    eventsAfterDays: retentionEventsDays(),
  });
}

async function tick(): Promise<void> {
  if (shuttingDown) return;
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  tickInFlight = true;
  wakeRequested = false;
  ticks++;
  let fullBatch = false;

  try {
    const ttl = lockTtlSeconds();
    if (!(await acquireLock(CONSUMER_LOCK_NAME, ttl))) {
      log.debug("event consumer tick skipped (lock held by peer)", { source: LOG_SOURCE });
    } else {
      // Keep the short lock alive while the batch runs. A refresh that
      // fails (Redis blip, lock expired and re-taken) is not fatal: the
      // work continues and SKIP LOCKED keeps it correct.
      const refresh = setInterval(() => {
        refreshLock(CONSUMER_LOCK_NAME, ttl).catch(() => {
          // refreshLock is fail-open and logs its own warning.
        });
      }, Math.max(1_000, Math.floor((ttl * 1_000) / 3)));
      try {
        const requeued = await requeueStaleDeliveries(staleClaimMs());
        if (requeued > 0) {
          // A stale claim means a pod died mid-handler or a handler hung
          // past its timeout AND the timeout did not fire: worth a look.
          log.error("event consumer requeued stale claims", {
            source: LOG_SOURCE,
            feature: "stale-claims",
            requeued,
          });
        }
        fullBatch = (await drainOnce()) >= batchSize();
        await maybeSweepRetention();
      } finally {
        clearInterval(refresh);
        await releaseLock(CONSUMER_LOCK_NAME);
      }
    }
  } catch (err) {
    // DB / lock / claim threw. Log and reschedule; NEVER kill the loop.
    log.error("event consumer tick failed", { source: LOG_SOURCE, feature: "tick" }, err);
  } finally {
    tickInFlight = false;
  }

  if (shuttingDown) return;
  const delay = fullBatch || wakeRequested ? 0 : pollIntervalMs();
  wakeRequested = false;
  timerId = setTimeout(scheduleTick, delay);
}

/** Test hook: peek at runtime state. */
export function __peekEventConsumerStateForTest(): {
  running: boolean;
  shuttingDown: boolean;
  timerScheduled: boolean;
  tickInFlight: boolean;
  ticks: number;
} {
  return { running, shuttingDown, timerScheduled: timerId !== null, tickInFlight, ticks };
}

/**
 * Test hook: fully reset module state (clears timer, subscription and
 * flags). Awaits the tick in flight like a real shutdown does.
 */
export async function __resetEventConsumerForTest(): Promise<void> {
  await stopEventConsumer();
  shuttingDown = false;
  tickInFlight = false;
  currentTick = null;
  wakeRequested = false;
  options = {};
  lastSweepAt = 0;
  ticks = 0;
}
