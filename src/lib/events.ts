/**
 * Durable events: publish inside the transaction, handle idempotently.
 *
 * Three properties, three mechanisms. Keep them apart when you read this:
 *
 *   Exactly-once emission   `publishEvent(trx, ...)` inserts the event and
 *                           its deliveries inside the CALLER's transaction.
 *                           The event exists iff the business change did.
 *   At-least-once delivery  `claimDeliveries` takes rows with
 *                           FOR UPDATE SKIP LOCKED in one transaction, the
 *                           handler runs OUTSIDE it, then `completeDelivery`
 *                           or `failDelivery` (exponential backoff with
 *                           jitter, dead letter after max attempts).
 *   Low latency             `nudge(topic)` publishes on the project's Redis
 *                           channel after commit. Polling is the guarantee;
 *                           the nudge only shortens the wait.
 *
 * WHO CALLS WHAT
 *
 *   In a service, inside the transaction that makes the change:
 *     const published = await publishEvent(trx, { topic: "order.created", key: order.id, payload });
 *     ...commit...
 *     await nudge(published.topic);   // AFTER commit, never inside
 *
 *   Outside any transaction (a webhook route, a script):
 *     await publishEventAndNudge({ topic: "order.created", key, payload });
 *
 *   Once, at module load (src/events/handlers.ts):
 *     registerEventHandler("order.created", sendConfirmation, { retries: 8, idempotencyKey: (e) => e.id });
 *
 *   At boot, before the consumer starts:
 *     await syncSubscriptionsFromRegistry();
 *
 * The consumer loop (src/jobs/event-consumer.ts) is: claimDeliveries
 * (active subscriptions only, handler deliveries only for handlers THIS
 * process has registered), then processDelivery for each, then
 * requeueStaleDeliveries now and then for claimers that died
 * mid-handler, and sweepEventRetention once in a while. processDelivery
 * dispatches on the subscription's kind: 'handler' runs the registered
 * function, 'webhook' POSTs the event (src/lib/event-webhooks.ts). Both
 * share every retry rule below. Every status write is fenced on the
 * claim token (claimed_by, attempts), so a superseded claim's late
 * write never lands on a peer's run.
 *
 * WHY NOT A TRIGGER for the fanout: doing it here keeps the whole
 * exactly-once path in one readable, testable function.
 *
 * WHY THE HANDLER RUNS OUTSIDE THE CLAIM TRANSACTION: Postgres is reached
 * through pgbouncer in transaction-pool mode. A transaction held open
 * across a webhook POST pins a server backend and blocks migrations.
 * The price is a `running` state and a stale-claim reaper.
 *
 * Never LISTEN (session-scoped, unavailable behind pgbouncer) and never
 * a Postgres advisory lock (a dead holder's lock is never released).
 * Cross-pod de-duplication is `acquireLock` from src/lib/redis.ts and it
 * fails open, so correctness comes from SKIP LOCKED alone.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { db, withTimeout } from "@/db/client.ts";
import type { Database, EventSource, EventSubscriptionKind } from "@/db/schema.ts";
import { log } from "@/lib/logger.ts";
import { deliverWebhook } from "@/lib/event-webhooks.ts";
import { redisPublish } from "@/lib/redis.ts";
import { uuidv7 } from "@/lib/uuidv7.ts";

const LOG_SOURCE = "events";

/** The Redis pub/sub channel (prefixed per project by src/lib/redis.ts). */
export const EVENTS_CHANNEL = "events";

/** Retries after the first attempt when `registerEventHandler` gets none. */
export const DEFAULT_RETRIES = 7;

/** Backoff: 1s, 2s, 4s ... capped at one hour, each halved-plus-jitter. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60 * 60 * 1_000;

/** Bound on the claim / complete / fail transactions. */
const WRITE_TIMEOUT_MS = 5_000;

/**
 * Topics are `noun.past_tense`: lowercase segments joined by dots, at
 * least two of them. `order.created`, `file.upload.finished`.
 */
const TOPIC_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

// ── Types ──

export interface PublishedEvent {
  id: string;
  organizationId: string | null;
  topic: string;
  key: string | null;
  payload: Record<string, unknown>;
  source: EventSource;
  createdAt: Date;
}

export interface PublishEventInput {
  topic: string;
  /** The business key the event is about. Optional but almost always wanted. */
  key?: string | null;
  /** A plain object. Arrays and scalars are rejected (postgres.js would mis-type them). */
  payload?: Record<string, unknown>;
  source?: EventSource;
  /** The org the event belongs to; NULL for platform or external events. */
  organizationId?: string | null;
  /** Supply to make an insert idempotent (the inbox uses the sender's id). */
  id?: string;
}

export interface PublishResult {
  id: string;
  topic: string;
  /** Delivery rows created (one per active subscription for the topic). */
  deliveries: number;
  /** false when `id` was supplied and the event already existed. */
  inserted: boolean;
}

export interface DeliveryContext {
  deliveryId: string;
  subscriptionId: string;
  /** 1 on the first run. */
  attempt: number;
  maxAttempts: number;
  /**
   * Aborted when the attempt times out. JS cannot cancel a promise, so a
   * handler that overruns keeps running unless it checks this (pass it to
   * fetch, poll `signal.aborted` between steps). The retry is scheduled
   * no sooner than one handler timeout after the abort, so a well-behaved
   * handler never overlaps its own ghost.
   */
  signal: AbortSignal;
}

