-- 20261031014951_chipp_donations.sql
-- Chipp Payments donations: a local mirror of the gifts Chipp settles.
--
-- A donor gives on the org's own Stripe account through Chipp (no Stripe
-- key and no webhook in this app) and needs no account here, so a gift is
-- keyed on Chipp's purchase id, not on an organization. Chipp tells the app
-- with a signed `entitlement.changed` event whose payload has
-- kind = 'donation' (POST /api/events/inbox), and the thank-you page
-- confirms the gift directly. Writes are ordered by Chipp's seq.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS chipp_donations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chipp_purchase_id UUID NOT NULL UNIQUE,
  product_key TEXT NOT NULL,
  donor_email TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  -- NULL for a one-time gift; month or year for a recurring one.
  billing_interval TEXT CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year')),
  status TEXT NOT NULL,
  current_period_end TIMESTAMPTZ,
  chipp_seq BIGINT NOT NULL,
  chipp_mode TEXT NOT NULL CHECK (chipp_mode IN ('test', 'live')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chipp_donations_created_at ON chipp_donations (created_at DESC);
