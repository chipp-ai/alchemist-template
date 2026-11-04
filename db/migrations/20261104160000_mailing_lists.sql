-- Mailing lists: contacts, campaigns, and the suppression list.
--
-- The paved road for "send a newsletter", "email our list", "import our
-- subscribers from Kajabi/Mailchimp". See src/services/mailing/ and the
-- "Newsletters and bulk email" section of CLAUDE.md.
--
-- Why this exists (2026-11-04): an app built from this template imported a
-- 12,000-contact list exported from a previous platform and mailed all of it
-- the next day from the shared platform sender. One week: 6 spam complaints
-- and 1,044 hard bounces on an address every other app shares. Each table
-- below carries one of the safeguards that would have stopped it:
--
--   email_suppressions          an address that hard-bounced, complained, or
--                               unsubscribed is never mailed again by ordinary
--                               mail (the communications gate reads it).
--   email_contacts              who is on the list, HOW they got there
--                               (origin) and who attested to their consent.
--   email_campaigns             one newsletter send, with its warm-up state.
--   email_campaign_recipients   the snapshot of who a campaign goes to, which
--                               batch each one went out in, and what came back.
--
-- import_sessions.attestation stores the importer's statement about where a
-- list came from and that the people on it opted in.
--
-- Additive only.

-- --------------------------------------------------------------------------
-- email_suppressions
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased. The CHECK keeps a mixed-case write from creating a second,
  -- unmatched row for the same mailbox.
  email TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) <= 320),
  -- NULL = app-wide (hard bounces and complaints are a property of the
  -- address, whatever workspace sent to it). Set = this workspace only
  -- (an unsubscribe from one workspace's mail).
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL
    CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribed', 'manual')),
  -- Who told us: 'provider-feedback', 'one-click', 'admin', ...
  source TEXT CHECK (source IS NULL OR char_length(source) <= 64),
  detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (address, scope). COALESCE because NULL never equals NULL in
-- a plain unique index, and app-wide rows must not pile up.
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_email_scope
  ON email_suppressions (email, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TRIGGER trg_email_suppressions_updated_at
  BEFORE UPDATE ON email_suppressions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- email_contacts
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) <= 320),
  first_name TEXT CHECK (first_name IS NULL OR char_length(first_name) <= 200),
  last_name TEXT CHECK (last_name IS NULL OR char_length(last_name) <= 200),
  status TEXT NOT NULL DEFAULT 'subscribed'
    CHECK (status IN ('subscribed', 'unsubscribed', 'suppressed')),
  -- How the contact reached the list:
  --   signup  subscribed through this app (a form, a checkbox at sign-up)
  --   import  arrived in a spreadsheet import
  --   manual  typed in by an admin
  -- Anything but 'signup' starts COLD: its first campaign goes out in the
  -- warm-up ramp (src/services/mailing/campaign.service.ts).
  origin TEXT NOT NULL CHECK (origin IN ('signup', 'import', 'manual')),
  -- The importer's statement, copied onto every contact it created.
  consent_source TEXT CHECK (consent_source IS NULL OR char_length(consent_source) <= 64),
  consent_source_detail TEXT
    CHECK (consent_source_detail IS NULL OR char_length(consent_source_detail) <= 500),
  consent_collected_in_app BOOLEAN NOT NULL DEFAULT FALSE,
  consent_attested_at TIMESTAMPTZ,
  consent_attested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  import_session_id UUID REFERENCES import_sessions(id) ON DELETE SET NULL,
  -- First time a campaign was queued to this contact. NULL on a non-signup
  -- contact = still cold.
  first_sent_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  suppressed_at TIMESTAMPTZ,
  suppressed_reason TEXT
    CHECK (suppressed_reason IS NULL OR suppressed_reason IN ('hard_bounce', 'complaint', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Dedupe: one row per address per workspace.
  UNIQUE (organization_id, email)
);

CREATE INDEX IF NOT EXISTS email_contacts_org_status
  ON email_contacts (organization_id, status);
CREATE INDEX IF NOT EXISTS email_contacts_email
  ON email_contacts (email);

CREATE TRIGGER trg_email_contacts_updated_at
  BEFORE UPDATE ON email_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- email_campaigns
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  text_body TEXT NOT NULL,
  html_body TEXT,
  --   draft      being written
  --   scheduled  will start at scheduled_at
  --   sending    recipients are being released (warm-up batches included)
  --   paused     stopped by a person or by a warm-up threshold; see paused_reason
  --   sent       every recipient was queued or skipped
  --   cancelled  stopped for good
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  paused_reason TEXT CHECK (paused_reason IS NULL OR char_length(paused_reason) <= 2000),
  -- Warm-up: which batch size comes next, when it may go, and the start of
  -- the window the bounce/complaint rates are measured over (reset by a
  -- resume, so a person who cleaned the list is judged on what follows).
  warmup_step INTEGER NOT NULL DEFAULT 0,
  next_cold_batch_at TIMESTAMPTZ,
  health_window_start TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_campaigns_org_created
  ON email_campaigns (organization_id, created_at DESC);
-- The runner's scan: only the two live states.
CREATE INDEX IF NOT EXISTS email_campaigns_live
  ON email_campaigns (status) WHERE status IN ('scheduled', 'sending');

CREATE TRIGGER trg_email_campaigns_updated_at
  BEFORE UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- email_campaign_recipients
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES email_contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  -- Snapshot at start: a non-signup contact never mailed before.
  cold BOOLEAN NOT NULL DEFAULT FALSE,
  --   pending     not released yet
  --   queued      in email_outbox (outbox_id)
  --   skipped     never sent; skip_reason says why
  --   bounced     provider reported a hard bounce for this send
  --   complained  provider reported a spam complaint for this send
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'skipped', 'bounced', 'complained')),
  skip_reason TEXT CHECK (skip_reason IS NULL OR char_length(skip_reason) <= 500),
  batch INTEGER,
  outbox_id UUID REFERENCES email_outbox(id) ON DELETE SET NULL,
  queued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS email_campaign_recipients_campaign_status
  ON email_campaign_recipients (campaign_id, status, cold);
-- Provider feedback arrives by address; it lands on that address's latest send.
CREATE INDEX IF NOT EXISTS email_campaign_recipients_email_queued
  ON email_campaign_recipients (email, queued_at DESC);

-- --------------------------------------------------------------------------
-- import_sessions.attestation
-- --------------------------------------------------------------------------
-- { listSource, listSourceDetail, collectedInApp, optedIn, attestedBy,
--   attestedAt } for a definition that requires one (the contacts import).
ALTER TABLE import_sessions
  ADD COLUMN IF NOT EXISTS attestation JSONB
    CHECK (attestation IS NULL OR jsonb_typeof(attestation) = 'object');