export type EventHandler = (
  event: PublishedEvent,
  ctx: DeliveryContext,
) => Promise<void> | void;

export interface RegisterEventHandlerOptions {
  /** Retries AFTER the first attempt. Total attempts = retries + 1. */
  retries?: number;
  /**
   * Derive a key from the event. A delivery whose (handler, key) already
   * has a receipt is marked done without running the handler. Use it when
   * the handler's side effect is not naturally idempotent.
   */
  idempotencyKey?: (event: PublishedEvent) => string;
  /** Required when `fn` is anonymous. Stored in event_subscriptions.handler. */
  name?: string;
}

export interface RegisteredHandler {
  topic: string;
  name: string;
  handler: EventHandler;
  maxAttempts: number;
  idempotencyKey?: (event: PublishedEvent) => string;
}

/**
 * A delivery the consumer owns until it calls complete, fail or release.
 * `claimedBy` + `attempts` are the claim token: every status write is
 * fenced on them, so a write from a superseded claim (a stalled pod
 * whose row the reaper handed to a peer) matches zero rows.
 */
export interface ClaimedDelivery {
  id: string;
  subscriptionId: string;
  /** The consumer id that claimed the row. */
  claimedBy: string;
  /** Attempts INCLUDING this one. */
  attempts: number;
  maxAttempts: number;
  handler: string;
  kind: EventSubscriptionKind;
  url: string | null;
  secretRef: string | null;
  event: PublishedEvent;
}

export type FailOutcome =
  | { status: "failed"; delayMs: number }
  | { status: "dead"; delayMs: 0 };

export type ReleaseReason = "handler-not-registered" | "idempotency-key-in-flight";

export type ProcessOutcome =
  | { outcome: "done" }
  | { outcome: "skipped"; reason: "idempotency-key-seen" }
  /** Given back unrun, no attempt burned; another pod or a later tick takes it. */
  | { outcome: "released"; reason: ReleaseReason }
  | { outcome: "failed"; delayMs: number }
  | { outcome: "dead" };

/** A (topic, handler) pair this process can run; the claim filter. */
export interface RunnableHandler {
  topic: string;
  handler: string;
}

// ── Registry ──

const registry = new Map<string, RegisteredHandler>();

function registryKey(topic: string, name: string): string {
  return `${topic}\n${name}`;
}

/**
 * Declare a handler for a topic. Call once per (topic, handler) at module
 * load. Throws on a malformed topic, an anonymous handler without `name`,
 * or a duplicate: these are programmer errors and should fail the boot.
 */
export function registerEventHandler(
  topic: string,
  fn: EventHandler,
  options: RegisterEventHandlerOptions = {},
): RegisteredHandler {
  if (!TOPIC_PATTERN.test(topic)) {
    throw new Error(
      `event topic "${topic}" must be noun.past_tense (lowercase segments joined by dots)`,
    );
  }
  const name = options.name ?? fn.name;
  if (!name) {
    throw new Error(`event handler for "${topic}" is anonymous; pass { name }`);
  }
  const key = registryKey(topic, name);
  if (registry.has(key)) {
    throw new Error(`event handler "${name}" is already registered for "${topic}"`);
  }
  const retries = options.retries ?? DEFAULT_RETRIES;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error(`retries for "${topic}"/"${name}" must be a non-negative integer`);
  }
  const entry: RegisteredHandler = {
    topic,
    name,
    handler: fn,
    maxAttempts: retries + 1,
    idempotencyKey: options.idempotencyKey,
  };
  registry.set(key, entry);
  return entry;
}

export function getRegisteredHandlers(): RegisteredHandler[] {
  return [...registry.values()];
}

/** The (topic, handler) pairs this process can run, for `claimDeliveries`. */
export function getRunnableHandlers(): RunnableHandler[] {
  return getRegisteredHandlers().map((h) => ({ topic: h.topic, handler: h.name }));
}

/** Test seam: forget every registered handler. */
export function _resetEventRegistryForTest(): void {
  registry.clear();
}

// ── Publish ──

function assertPlainObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Insert an event and one delivery per active subscription for its
 * topic, inside the caller's transaction. Nothing here touches Redis:
 * the caller commits, then calls `nudge(result.topic)`.
 *
 * With `id` supplied, an existing event is left alone and the result
 * says `inserted: false` with zero new deliveries. That is how the
 * inbox stays idempotent on the sender's event id.
 */
export async function publishEvent(
  trx: Kysely<Database>,
  input: PublishEventInput,
): Promise<PublishResult> {
  if (!TOPIC_PATTERN.test(input.topic)) {
    throw new Error(`event topic "${input.topic}" must be noun.past_tense`);
  }
  const payload = assertPlainObject(input.payload ?? {}, "event payload");
  const id = input.id ?? uuidv7();
  const organizationId = input.organizationId ?? null;

  const inserted = await trx
    .insertInto("events")
    .values({
      id,
      organizationId,
      topic: input.topic,
      key: input.key ?? null,
      payload,
      source: input.source ?? "app",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .returning("id")
    .executeTakeFirst();

  if (!inserted) {
    return { id, topic: input.topic, deliveries: 0, inserted: false };
  }

  const subscriptions = await trx
    .selectFrom("event_subscriptions")
    .select("id")
    .where("topic", "=", input.topic)
    .where("active", "=", true)
    .where((eb) =>
      organizationId === null
        ? eb("organizationId", "is", null)
        : eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)])
    )
    .execute();

  if (subscriptions.length > 0) {
    await trx
      .insertInto("event_deliveries")
      .values(subscriptions.map((s) => ({ eventId: id, subscriptionId: s.id })))
      .execute();
  }

  return { id, topic: input.topic, deliveries: subscriptions.length, inserted: true };
}

