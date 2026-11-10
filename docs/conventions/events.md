# Events

## Events: publish in the transaction, handle idempotently

The mechanics (`src/lib/events.ts`, the consumer, the inbox route, the
webhook deliverer, the exact function signatures) live in
`.claude/rules/events.md` and load when you touch event code. This section
is the part that has to be in your head BEFORE that: how to notice that a
ticket is an event, where the publish call goes, and what a handler must
promise.

### How to recognize an event

A ticket that says "when X happens, do Y" is an event plus a handler, not
a scheduler. Treat the ticket or message as involving events when you see:

- "when", "after", "once", "as soon as", "every time" followed by a state
  change: created, paid, shipped, approved, expired, imported, failed
- "notify", "sync to", "push to", "send a confirmation", "update the
  other system", "trigger", "fan out"
- a proposed `setInterval` or cron whose body is "find rows that changed
  since last time and do something with them": that is a poller
  re-deriving an event stream. Publish the event where the row changes and
  the poller disappears.
- a webhook the customer wants to receive from this app in their own
  systems: an outbound webhook subscription, no code.

What is NOT an event:

- **A request/response.** The caller waits for the answer (a form submit
  that returns the saved row, a search). Do the work in the route.
- **A cache fill.** Recomputing a report because it is stale is `cacheGet`
  / `cacheSet` (see Redis above), not a topic.
- **A pure schedule.** "Every night at 02:00 send the digest" has no
  triggering change. That is a job loop under `src/jobs/` with
  `acquireLock`. If the digest is "for every order paid today", the
  orders were events; the nightly send is still a schedule.
- **Work the same transaction can finish.** Updating a denormalized count
  in the row you are already writing does not need a handler.

### The rules

- **`publishEvent(trx, ...)` goes INSIDE the transaction that made the
  change, never after it.** The event row and the business row commit or
  roll back together; that is the whole exactly-once guarantee. A publish
  after commit can be lost (the pod dies between the two writes) and a
  publish before commit can describe a change that never happened. Call
  `nudge(topic)` AFTER commit; it is only the wake-up. Outside any
  transaction (a webhook route, a script) use `publishEventAndNudge`.
- **Handlers are idempotent and order-tolerant.** A handler WILL run again
  after a crash, a timeout or a stale claim, and it may see `order.paid`
  before `order.created`. Write it so a second run is a no-op (upsert, set
  not increment, check the target state first). When the side effect is
  not naturally idempotent (an email, a charge, a POST to a system with no
  dedup), pass `idempotencyKey` and the consumer reserves the key before
  the run and records a receipt after it. The key is scoped per org for
  you (a global handler's `invoiceNumber` never collides across tenants).
- **Handlers are bounded.** One attempt must finish inside
  `EVENTS_HANDLER_TIMEOUT_MS` (30s). Long work publishes a follow-up event
  or writes a row for a job loop. `ctx.signal` aborts at the timeout; the
  promise itself is not cancelled, so pass the signal to `fetch` and check
  it between steps.
- **Topics are `noun.past_tense`**: `order.created`, `invoice.paid`,
  `shipment.delivered`, `import.completed`. Lowercase segments joined by
  dots. Not `create_order`, not `OrderCreated`, not `on_order`. The noun is
  the thing that changed; the verb is what happened to it. `key` is that
  thing's id, so an operator can find every event for one order.
- **Payload is a JSON object with what the handler needs to act, not the
  whole row.** Include the ids and the fields that changed. The handler
  re-reads current state when it needs it; the payload is a snapshot at
  publish time.
- **Declare handlers once, in `src/events/handlers.ts`.** Registration
  is pure bookkeeping (no DB, no network). The consumer syncs
  `event_subscriptions` from the registry at boot; a renamed handler is a
  new subscription and the old one is deactivated, never deleted.
- **Never LISTEN, never `pg_advisory_lock`, never Redis as the log.** The
  log is Postgres. Redis only shortens the wait and loses nothing when it
  is down.

### Adding an outbound webhook

A builder who wants their own systems to hear about `order.created` gets a
subscription of `kind = 'webhook'`, created with
`createWebhookSubscription({ organizationId, topic, label, url, secretRef })`.
`secretRef` is the NAME of an env var that holds the signing secret (the
platform injects it; the repo stores no ciphertext). The URL must be public
https (no loopback, no private ranges, checked at create and at every
delivery). The consumer POSTs the event JSON with `X-Event-Id`,
`X-Event-Topic`, `X-Event-Timestamp`, `X-Event-Signature` (HMAC-SHA256 over
`${timestamp}.${body}`), `X-Event-Delivery` and `X-Event-Attempt`; a non-2xx
is a failed attempt with the same backoff, dead letter and replay as a
handler. Subscriptions are org-scoped: the org id is in every WHERE.

### The three tables, and what an operator can do

| Table | What it is | Retention |
|---|---|---|
| `events` | the outbox and the audit trail: `id` (time-ordered), `topic`, `key`, `payload`, `source` (`app`, `platform`, `external`), `organization_id` | 90 days (`EVENTS_RETENTION_EVENTS_DAYS`) |
| `event_subscriptions` | who hears what: `topic`, `handler`, `kind` (`handler`, `webhook`), `max_attempts`, `url`, `secret_ref`, `active` | kept; removed handlers are deactivated |
| `event_deliveries` | one row per (event, subscription): `status` (`pending`, `running`, `done`, `failed`, `dead`), `attempts`, `next_attempt_at`, `last_error`, `claimed_by`, `claimed_at` | `done` rows 7 days (`EVENTS_RETENTION_DELIVERIES_DAYS`) |

`event_handler_receipts` is the fourth, internal one: the idempotency
ledger behind `idempotencyKey`.

From `event_deliveries` an operator can:

- **Inspect dead letters:** `SELECT d.*, e.topic, e.key FROM event_deliveries d JOIN events e ON e.id = d.event_id WHERE d.status = 'dead'`. `last_error` holds the final failure.
- **Replay one:** `replayDelivery(id)` (or `UPDATE event_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = ...`). Works on `dead`, `failed` and `done`; the handler runs again, so this is where idempotency pays.
- **Replay a subscription from a date:** insert `pending` deliveries for every `events` row since the date that has no delivery for that subscription (the unique index on `(event_id, subscription_id)` makes the insert idempotent).
- **See what is stuck:** `status = 'running'` older than `EVENTS_STALE_CLAIM_MS` (10 min, floored higher for big batches or long timeouts) means a claimer died; the next tick requeues it and logs at `log.error`. `pending` rows that never get claimed belong to an inactive subscription (parked) or to a handler no running pod has registered.
- **Find every event for one order:** `SELECT * FROM events WHERE key = '<order id>' ORDER BY id` (ids are time-ordered).
