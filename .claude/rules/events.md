---
name: events
description: Durable event mechanics -- src/lib/events.ts (publish, register, claim, complete, fail, replay, retention), the consumer loop in src/jobs/event-consumer.ts, POST /api/events/inbox, outbound webhook subscriptions and signing. Load when touching event code. The DECISION rules (what is an event, publish inside the transaction, idempotent handlers, topic naming) live in the hub CLAUDE.md under "Events: publish in the transaction, handle idempotently".
paths:
  - "src/lib/events.ts"
  - "src/lib/event-signing.ts"
  - "src/lib/event-webhooks.ts"
  - "src/lib/uuidv7.ts"
  - "src/events/**"
  - "src/jobs/event-consumer.ts"
  - "src/api/routes/events/**"
  - "db/migrations/*_events.sql"
---

# Durable event mechanics

Read the hub section "Events: publish in the transaction, handle
idempotently" first; it decides WHETHER something is an event and WHERE
the publish goes. This file is HOW. Every signature below is copied from
the code; when they drift, the code wins and this file gets fixed.

## Three properties, three mechanisms

| Property | Mechanism | Where |
|---|---|---|
| Exactly-once emission | event row + delivery rows inserted inside the caller's transaction | `publishEvent(trx, ...)` |
| At-least-once delivery | `FOR UPDATE SKIP LOCKED` claim, handler outside the transaction, backoff, dead letter, replay | `claimDeliveries`, `processDelivery`, `failDelivery`, `replayDelivery` |
| Low latency | Redis pub/sub nudge on the project's `events` channel; polling is the guarantee | `nudge`, `redisSubscribe` in `src/lib/redis.ts` |

Ordering per key is not provided. Handlers are order-tolerant.

## Publishing (`src/lib/events.ts`)

```ts
export interface PublishEventInput {
  topic: string;                       // noun.past_tense, /^[a-z0-9_]+(\.[a-z0-9_]+)+$/
  key?: string | null;                 // the changed thing's id
  payload?: Record<string, unknown>;   // a JSON object; arrays are rejected
  source?: EventSource;                // 'app' (default) | 'platform' | 'external'
  organizationId?: string | null;      // null = global
  id?: string;                         // supply one to make the publish idempotent
}
export interface PublishResult { id: string; topic: string; deliveries: number; inserted: boolean }

export async function publishEvent(trx: Kysely<Database>, input: PublishEventInput): Promise<PublishResult>;
export async function nudge(topic: string): Promise<void>;
export async function publishEventAndNudge(input: PublishEventInput): Promise<PublishResult>;
```