/**
 * Wake the consumers. Call AFTER the publishing transaction committed.
 * Best-effort: Redis being down costs latency, never a message.
 */
export async function nudge(topic: string): Promise<void> {
  const receivers = await redisPublish(EVENTS_CHANNEL, { topic });
  if (receivers === null) {
    log.debug("event nudge skipped (redis unavailable); polling will pick it up", {
      source: LOG_SOURCE,
      feature: "nudge",
      topic,
    });
  }
}

/**
 * For callers with no transaction of their own. Opens one, publishes,
 * commits, nudges. If you already hold a transaction use `publishEvent`
 * and nudge yourself after commit, or the event can be seen before the
 * change it describes.
 */
export async function publishEventAndNudge(input: PublishEventInput): Promise<PublishResult> {
  const result = await db.transaction().execute((trx) => publishEvent(trx, input));
  await nudge(result.topic);
  return result;
}

// ── Subscriptions ──

export interface SyncSubscriptionsResult {
  upserted: number;
  deactivated: number;
}

/**
 * A handler row is deactivated only after NO pod has declared it for
 * this long. The upsert bumps `updated_at` (the trigger) on every boot
 * that declares the handler, so `updated_at` is "last seen by any pod".
 * One hour is longer than any rolling deploy (a draining pod lives at
 * most ten minutes), so an old-version pod that restarts mid-rollout
 * sees the new handler's row as fresh and leaves it active.
 */
export const SUBSCRIPTION_DEACTIVATE_GRACE_MS = 60 * 60 * 1_000;

/**
 * Make event_subscriptions reflect the code. Upserts every registered
 * handler (organization_id NULL, kind 'handler') and DEACTIVATES handler
 * rows the code no longer declares AND no pod has declared within
 * `deactivateGraceMs`; it never deletes them, so their pending and dead
 * deliveries stay visible (parked: the claim skips inactive
 * subscriptions). Safe to run from two pods at once: the upsert targets
 * the partial unique index.
 *
 * Why the grace window: without it an old-version pod restarting during
 * a rollout would deactivate a handler only the new version declares,
 * and every event published until a new pod boots would fan out ZERO
 * deliveries for it. There is no lane that creates deliveries after the
 * fact, so that was silent, unrecoverable loss. With the window the row
 * stays active, the delivery rows exist, and `claimDeliveries` leaves
 * them for a pod whose registry has the handler.
 */
export async function syncSubscriptionsFromRegistry(
  opts: { deactivateGraceMs?: number } = {},
): Promise<SyncSubscriptionsResult> {
  const entries = getRegisteredHandlers();
  const graceMs = Math.max(
    0,
    Math.floor(opts.deactivateGraceMs ?? SUBSCRIPTION_DEACTIVATE_GRACE_MS),
  );
  return await db.transaction().execute(async (trx) => {
    for (const entry of entries) {
      await trx
        .insertInto("event_subscriptions")
        .values({
          organizationId: null,
          topic: entry.topic,
          handler: entry.name,
          kind: "handler",
          maxAttempts: entry.maxAttempts,
        })
        .onConflict((oc) =>
          oc
            .columns(["topic", "handler"])
            .where("organizationId", "is", null)
            // Always an UPDATE (even with equal values) so the trigger
            // bumps updated_at: that is the "last seen" timestamp.
            .doUpdateSet({ maxAttempts: entry.maxAttempts, active: true })
        )
        .execute();
    }

    let deactivate = trx
      .updateTable("event_subscriptions")
      .set({ active: false })
      .where("organizationId", "is", null)
      .where("kind", "=", "handler")
      .where("active", "=", true)
      .where("updatedAt", "<", sql<Date>`now() - (${graceMs} * interval '1 millisecond')`);
    if (entries.length > 0) {
      deactivate = deactivate.where((eb) =>
        eb.not(
          eb.or(
            entries.map((e) => eb.and([eb("topic", "=", e.topic), eb("handler", "=", e.name)])),
          ),
        )
      );
    }
    const deactivatedRows = await deactivate.returning(["topic", "handler"]).execute();

    const result = {
      upserted: entries.length,
      deactivated: deactivatedRows.length,
    };
    if (deactivatedRows.length > 0) {
      // Working as designed for a removed handler, but loud enough that a
      // rename nobody meant is noticed: its parked deliveries never run.
      log.warn("event subscriptions deactivated: handlers no pod has declared recently", {
        source: LOG_SOURCE,
        feature: "sync-subscriptions",
        graceMs,
        handlers: deactivatedRows.map((r) => `${r.topic}/${r.handler}`),
      });
    }
    log.info("event subscriptions synced from registry", {
      source: LOG_SOURCE,
      feature: "sync-subscriptions",
      ...result,
    });
    return result;
  });
}

// ── Claim, complete, fail ──

