-- 20260922180901_email_outbox_and_scheduled_jobs.sql
-- Durable, retried email delivery + recurring jobs.
--
-- Two tables:
--
--   email_outbox    Every outbound email that is not a synchronous
--                   auth email (OTP) goes through here. A row is a
--                   "send this, at or after send_at, at most once".
--                   The in-process job runner (src/jobs/runner.ts)
--                   claims due rows with FOR UPDATE SKIP LOCKED, so
--                   N replicas never double-send, and retries with
--                   backoff on SMTP failure.
--
--   scheduled_jobs  Recurring work expressed as a cron expression +
--                   IANA timezone. Each row names a handler `kind`
--                   registered in src/jobs/registry.ts; the runner
--                   invokes it when next_run_at is due and advances
--                   next_run_at. Handlers typically enqueue emails.
--                   Run records land in the existing job_history table.
--
-- Event-driven email = a service calls enqueueEmail() right after the
-- state change (ideally in the same transaction). Periodic email = a
-- scheduled_jobs row whose handler enqueues. Same delivery path either way.
--
-- Unqualified table names: the customer DB role's search_path resolves
-- them into the customer's own schema (see 001_initial_schema.sql).

-- --------------------------------------------------------------------------
-- email_outbox
-- --------------------------------------------------------------------------
CREATE TABLE email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cascade: an organization's queued mail goes with the organization.
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  -- The recipient user when known. SET NULL so a removed user's row
  -- stays for audit but stops pointing at nothing.
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT,
  reply_to TEXT,
  -- Caller-supplied dedupe key. A second enqueue with the same key is a
  -- no-op (returns the existing row). Use it for "once per user per
  -- event" and "once per schedule run per user".
  idempotency_key TEXT,
  send_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  -- Set while a runner holds the row. A row stuck in 'sending' longer
  -- than the stale-lock window is reclaimed on the next tick.
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  -- Free-form origin tag for debugging + dashboards, e.g. 'invite',
  -- 'job:org_digest', 'order.shipped'.
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX email_outbox_idempotency_key_idx
  ON email_outbox(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The runner's hot query: pending or stale-sending rows ordered by send_at.
CREATE INDEX email_outbox_due_idx
  ON email_outbox(send_at)
  WHERE status IN ('pending', 'sending');

CREATE INDEX email_outbox_org_created_idx
  ON email_outbox(organization_id, created_at DESC);

CREATE TRIGGER trg_email_outbox_updated_at
  BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- scheduled_jobs
-- --------------------------------------------------------------------------
CREATE TABLE scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = app-global job (runs once for the whole deployment).
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  -- Handler key. Must match a defineJob(kind, ...) registration.
  kind TEXT NOT NULL,
  -- Standard 5-field cron ("0 9 * * 1" = Mondays 09:00 in `timezone`).
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- Handler-defined settings (recipient filters, copy, thresholds...).
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IN ('ok', 'failed')),
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX scheduled_jobs_due_idx
  ON scheduled_jobs(next_run_at)
  WHERE enabled;

CREATE INDEX scheduled_jobs_org_idx
  ON scheduled_jobs(organization_id);

CREATE TRIGGER trg_scheduled_jobs_updated_at
  BEFORE UPDATE ON scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- job_history gains an index for "recent runs of this job" lookups. The
-- table itself (001) already has the columns a run record needs.
CREATE INDEX IF NOT EXISTS job_history_type_created_idx
  ON job_history(job_type, created_at DESC);
