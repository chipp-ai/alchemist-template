-- 20260706222822_inbound_email.sql
-- Inbound-email ingestion substrate: raw capture tables.
--
-- Capture-first pipeline: the Postmark inbound webhook
-- (POST /api/ingest/email) persists one inbound_email row + one
-- inbound_email_attachment row per file at status='received'. Extraction
-- (src/services/inbound-email/extract.service.ts) is a re-runnable
-- background projection on top of this immutable raw -- it only advances
-- status / status_reason / apply_result / processed_at and never mutates
-- the captured body, attachment rows, or stored objects.
--
-- organization_id is NULLABLE by design: capture must never drop an email
-- because tenant resolution (the INGEST_ORG_ID env var) is unset. Org-null
-- rows are invisible to the org-scoped dashboard API; set INGEST_ORG_ID in
-- production.
--
-- apply_result JSONB: the extraction profile's applyData() outcome
-- ({ applied, deferred, failed, summary }), persisted for audit alongside
-- the terminal status.
--
-- Unqualified table names: the customer DB role's search_path resolves them
-- into the customer's own schema (see 001_initial_schema.sql).
-- IDEMPOTENT: every DDL is IF NOT EXISTS. The UNIQUE index on
-- inbound_email(message_id) makes a Postmark re-delivery a no-op via
-- ON CONFLICT (message_id) DO NOTHING.

CREATE TABLE IF NOT EXISTS inbound_email (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE, -- resolved server-side from INGEST_ORG_ID; nullable
  message_id   TEXT NOT NULL,
  from_address TEXT,
  to_address   TEXT,            -- the inbound address it hit
  subject      TEXT,
  body_text    TEXT,            -- raw plain body, persisted verbatim
  body_html    TEXT,            -- raw html body
  headers      JSONB,           -- full header set, forensics
  raw_mime_key TEXT,            -- relative storage key of the full raw MIME (most-complete-form)
  attachment_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','extracted','human_message','unclear','failed')),
  status_reason TEXT,
  apply_result JSONB,           -- extraction profile applyData() outcome
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_email_message_id ON inbound_email(message_id);
CREATE INDEX IF NOT EXISTS idx_inbound_email_org_received
  ON inbound_email(organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_email_status_received
  ON inbound_email(status, received_at);

CREATE TABLE IF NOT EXISTS inbound_email_attachment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_email_id UUID NOT NULL REFERENCES inbound_email(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size_bytes   INT,
  sha256       TEXT,
  r2_key       TEXT NOT NULL,   -- RELATIVE storage key; '' when recorded-but-not-stored
  extracted_raw JSONB,          -- reserved for freeform per-attachment extraction output
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbound_email_attachment_email
  ON inbound_email_attachment(inbound_email_id);