/** postgres.js returns jsonb as an object; guard the string case anyway. */
function readPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return assertPlainObject(JSON.parse(raw), "event payload");
    } catch {
      return {};
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

interface ClaimRow {
  id: string;
  subscriptionId: string;
  attempts: number;
  maxAttempts: number;
  handler: string;
  kind: EventSubscriptionKind;
  url: string | null;
  secretRef: string | null;
  eventId: string;
  organizationId: string | null;
  topic: string;
  key: string | null;
  payload: unknown;
  source: EventSource;
  createdAt: Date;
}

export interface ClaimOptions {
  claimedBy: string;
  /** Narrows the claim to these topics (tests use it; a consumer normally does not). */
  topics?: string[];
  /**
   * The (topic, handler) pairs THIS process can run. Handler deliveries
   * for any other pair are left for a pod that has the code (a rolling
   * deploy keeps old pods alive for minutes). Webhook deliveries need no
   * code and are always eligible. Omitted: no filter (direct callers,
   * tests); an empty list claims webhooks only.
   */
  runnableHandlers?: RunnableHandler[];
  /** Bound on the claim transaction, pool acquisition included. */
  timeoutMs?: number;
}

/** Thrown inside the claim transaction when the caller already gave up. */
class ClaimAbandonedError extends Error {
  constructor() {
    super("claim abandoned: the caller timed out before the transaction started");
    this.name = "ClaimAbandonedError";
  }
}

/**
 * Claim up to `batch` due deliveries for this consumer. One transaction:
 * SELECT ... FOR UPDATE SKIP LOCKED, then mark them `running` and bump
 * `attempts`. Two consumers never get the same row. The caller runs the
 * handlers OUTSIDE this transaction and then calls `completeDelivery`,
 * `failDelivery` or `releaseDelivery` per row.
 *
 * Only deliveries of ACTIVE subscriptions are claimed. A deactivated
 * webhook or handler leaves its pending and failed rows parked: visible,
 * replayable if the subscription comes back, never run in the meantime.
 *
 * The timeout NEVER orphans a claim. A plain wall-clock race would let
 * the transaction commit after the caller rejected (pool acquisition can
 * take longer than the timer), leaving rows `running` that nobody owns
 * until the stale reaper, ten minutes and one attempt later. Here the
 * transaction checks a flag before and after the UPDATE and rolls back
 * when the caller already gave up; if it still commits in the last
 * round trip, the rows are handed straight back with `releaseClaims`.
 */
export async function claimDeliveries(
  batch: number,
  opts: ClaimOptions,
): Promise<ClaimedDelivery[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(batch)));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? WRITE_TIMEOUT_MS));
  const topicFilter = opts.topics && opts.topics.length > 0
    ? sql`AND e.topic IN (${sql.join(opts.topics.map((t) => sql`${t}`))})`
    : sql``;
  let handlerFilter = sql``;
  if (opts.runnableHandlers !== undefined) {
    handlerFilter = opts.runnableHandlers.length === 0
      ? sql`AND s.kind <> 'handler'`
      : sql`AND (s.kind <> 'handler' OR (e.topic, s.handler) IN (${
        sql.join(opts.runnableHandlers.map((h) => sql`(${h.topic}, ${h.handler})`))
      }))`;
  }

  let timedOut = false;
  const dbOp = db.transaction().execute(async (trx) => {
    if (timedOut) throw new ClaimAbandonedError();
    await sql`SET LOCAL statement_timeout = ${sql.raw(`'${timeoutMs}'`)}`.execute(trx);
    const result = await sql<ClaimRow>`
      WITH picked AS (
        SELECT d.id
        FROM event_deliveries d
        JOIN events e ON e.id = d.event_id
        JOIN event_subscriptions s ON s.id = d.subscription_id
        WHERE d.status IN ('pending', 'failed')
          AND d.next_attempt_at <= now()
          AND s.active
          ${topicFilter}
          ${handlerFilter}
        ORDER BY d.next_attempt_at, d.created_at
        LIMIT ${limit}
        FOR UPDATE OF d SKIP LOCKED
      )
      UPDATE event_deliveries d
      SET status = 'running',
          claimed_by = ${opts.claimedBy},
          claimed_at = now(),
          attempts = d.attempts + 1
      FROM picked, events e, event_subscriptions s
      WHERE d.id = picked.id
        AND e.id = d.event_id
        AND s.id = d.subscription_id
      RETURNING
        d.id AS "id",
        d.subscription_id AS "subscriptionId",
        d.attempts AS "attempts",
        s.max_attempts AS "maxAttempts",
        s.handler AS "handler",
        s.kind AS "kind",
        s.url AS "url",
        s.secret_ref AS "secretRef",
        e.id AS "eventId",
        e.organization_id AS "organizationId",
        e.topic AS "topic",
        e.key AS "key",
        e.payload AS "payload",
        e.source AS "source",
        e.created_at AS "createdAt"
    `.execute(trx);
    // The caller gave up while the UPDATE ran: roll back, claim nothing.
    if (timedOut) throw new ClaimAbandonedError();
    return result.rows.map(toClaimedDelivery(opts.claimedBy));
  });

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`claim timed out after ${timeoutMs}ms (including pool acquisition)`));
    }, timeoutMs);
  });
  // Committed after the caller rejected (the window between the second
  // check and COMMIT): give the rows back instead of orphaning them.
  dbOp.then(
    (rows) => {
      if (!timedOut || rows.length === 0) return;
      releaseClaims(rows).catch((err) => {
        log.error("claim committed after the caller timed out and the release failed", {
          source: LOG_SOURCE,
          feature: "claim",
          claimedBy: opts.claimedBy,
          rows: rows.length,
        }, err);
      });
    },
    () => {
      // Rolled back (ClaimAbandonedError or a real failure): the caller
      // already saw the timeout, or sees the failure through the race.
    },
  );
  try {
    return await Promise.race([dbOp, timer]);
  } finally {
    clearTimeout(timerId);
  }
}

