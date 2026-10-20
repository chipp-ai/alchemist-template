-- 20261020193253_chipp_payments_mirror.sql
-- Chipp Payments: a local mirror of sales Chipp settles for this app.
--
-- With Chipp Payments the app holds no Stripe key. Chipp makes the sale on
-- the org's Stripe Connect account, settles it from its own webhook, and
-- tells this app with a signed `entitlement.changed` event (POST
-- /api/events/inbox) or when the app pulls (/entitlements). This app keeps
-- reading its own `products` and `purchases` tables, so requirePurchase,
-- hasActiveEntitlement and billingStore work unchanged.
--
-- Additive only: every existing row stays 'stripe_direct'.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'stripe_direct',
  ADD COLUMN IF NOT EXISTS chipp_purchase_id UUID,
  ADD COLUMN IF NOT EXISTS chipp_seq BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_source_check') THEN
    ALTER TABLE purchases
      ADD CONSTRAINT purchases_source_check CHECK (source IN ('stripe_direct', 'chipp_payments'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS purchases_chipp_purchase_id_key
  ON purchases (chipp_purchase_id)
  WHERE chipp_purchase_id IS NOT NULL;
