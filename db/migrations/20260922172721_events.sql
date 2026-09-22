-- Durable event log: the outbox, the subscription registry, the delivery
-- ledger and the idempotency receipts.
--
-- Why this is Postgres and not a broker: an event row is inserted in the
-- SAME transaction as the business change it describes (see
-- src/lib/events.ts publishEvent). The event exists if and only if the
-- change committed. That is the exactly-once emission property and no
-- dual write to Redis, Pub/Sub or a queue can give it.
--
-- events             append-only. One row per thing that happened.
-- event_subscriptions who wants to hear about a topic. Code-declared
--                    handlers (kind='handler', organization_id NULL,
--                    synced at boot from registerEventHandler) and
--                    outbound webhooks (kind='webhook', org-scoped,
--                    created from the app's settings).
-- event_deliveries   one row per (event, subscription). The unit of work
--                    the consumer claims with FOR UPDATE SKIP LOCKED.
-- event_handler_receipts
--                    (subscription, idempotency key) pairs. A row is
--                    RESERVED (completed_at NULL) before the handler runs,
--                    so two concurrent same-key deliveries cannot both
--                    run it, and COMPLETED (completed_at set) after. A
--                    redelivery whose key is completed is marked done
--                    without running the handler again. The key is
--                    stored org-scoped ("<org id or global>:<key>").
--
-- event_deliveries.status
--   pending  waiting for its first attempt
--   running  claimed by a consumer; claimed_by / claimed_at say which
--   done     the handler completed
--   failed   an attempt failed; next_attempt_at says when to retry
--   dead     out of attempts; stays visible, replayable by hand
--
-- Fanout (one delivery per active subscription) is done by the publisher
-- in TypeScript inside the caller's transaction, not by a trigger, so it
-- is testable and visible in one place.
--
-- organization_id is NULLABLE on events and subscriptions. A platform or
-- external event may not belong to an org; a code-declared handler
-- applies to every org. Anything listed to a person in the app must
-- still filter on organization_id (CWE-639).
--
-- events.id has no time-ordered default in PG16 (no uuidv7 built in and
-- no extension allowed); the publisher generates a UUIDv7 in
-- src/lib/uuidv7.ts. gen_random_uuid() is the fallback for raw inserts.
--
-- Every JSONB column carries the jsonb_typeof CHECK from
-- 20260728234906_jsonb_no_string_scalars.sql.
--
-- Unqualified table names: the customer DB role's search_path resolves
-- them (see 001_initial_schema.sql). IDEMPOTENT: every DDL is guarded.

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  -- The business key the event is about (an order id, a file key).
  -- Ordering per key is not in this version; handlers are order-tolerant.
  key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) <> 'string'),
  source TEXT NOT NULL DEFAULT 'app'
    CHECK (source IN ('app', 'platform', 'external')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_topic_created
  ON events (topic, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_org_created
  ON events (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_key
  ON events (key)
  WHERE key IS NOT NULL;
-- The retention sweep deletes old events in bounded batches by created_at.
CREATE INDEX IF NOT EXISTS idx_events_created
  ON events (created_at);

CREATE TABLE IF NOT EXISTS event_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for a code-declared handler (applies to every org's events).
  -- Set for an outbound webhook a builder created for their org.
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  -- The registered handler's name, or a label for a webhook.
  handler TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'handler'
    CHECK (kind IN ('handler', 'webhook')),
  -- Total attempts before a delivery goes dead (first attempt included).
  max_attempts INTEGER NOT NULL DEFAULT 8
    CHECK (max_attempts >= 1),
  -- Webhook only: where to POST, and the NAME of the env var holding the
  -- signing secret. Never the secret itself.
  url TEXT,
  secret_ref TEXT,
  -- A handler removed from code is deactivated, never deleted, so its
  -- pending and dead deliveries stay visible.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Boot sync upserts on these. Two partial indexes because a NULL
-- organization_id never conflicts with itself in a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_subscriptions_global
  ON event_subscriptions (topic, handler)
  WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_subscriptions_org
  ON event_subscriptions (organization_id, topic, handler)
  WHERE organization_id IS NOT NULL;
-- The fanout query: active subscriptions for a topic.
CREATE INDEX IF NOT EXISTS idx_event_subscriptions_topic_active
  ON event_subscriptions (topic)
  WHERE active;

DROP TRIGGER IF EXISTS trg_event_subscriptions_updated_at ON event_subscriptions;
CREATE TRIGGER trg_event_subscriptions_updated_at
  BEFORE UPDATE ON event_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS event_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead')),
  -- Incremented when a consumer claims the row, so a handler that
  -- crashes the pod every time still runs out of attempts.
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One delivery per (event, subscription). Leading on event_id, this also
-- serves the "deliveries of this event" lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_deliveries_event_subscription
  ON event_deliveries (event_id, subscription_id);
-- The consumer claim query: WHERE status IN ('pending','failed')
-- AND next_attempt_at <= now() ORDER BY next_attempt_at.
CREATE INDEX IF NOT EXISTS idx_event_deliveries_status_next_attempt
  ON event_deliveries (status, next_attempt_at);
-- The stale-claim reaper: running rows whose claimer died mid-handler.
CREATE INDEX IF NOT EXISTS idx_event_deliveries_running_claimed
  ON event_deliveries (claimed_at)
  WHERE status = 'running';
-- The retention sweep: done rows older than the window.
CREATE INDEX IF NOT EXISTS idx_event_deliveries_done_at
  ON event_deliveries (done_at)
  WHERE status = 'done';

DROP TRIGGER IF EXISTS trg_event_deliveries_updated_at ON event_deliveries;
CREATE TRIGGER trg_event_deliveries_updated_at
  BEFORE UPDATE ON event_deliveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS event_handler_receipts (
  subscription_id UUID NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  -- Cascades with the event so the 90-day event sweep clears receipts.
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  delivery_id UUID REFERENCES event_deliveries(id) ON DELETE SET NULL,
  -- NULL while the owning delivery is still running (a reservation);
  -- set when its handler completed (a receipt). A reservation whose
  -- delivery failed, was released or went stale is deleted with it.
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (subscription_id, idempotency_key)
);
-- A database that ran an earlier shape of this file: same column, nullable.
ALTER TABLE event_handler_receipts ALTER COLUMN completed_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_handler_receipts_event
  ON event_handler_receipts (event_id);
