-- 20260706162249_credit_ledger.sql
-- Prepaid credits: the metered-monetization lane for API customers.
--
--   products.grants_credits  -- a product that grants credits when bought:
--                               one_time  = credit top-up pack (granted on
--                                           checkout completion)
--                               subscription = per-cycle allowance (granted
--                                           on every invoice.paid)
--   credit_balances          -- one row per org; the atomic spend gate.
--                               Debits are a single conditional UPDATE
--                               (balance >= cost), never read-modify-write.
--   credit_ledger_entries    -- append-only audit trail. `external_ref` is
--                               UNIQUE and makes webhook grants idempotent
--                               under Stripe's at-least-once delivery
--                               (cs:{session_id} / inv:{invoice_id}).
--
-- Routes spend credits via the chargeCredits() middleware (src/api/middleware/monetize.ts).

ALTER TABLE products
  ADD COLUMN grants_credits INTEGER CHECK (grants_credits > 0);

CREATE TABLE credit_balances (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE credit_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Positive = grant, negative = debit. Never zero.
  delta BIGINT NOT NULL CHECK (delta <> 0),
  reason VARCHAR(64) NOT NULL,
  -- Idempotency key for grants (nullable for debits/manual adjustments).
  external_ref VARCHAR(255) UNIQUE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_ledger_entries_org_created
  ON credit_ledger_entries(organization_id, created_at DESC);