function toClaimedDelivery(claimedBy: string): (r: ClaimRow) => ClaimedDelivery {
  return (r) => ({
    id: r.id,
    subscriptionId: r.subscriptionId,
    claimedBy,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.maxAttempts),
    handler: r.handler,
    kind: r.kind,
    url: r.url,
    secretRef: r.secretRef,
    event: {
      id: r.eventId,
      organizationId: r.organizationId,
      topic: r.topic,
      key: r.key,
      payload: readPayload(r.payload),
      source: r.source,
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt)),
    },
  });
}

/**
 * Hand claimed rows back unrun: `pending`, the claim's attempt uncounted,
 * due at `now() + delayMs`. Fenced on the claim token (claimed_by AND
 * attempts), so a row the reaper already moved on is left alone. Used
 * for a claim that committed after its caller timed out, for a handler
 * this pod turns out not to have, and for a key another in-flight
 * delivery holds. Returns the number of rows released.
 */
export async function releaseClaims(
  deliveries: Array<Pick<ClaimedDelivery, "id" | "claimedBy" | "attempts">>,
  opts: { delayMs?: number } = {},
): Promise<number> {
  if (deliveries.length === 0) return 0;
  const delayMs = Math.max(0, Math.floor(opts.delayMs ?? 0));
  return await withTimeout(WRITE_TIMEOUT_MS, async (trx) => {
    const result = await sql<{ id: string }>`
      UPDATE event_deliveries d
      SET status = 'pending',
          attempts = GREATEST(0, d.attempts - 1),
          claimed_by = NULL,
          claimed_at = NULL,
          next_attempt_at = now() + (${delayMs} * interval '1 millisecond')
      FROM (VALUES ${
      sql.join(
        deliveries.map((d) => sql`(${d.id}::uuid, ${d.claimedBy}, ${d.attempts}::integer)`),
      )
    }) AS v(id, claimed_by, attempts)
      WHERE d.id = v.id
        AND d.status = 'running'
        AND d.claimed_by = v.claimed_by
        AND d.attempts = v.attempts
      RETURNING d.id
    `.execute(trx);
    const ids = result.rows.map((r) => r.id);
    if (ids.length > 0) {
      // A reservation this claim made must not outlive the claim.
      await trx.deleteFrom("event_handler_receipts").where("deliveryId", "in", ids).execute();
    }
    return ids.length;
  });
}

/** The claim token every status write is fenced on. */
type ClaimToken = Pick<ClaimedDelivery, "id" | "claimedBy" | "attempts">;

/**
 * Mark a claimed delivery done. With an idempotency key, also make sure
 * the receipt exists in the same transaction (processDelivery reserved
 * it before the handler ran; a direct caller gets it written here).
 * Returns false when the row was no longer this claim's `running` row
 * (a stale-claim reaper got there first and a peer re-claimed it); the
 * handler's side effect stands either way.
 */
export async function completeDelivery(
  delivery: ClaimToken & Pick<ClaimedDelivery, "subscriptionId"> & {
    event: Pick<PublishedEvent, "id">;
  },
  opts: { idempotencyKey?: string } = {},
): Promise<boolean> {
  return await withTimeout(WRITE_TIMEOUT_MS, async (trx) => {
    const updated = await trx
      .updateTable("event_deliveries")
      .set({ status: "done", doneAt: sql`now()`, lastError: null })
      .where("id", "=", delivery.id)
      .where("status", "=", "running")
      .where("claimedBy", "=", delivery.claimedBy)
      .where("attempts", "=", delivery.attempts)
      .executeTakeFirst();
    if (opts.idempotencyKey !== undefined) {
      // Our reservation becomes a completed receipt; a direct caller with
      // no reservation gets one written; another delivery's row is left
      // alone.
      await trx
        .insertInto("event_handler_receipts")
        .values({
          subscriptionId: delivery.subscriptionId,
          idempotencyKey: opts.idempotencyKey,
          eventId: delivery.event.id,
          deliveryId: delivery.id,
          completedAt: sql`now()`,
        })
        .onConflict((oc) =>
          oc
            .columns(["subscriptionId", "idempotencyKey"])
            .doUpdateSet({ completedAt: sql`now()` })
            .where("event_handler_receipts.deliveryId", "=", delivery.id)
        )
        .execute();
    }
    return Number(updated.numUpdatedRows ?? 0) > 0;
  });
}

/**
 * Delay before attempt `attempt + 1`, given `attempt` attempts so far.
 * Exponential from BACKOFF_BASE_MS, capped at BACKOFF_CAP_MS, with equal
 * jitter: half the delay is fixed, the other half scaled by `random()`.
 * Inject `random` (0 <= r < 1) for a deterministic test.
 */
export function computeBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(exp / 2 + r * (exp / 2));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 2_000);
  return String(err).slice(0, 2_000);
}