- `publishEvent` inserts the event and one `pending` delivery per active
  subscription for the topic (global subscriptions plus the event's org)
  in the SAME transaction it is handed. `inserted: false` means the `id`
  already existed and nothing was written.
- `nudge` runs after commit. It calls `redisPublish(EVENTS_CHANNEL, ...)`
  and fails open; a lost nudge costs at most one poll interval.
- `publishEventAndNudge` opens its own short transaction, then nudges. Use
  it only when there is no surrounding transaction (a route, a script,
  the inbox).
- Payload arrays throw: postgres.js would store a JS array as a Postgres
  array, not JSONB. Never pass a pre-stringified value.
- Ids are `uuidv7()` (`src/lib/uuidv7.ts`): time-ordered, so `ORDER BY id`
  is publish order. PG16 has no `uuidv7`; do not add an extension.

## Registering handlers

```ts
export type EventHandler = (event: PublishedEvent, ctx: DeliveryContext) => Promise<void> | void;
export interface DeliveryContext { deliveryId: string; subscriptionId: string; attempt: number; maxAttempts: number; signal: AbortSignal }
export interface RegisterEventHandlerOptions {
  retries?: number;                                   // AFTER the first attempt; default DEFAULT_RETRIES = 7
  idempotencyKey?: (event: PublishedEvent) => string; // reserved before the run; scoped per org
  name?: string;                                      // required for an anonymous fn
}
export function registerEventHandler(topic: string, fn: EventHandler, options?: RegisterEventHandlerOptions): RegisteredHandler;
export function getRunnableHandlers(): RunnableHandler[];  // the (topic, handler) pairs this process can run
export async function syncSubscriptionsFromRegistry(opts?: { deactivateGraceMs?: number }): Promise<{ upserted: number; deactivated: number }>;
```

- Declare in `src/events/handlers.ts` inside `registerEventHandlers()`,
  which `main.ts` calls before DB init. Registration throws on a bad
  topic, an anonymous handler without `name`, or a duplicate (topic,
  name): these fail the boot on purpose.
- The function NAME is the subscription identity
  (`event_subscriptions.handler`). Rename the function and the boot
  upserts a new subscription; the old one is deactivated once no pod has
  declared it for `SUBSCRIPTION_DEACTIVATE_GRACE_MS` (1 h). Its pending
  deliveries are parked (never claimed while inactive); replay them onto
  the new one by hand if that matters.
- `syncSubscriptionsFromRegistry` runs once at consumer boot. It upserts
  on the partial unique index for global rows (the upsert bumps
  `updated_at`, which is "last seen by any pod"), updates `max_attempts`,
  and deactivates handler rows no longer in the registry whose
  `updated_at` is older than the grace window. It never deletes. The
  grace window is what stops an old-version pod restarting mid-rollout
  from deactivating a handler only the new version has (that fanned out
  zero deliveries, unrecoverably).
- `ctx.attempt` is 1 on the first run. Use it for "log louder on the last
  try", never for control flow. `ctx.signal` aborts when the attempt
  times out; pass it to `fetch` and check it between steps, because the
  runtime cannot cancel the promise itself.

## The consumer (`src/jobs/event-consumer.ts`)

```ts
export function startEventConsumer(opts?: EventConsumerOptions): void;
export function wakeEventConsumer(): void;
export async function stopEventConsumer(): Promise<void>;  // resolves after the tick in flight wrote its outcome
```

Started from `main.ts` inside the `runsBackgroundWork` block (the api pod,
same place as the other loops) and listed in `src/__tests__/worker-role.test.ts`.
Each tick, on a `setTimeout` chain that never overlaps and never dies:

1. `acquireLock("event-consumer", EVENTS_LOCK_TTL_S)`; another pod holds it: skip the tick. The lock carries an owner token, is refreshed every third of its (short) TTL while the tick runs, and is released with a compare-and-delete, so a dead holder or a Redis blip stalls peers for one TTL at most.
2. `claimDeliveries(EVENTS_BATCH_SIZE, { claimedBy, runnableHandlers: getRunnableHandlers() })`: one transaction, `FOR UPDATE SKIP LOCKED`, rows marked `running`, `attempts + 1`. Only active subscriptions; handler deliveries only for pairs this process registered (webhooks always). A claim that times out during pool acquisition rolls back or hands its rows straight back; it never orphans them.
3. `processDelivery` on each with `EVENTS_CONCURRENCY` workers and `EVENTS_HANDLER_TIMEOUT_MS` per run.
4. `requeueStaleDeliveries(EVENTS_STALE_CLAIM_MS)`: `running` rows older than the window go back to `failed` (due now) or `dead`, and their idempotency reservations are dropped.
5. Every `EVENTS_RETENTION_SWEEP_MS`, throttled across pods in Redis: `sweepEventRetention`.

A full batch reschedules at 0 ms. A Redis message on the `events` channel
coalesces into one immediate tick (`wakeEventConsumer`), including one
that lands during the boot sync. `NODE_ENV=test` keeps the loop dormant
unless `runInTestEnv` is passed. `stopEventConsumer()` resolves after the
tick in flight has written its outcomes (bounded by one handler timeout
plus a write); `main.ts` awaits it before `closeDatabase()`.

Env (read per tick, no restart): `EVENTS_POLL_INTERVAL_MS` 5000,
`EVENTS_BATCH_SIZE` 25, `EVENTS_CONCURRENCY` 4, `EVENTS_HANDLER_TIMEOUT_MS`
30000, `EVENTS_LOCK_TTL_S` 60, `EVENTS_STALE_CLAIM_MS` 600000 (floored to
`ceil(batch / concurrency) * (timeout + 5 s) + 60 s`, because a claimed
row waits that many rounds in the in-process queue before its handler
starts; a raised value is logged at boot), `EVENTS_RETENTION_DELIVERIES_DAYS`
7, `EVENTS_RETENTION_EVENTS_DAYS` 90, `EVENTS_RETENTION_SWEEP_MS` 3600000.
Documented in `.env.example`.

## Claim, complete, fail, replay

```ts
export interface ClaimOptions { claimedBy: string; topics?: string[]; runnableHandlers?: RunnableHandler[]; timeoutMs?: number }
export async function claimDeliveries(batch: number, opts: ClaimOptions): Promise<ClaimedDelivery[]>;
export async function releaseClaims(deliveries: Array<Pick<ClaimedDelivery, "id" | "claimedBy" | "attempts">>, opts?: { delayMs?: number }): Promise<number>;
export async function completeDelivery(delivery: Pick<ClaimedDelivery, "id" | "claimedBy" | "attempts" | "subscriptionId"> & { event: Pick<PublishedEvent, "id"> }, opts?: { idempotencyKey?: string }): Promise<boolean>;
export function computeBackoffMs(attempt: number, random?: () => number): number;
export async function failDelivery(delivery: Pick<ClaimedDelivery, "id" | "claimedBy" | "attempts" | "maxAttempts">, err: unknown, opts?: { random?: () => number; minDelayMs?: number }): Promise<FailOutcome>;
export async function replayDelivery(deliveryId: string): Promise<boolean>;
export async function requeueStaleDeliveries(staleAfterMs: number): Promise<number>;
export async function processDelivery(delivery: ClaimedDelivery, opts?: ProcessDeliveryOptions): Promise<ProcessOutcome>;
export async function sweepEventRetention(opts: RetentionOptions): Promise<RetentionResult>;

export type FailOutcome = { status: "failed"; delayMs: number } | { status: "dead"; delayMs: 0 };
export type ProcessOutcome =
  | { outcome: "done" }
  | { outcome: "skipped"; reason: "idempotency-key-seen" }
  | { outcome: "released"; reason: "handler-not-registered" | "idempotency-key-in-flight" }
  | { outcome: "failed"; delayMs: number }
  | { outcome: "dead" };
export interface RetentionOptions { doneDeliveriesAfterDays: number; eventsAfterDays: number; batch?: number; maxBatches?: number }
```

- The handler runs OUTSIDE the claim transaction. pgbouncer is in
  transaction-pool mode; a transaction held across a webhook POST pins a
  backend and blocks migrations. The price is the `running` state and the
  stale-claim requeue.
- `computeBackoffMs`: 1 s doubling per attempt, capped at 1 h
  (`BACKOFF_BASE_MS`, `BACKOFF_CAP_MS`), equal jitter. `attempts >=
  max_attempts` on failure means `dead`.
- Every due-time write (`failDelivery`, `replayDelivery`,
  `completeDelivery`, `requeueStaleDeliveries`) uses SQL `now()`, never the
  JS clock. The claim compares against the DB clock; a 10 ms host skew
  made a just-replayed row "not due" in tests, and pods vs Cloud SQL skew
  the same way.
- `completeDelivery`, `failDelivery` and `releaseClaims` are fenced on
  the claim token (`id`, `claimed_by`, `attempts`). A write from a claim
  the reaper already handed to a peer matches zero rows (`completeDelivery`
  returns false) instead of overwriting the peer's run.
- `processDelivery` with an `idempotencyKey` handler RESERVES the key
  before the handler runs: `INSERT INTO event_handler_receipts ... ON
  CONFLICT DO NOTHING RETURNING`. Exactly one of two concurrent same-key
  deliveries gets the row; the other is `skipped` (owner done, or this
  delivery replayed) or `released` for a couple of seconds (owner still
  `running`). The stored key is `${organizationId ?? "global"}:${key}`
  (`scopedIdempotencyKey`), because handler subscriptions are global and
  a business key would otherwise collide across orgs. A failed attempt, a
  release and a stale requeue drop the reservation, so a receipt exists
  only for a run that completed.
- An unregistered handler name is a `released` outcome, not a failure:
  the row goes back to `pending` with the attempt uncounted and a short
  delay, for a pod that has the code. The consumer's claim filter makes
  this unreachable in normal operation. A handler overrunning
  `handlerTimeoutMs` is a failed attempt whose retry is floored at one
  more timeout from now (the promise keeps running; `ctx.signal` is
  aborted so a cooperative handler can stop), which is one more reason
  handlers must be idempotent. A webhook POST is aborted for real.
- `replayDelivery` resets `dead`, `failed` or `done` to `pending` with
  `attempts = 0`. `requeueStaleDeliveries` does NOT reset attempts; the
  claim already counted them, so a handler that crashes the pod every
  time still dead-letters.
- The retention sweep holds an event past its window while a delivery
  on an ACTIVE subscription is still `pending`, `running` or `failed`;
  parked deliveries of an inactive subscription go with the event.
- Log levels: a retryable failure and a release are `log.warn`, a dead
  letter and a stale requeue are `log.error`. Every call carries
  `source: "events"` and a `feature`.

## Outbound webhooks (`src/lib/event-webhooks.ts`, `src/lib/event-signing.ts`)

```ts
export function validateWebhookUrl(raw: string): string;
export interface CreateWebhookSubscriptionInput {
  organizationId: string; topic: string; label: string; url: string;
  secretRef: string;      // the NAME of the env var holding the signing secret
  retries?: number;       // after the first attempt
}
export async function createWebhookSubscription(input: CreateWebhookSubscriptionInput): Promise<EventSubscriptionRow>;
export async function listWebhookSubscriptions(organizationId: string): Promise<EventSubscriptionRow[]>;
export async function deactivateWebhookSubscription(organizationId: string, subscriptionId: string): Promise<void>;
export async function deliverWebhook(delivery: ClaimedDelivery, opts?: { fetch?: typeof fetch; timeoutMs?: number; nowMs?: () => number }): Promise<void>;

export function signEventBody(secret: string, timestampSeconds: number, rawBody: string): string;
export function verifyEventSignature(input: { secret: string; rawBody: string; timestampHeader: string | undefined | null; signatureHeader: string | undefined | null; nowMs?: number; toleranceSeconds?: number }): VerifyResult;
```

- `validateWebhookUrl`: https only, no credentials in the URL, rejects
  loopback, private, link-local, CGNAT, multicast, IPv4-mapped IPv6, ULA
  and local hostnames, in every spelling (`127.1`, `0177.0.0.1`,
  `[::ffff:10.0.0.1]`). It runs at create AND at every delivery. It does
  not resolve DNS; a public name that resolves privately at delivery time
  is not caught.
- `createWebhookSubscription` refuses a `secretRef` whose env var is unset
  (a hook that can never sign is a bug at creation, not at delivery). The
  repo has no encryption-at-rest helper; secrets are env var references,
  never stored values.
- `deliverWebhook` POSTs the event JSON with `redirect: "manual"` and
  `AbortSignal.timeout(DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000)`. Headers:
  `X-Event-Id`, `X-Event-Topic`, `X-Event-Timestamp` (unix seconds),
  `X-Event-Signature: v1=<hex HMAC-SHA256(secret, "${ts}.${rawBody}")>`,
  `X-Event-Delivery`, `X-Event-Attempt`. A 3xx or a non-2xx throws with a
  200-char body excerpt, which becomes a failed attempt.
- `verifyEventSignature` is constant-time, returns a named reason
  (`missing-timestamp`, `malformed-timestamp`, `stale-timestamp`,
  `missing-signature`, `malformed-signature`, `signature-mismatch`), and
  tolerates 5 minutes each way (`DEFAULT_TIMESTAMP_TOLERANCE_S`).
- Every org-scoped function takes the org id and puts it in the WHERE. A
  cross-org deactivate is a 404.
- The builder-facing route for managing webhook subscriptions is not
  shipped; these are service-level calls today.

## Inbox (`src/api/routes/events/index.ts`, mounted at `/api/events`)

`POST /api/events/inbox` is how the platform and external relays write
into this project's log.

- `EVENTS_INBOX_SECRET` unset: 401 and a `log.warn` (fail closed). A bad
  caller is `log.info`.
- The signature (same scheme as outbound) is verified over the RAW body
  text before any parse. Body limit 1 MiB (413 above it).
- Schema: `{ id: uuid, topic, key?, payload?: object, source: 'platform' | 'external' }`.
  Unknown keys are dropped, so an `organizationId` in the body never
  reaches the insert; `organization_id` is always NULL for inbox events.
- 201 when inserted, 200 when the `id` already existed (nothing written).
  Malformed id, topic, source, payload or JSON is 400 with nothing written.

## The migration (`db/migrations/20260922172721_events.sql`)

Four tables, all `CREATE TABLE IF NOT EXISTS`, statuses and kinds as
`CHECK` constraints (no enums), `jsonb_typeof(payload) <> 'string'`,
`DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`. Indexes:

- `events`: `(topic, created_at)`, `(organization_id, created_at)`, `key`, `created_at` (retention).
- `event_subscriptions`: partial unique on `(topic, handler)` for global rows and `(organization_id, topic, handler)` for org rows; `(topic, active)`.
- `event_deliveries`: unique `(event_id, subscription_id)` (also the event lookup), `(status, next_attempt_at)` for the claim, partial on `running` + `claimed_at` for the stale reaper, partial on `done_at` for retention.
- `event_handler_receipts`: primary key `(subscription_id, idempotency_key)`, index on `event_id`; cascades with the event.

Applied twice through the runner and once raw with `ON_ERROR_STOP`: it is
idempotent. The four tables are in `DEFAULT_TRUNCATE_TABLES` in
`src/api/routes/dev/index.ts`.

## Tests

`src/__tests__/services/events.test.ts` (publish, claim races, backoff,
dead letter, idempotency, stale requeue, sync),
`src/__tests__/services/event-consumer.test.ts` (loop, nudge, webhooks,
URL validation, signature, retention),
`src/__tests__/routes/events-inbox.test.ts` (auth, idempotency, schema).
`src/__tests__/events-guidance.test.ts` pins this file and the hub section.
A new handler gets a test that runs it twice on the same event and asserts
the second run changed nothing.