/**
 * Record a failed attempt. Out of attempts: `dead`, visible until
 * replayed. Otherwise `failed` with `next_attempt_at` pushed out by the
 * backoff, floored at `minDelayMs` (processDelivery passes the handler
 * timeout when the attempt timed out, so the retry cannot overlap the
 * ghost promise still running in this process). `attempts` on the
 * claimed row already counts this attempt. The idempotency reservation
 * this claim made is released in the same transaction.
 *
 * Fenced on the claim token: a write from a superseded claim (the reaper
 * requeued the row and a peer re-claimed it) updates nothing.
 *
 * The due time is computed from the DATABASE clock (`now()` plus the
 * delay), never from this process's clock: the claim query compares
 * against `now()` too, and a pod a few milliseconds ahead of Postgres
 * would otherwise write a "due" row the very next claim skips.
 */
export async function failDelivery(
  delivery: ClaimToken & Pick<ClaimedDelivery, "maxAttempts">,
  err: unknown,
  opts: { random?: () => number; minDelayMs?: number } = {},
): Promise<FailOutcome> {
  const dead = delivery.attempts >= delivery.maxAttempts;
  const delayMs = dead
    ? 0
    : Math.max(computeBackoffMs(delivery.attempts, opts.random), Math.floor(opts.minDelayMs ?? 0));
  const message = errorMessage(err);

  await withTimeout(WRITE_TIMEOUT_MS, async (trx) => {
    const updated = await trx
      .updateTable("event_deliveries")
      .set({
        status: dead ? "dead" : "failed",
        lastError: message,
        nextAttemptAt: sql`now() + (${delayMs} * interval '1 millisecond')`,
      })
      .where("id", "=", delivery.id)
      .where("status", "=", "running")
      .where("claimedBy", "=", delivery.claimedBy)
      .where("attempts", "=", delivery.attempts)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) > 0) {
      await trx.deleteFrom("event_handler_receipts").where("deliveryId", "=", delivery.id)
        .execute();
    }
  });

  return dead ? { status: "dead", delayMs: 0 } : { status: "failed", delayMs };
}

/**
 * Set a delivery back to `pending` with a fresh attempt budget. The
 * replay lane for a dead letter. A handler with an idempotency key whose
 * receipt exists will be skipped, which is the point of the key.
 */
export async function replayDelivery(deliveryId: string): Promise<boolean> {
  const updated = await withTimeout(WRITE_TIMEOUT_MS, (trx) =>
    trx
      .updateTable("event_deliveries")
      .set({ status: "pending", attempts: 0, nextAttemptAt: sql`now()`, lastError: null })
      .where("id", "=", deliveryId)
      .where("status", "in", ["dead", "failed", "done"])
      .executeTakeFirst());
  return Number(updated.numUpdatedRows ?? 0) > 0;
}

/**
 * A consumer that died mid-handler leaves rows `running` forever. Push
 * any claimed more than `staleAfterMs` ago back to `failed` (due now) or
 * `dead` when out of attempts. The attempt was already counted at claim
 * time, so a handler that crashes the pod every time still dead-letters.
 * Idempotency reservations of the requeued rows are dropped with them,
 * so a run that never completed leaves no receipt behind. Returns the
 * number of rows touched.
 */
export async function requeueStaleDeliveries(staleAfterMs: number): Promise<number> {
  const staleMs = Math.max(0, Math.floor(staleAfterMs));
  return await withTimeout(WRITE_TIMEOUT_MS, async (trx) => {
    const result = await sql<{ id: string }>`
      UPDATE event_deliveries d
      SET status = CASE WHEN d.attempts >= s.max_attempts THEN 'dead' ELSE 'failed' END,
          last_error = 'stale claim: consumer did not finish',
          next_attempt_at = now()
      FROM event_subscriptions s
      WHERE s.id = d.subscription_id
        AND d.status = 'running'
        AND d.claimed_at < now() - (${staleMs} * interval '1 millisecond')
      RETURNING d.id
    `.execute(trx);
    const ids = result.rows.map((r) => r.id);
    if (ids.length > 0) {
      await trx.deleteFrom("event_handler_receipts").where("deliveryId", "in", ids).execute();
    }
    return ids.length;
  });
}

// ── Process ──

export interface ProcessDeliveryOptions {
  random?: () => number;
  /**
   * Bound on one handler run. A handler that overruns is a failed attempt
   * whose retry is due no sooner than one more timeout from now (the
   * promise keeps running in the background; JS cannot cancel it, only
   * signal it through `ctx.signal`). A webhook POST is aborted for real.
   */
  handlerTimeoutMs?: number;
  /** Injected in tests for webhook deliveries. */
  fetch?: typeof fetch;
}

/** Default bound on one handler run; the consumer reads its env override. */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/** Delay before a delivery parked behind an in-flight same-key run is looked at again. */
const KEY_IN_FLIGHT_RETRY_MS = 2_000;

class AttemptTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "AttemptTimeoutError";
  }
}

/**
 * Race `fn` against a timer. On timeout the controller is aborted (so a
 * handler holding `ctx.signal` can stop) and an AttemptTimeoutError is
 * thrown; the promise itself keeps running.
 */
async function runWithTimeout<T>(
  label: string,
  ms: number,
  controller: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new AttemptTimeoutError(label, ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The stored idempotency key. Code-declared handler subscriptions are
 * global (organization_id NULL), so a key derived from a business field
 * ("invoice 1001") would collide across orgs; the org id is part of the
 * stored key so the receipt is per (subscription, org, key).
 */
export function scopedIdempotencyKey(organizationId: string | null, key: string): string {
  return `${organizationId ?? "global"}:${key}`;
}

type Reservation =
  | { state: "reserved" }
  | { state: "seen"; firstEventId: string }
  | { state: "in-flight"; ownerDeliveryId: string };

/**
 * Reserve (subscription, key) for this delivery BEFORE the handler runs,
 * in one statement: INSERT ... ON CONFLICT DO NOTHING RETURNING with
 * `completed_at` NULL. Two same-key deliveries processed concurrently
 * (one batch, or two pods with Redis down) then cannot both pass a
 * check-then-run guard: exactly one gets the row. `completeDelivery`
 * sets `completed_at`; failDelivery, releaseClaims and
 * requeueStaleDeliveries delete the reservation, so a row with
 * `completed_at` set is the only thing that means "handled".
 *
 * On conflict: a completed row is `seen`; a reservation whose delivery
 * is `running` under another claim is `in-flight`; any other reservation
 * is an orphan (its owner's cleanup write was lost, or it committed
 * late) and is replaced by ours.
 */
async function reserveIdempotencyKey(
  delivery: ClaimedDelivery,
  idempotencyKey: string,
): Promise<Reservation> {
  return await withTimeout(WRITE_TIMEOUT_MS, async (trx) => {
    const insert = () =>
      trx
        .insertInto("event_handler_receipts")
        .values({
          subscriptionId: delivery.subscriptionId,
          idempotencyKey,
          eventId: delivery.event.id,
          deliveryId: delivery.id,
          completedAt: null,
        })
        .onConflict((oc) => oc.columns(["subscriptionId", "idempotencyKey"]).doNothing())
        .returning("eventId")
        .executeTakeFirst();
    if (await insert()) return { state: "reserved" };

    const owner = await trx
      .selectFrom("event_handler_receipts as r")
      .leftJoin("event_deliveries as d", "d.id", "r.deliveryId")
      .select(["r.eventId", "r.deliveryId", "r.completedAt", "d.status"])
      .where("r.subscriptionId", "=", delivery.subscriptionId)
      .where("r.idempotencyKey", "=", idempotencyKey)
      .executeTakeFirst();
    if (!owner) {
      // Deleted between the two statements (its owner just failed); the
      // next claim of this row reserves it cleanly.
      return { state: "in-flight", ownerDeliveryId: "unknown" };
    }
    if (owner.completedAt !== null) return { state: "seen", firstEventId: owner.eventId };
    if (
      owner.deliveryId !== null && owner.deliveryId !== delivery.id && owner.status === "running"
    ) {
      return { state: "in-flight", ownerDeliveryId: owner.deliveryId };
    }
    // An orphaned reservation: nobody is running it and it never
    // completed. Take it over.
    await trx.deleteFrom("event_handler_receipts")
      .where("subscriptionId", "=", delivery.subscriptionId)
      .where("idempotencyKey", "=", idempotencyKey)
      .execute();
    if (await insert()) return { state: "reserved" };
    return { state: "in-flight", ownerDeliveryId: "unknown" };
  });
}

/**
 * Run one claimed delivery to its terminal outcome for this attempt.
 * Looks up the handler in the registry, reserves the idempotency key,
 * runs the handler outside any transaction, then completes, fails or
 * releases. Never throws: a broken handler is a failed delivery, not a
 * dead loop.
 */
export async function processDelivery(
  delivery: ClaimedDelivery,
  opts: ProcessDeliveryOptions = {},
): Promise<ProcessOutcome> {
  const handlerTimeoutMs = opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const controller = new AbortController();
  const ctx: DeliveryContext = {
    deliveryId: delivery.id,
    subscriptionId: delivery.subscriptionId,
    attempt: delivery.attempts,
    maxAttempts: delivery.maxAttempts,
    signal: controller.signal,
  };
  const baseLog = {
    source: LOG_SOURCE,
    feature: "process",
    deliveryId: delivery.id,
    eventId: delivery.event.id,
    topic: delivery.event.topic,
    handler: delivery.handler,
    attempt: delivery.attempts,
    maxAttempts: delivery.maxAttempts,
  };

  const release = async (reason: ReleaseReason, delayMs: number): Promise<ProcessOutcome> => {
    await releaseClaims([delivery], { delayMs });
    log.warn("event delivery released unrun; another pod or a later tick takes it", {
      ...baseLog,
      reason,
      delayMs,
    });
    return { outcome: "released", reason };
  };

  try {
    if (delivery.kind === "webhook") {
      await runWithTimeout(
        `webhook "${delivery.handler}"`,
        handlerTimeoutMs,
        controller,
        () => deliverWebhook(delivery, { fetch: opts.fetch, timeoutMs: handlerTimeoutMs }),
      );
      await completeDelivery(delivery);
      return { outcome: "done" };
    }
    if (delivery.kind !== "handler") {
      throw new Error(`no deliverer for subscription kind "${delivery.kind}"`);
    }
    const entry = registry.get(registryKey(delivery.event.topic, delivery.handler));
    if (!entry) {
      // Not a failure: this pod cannot run it (a rolling deploy, a claim
      // made without the registry filter). Give it back; no attempt burned.
      return await release("handler-not-registered", KEY_IN_FLIGHT_RETRY_MS);
    }

    const idempotencyKey = entry.idempotencyKey
      ? scopedIdempotencyKey(delivery.event.organizationId, entry.idempotencyKey(delivery.event))
      : undefined;
    if (idempotencyKey !== undefined) {
      const reservation = await reserveIdempotencyKey(delivery, idempotencyKey);
      if (reservation.state === "seen") {
        await completeDelivery(delivery);
        log.info("event delivery skipped: idempotency key already handled", {
          ...baseLog,
          firstEventId: reservation.firstEventId,
        });
        return { outcome: "skipped", reason: "idempotency-key-seen" };
      }
      if (reservation.state === "in-flight") {
        // The owner may still fail and free the key; look again shortly.
        return await release("idempotency-key-in-flight", KEY_IN_FLIGHT_RETRY_MS);
      }
    }

    await runWithTimeout(
      `handler "${delivery.handler}"`,
      handlerTimeoutMs,
      controller,
      async () => await entry.handler(delivery.event, ctx),
    );
    await completeDelivery(delivery, { idempotencyKey });
    return { outcome: "done" };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // A timed-out attempt's promise may still be running here. Floor the
    // retry one timeout out so the next attempt cannot overlap it.
    const minDelayMs = error instanceof AttemptTimeoutError ? handlerTimeoutMs : 0;
    let outcome: FailOutcome;
    try {
      outcome = await failDelivery(delivery, error, { random: opts.random, minDelayMs });
    } catch (dbErr) {
      // The status write itself failed; the stale-claim reaper will
      // requeue the row. Log both so neither failure hides the other.
      log.error("event delivery failed and the status write also failed", {
        ...baseLog,
        handlerError: error.message,
      }, dbErr);
      return { outcome: "failed", delayMs: 0 };
    }
    if (outcome.status === "dead") {
      // Out of attempts is the anomaly; a retry-able failure is expected.
      log.error("event delivery dead-lettered", baseLog, error);
      return { outcome: "dead" };
    }
    log.warn("event delivery failed; will retry", { ...baseLog, delayMs: outcome.delayMs }, error);
    return { outcome: "failed", delayMs: outcome.delayMs };
  }
}

// ── Retention ──

export interface RetentionOptions {
  /** Delete `done` deliveries this many days after they finished. */
  doneDeliveriesAfterDays: number;
  /** Delete events (and, by cascade, their deliveries and receipts) this old. */
  eventsAfterDays: number;
  /** Rows per DELETE; each batch is its own short transaction. */
  batch?: number;
  /** Stop after this many batches per table; the next sweep continues. */
  maxBatches?: number;
}

export interface RetentionResult {
  deliveriesDeleted: number;
  eventsDeleted: number;
}

/**
 * Bounded retention sweep. Deletes in small batches so no transaction
 * holds a large lock and pgbouncer never sees a long one. Events are the
 * outer boundary: an event past the window goes with every delivery
 * (dead ones included) and every receipt that hangs off it, because a
 * receipt older than the event window can no longer prevent anything.
 *
 * Except unfinished work: an event whose delivery on an ACTIVE
 * subscription is still `pending`, `running` or `failed` (in backoff, or
 * just replayed) is held past the window until that delivery reaches
 * `done` or `dead`. Otherwise a long retry chain or a late replay would
 * vanish mid-flight with no trace. Parked deliveries of an inactive
 * subscription do not hold the event; they were never going to run.
 * Days are read as whole days; 0 disables that half of the sweep.
 */
export async function sweepEventRetention(opts: RetentionOptions): Promise<RetentionResult> {
  const batch = Math.max(1, Math.min(10_000, Math.floor(opts.batch ?? 1_000)));
  const maxBatches = Math.max(1, Math.min(1_000, Math.floor(opts.maxBatches ?? 20)));
  const result: RetentionResult = { deliveriesDeleted: 0, eventsDeleted: 0 };

  const deliveryDays = Math.floor(opts.doneDeliveriesAfterDays);
  if (deliveryDays > 0) {
    for (let i = 0; i < maxBatches; i++) {
      const n = await withTimeout(WRITE_TIMEOUT_MS, async (trx) => {
        const r = await sql<{ id: string }>`
          DELETE FROM event_deliveries
          WHERE id IN (
            SELECT id FROM event_deliveries
            WHERE status = 'done' AND done_at < now() - (${deliveryDays} * interval '1 day')
            LIMIT ${batch}
          )
          RETURNING id
        `.execute(trx);
        return r.rows.length;
      });
      result.deliveriesDeleted += n;
      if (n < batch) break;
    }
  }

  const eventDays = Math.floor(opts.eventsAfterDays);
  if (eventDays > 0) {
    for (let i = 0; i < maxBatches; i++) {
      const n = await withTimeout(WRITE_TIMEOUT_MS, async (trx) => {
        const r = await sql<{ id: string }>`
          DELETE FROM events
          WHERE id IN (
            SELECT e.id FROM events e
            WHERE e.created_at < now() - (${eventDays} * interval '1 day')
              AND NOT EXISTS (
                SELECT 1
                FROM event_deliveries d
                JOIN event_subscriptions s ON s.id = d.subscription_id
                WHERE d.event_id = e.id
                  AND d.status IN ('pending', 'running', 'failed')
                  AND s.active
              )
            LIMIT ${batch}
          )
          RETURNING id
        `.execute(trx);
        return r.rows.length;
      });
      result.eventsDeleted += n;
      if (n < batch) break;
    }
  }

  if (result.deliveriesDeleted > 0 || result.eventsDeleted > 0) {
    log.info("event retention sweep deleted rows", {
      source: LOG_SOURCE,
      feature: "retention",
      ...result,
    });
  }
  return result;
}
