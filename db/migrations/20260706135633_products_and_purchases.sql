-- 20260706135633_products_and_purchases.sql
-- Built-in Stripe monetization: sell one-time products and recurring
-- (monthly/yearly) subscription products without custom plumbing.
--
--   products   -- the app-global sales catalog. Defined by the app operator
--               (owner/admin) via Settings -> Billing or the API. Each row is
--               backed by a Stripe Product + Price that product.service.ts
--               creates automatically -- no dashboard clicking required.
--   purchases  -- org-scoped entitlement records. Written by the Stripe
--               webhook when a checkout completes; updated as subscriptions
--               renew/cancel and charges refund. `hasActiveEntitlement()`
--               reads these to gate features.
--
-- This is DISTINCT from the plan-tier subscription on organizations
-- (subscription_tier / STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY). Products
-- are what THIS app sells to its customers on top of (or instead of) tiers.

CREATE TYPE product_type AS ENUM ('one_time', 'subscription');
CREATE TYPE purchase_status AS ENUM ('active', 'past_due', 'canceled', 'refunded');

-- --------------------------------------------------------------------------
-- products
-- App-global catalog. No organization FK: the operator defines what the app
-- sells; every org sees the same active catalog.
-- --------------------------------------------------------------------------
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable code-level identifier ("premium_reports"). Feature gates check
  -- entitlements by this key, never by UUID, so seed data and code agree.
  product_key VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type product_type NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  -- 'month' | 'year'. Required for subscriptions, forbidden for one-time.
  billing_interval VARCHAR(5) CHECK (billing_interval IN ('month', 'year')),
  stripe_product_id VARCHAR(255),
  stripe_price_id VARCHAR(255),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT products_interval_matches_type CHECK (
    (type = 'subscription' AND billing_interval IS NOT NULL)
    OR (type = 'one_time' AND billing_interval IS NULL)
  )
);

CREATE INDEX idx_products_active ON products(active);

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- purchases
-- One row per completed checkout (one-time) or per product subscription.
-- The unique Stripe identifiers make webhook fulfillment idempotent under
-- Stripe's at-least-once delivery + out-of-order events.
-- --------------------------------------------------------------------------
CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- RESTRICT: archive products (active = false), never delete ones that sold.
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  purchased_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status purchase_status NOT NULL DEFAULT 'active',
  stripe_checkout_session_id VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255) UNIQUE,
  stripe_payment_intent_id VARCHAR(255),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  -- For subscription products: end of the current paid period. Entitlement
  -- checks treat a past period-end as lapsed even if a webhook was missed.
  current_period_end TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchases_organization_id ON purchases(organization_id);
CREATE INDEX idx_purchases_product_id ON purchases(product_id);
CREATE INDEX idx_purchases_stripe_payment_intent_id ON purchases(stripe_payment_intent_id);

CREATE TRIGGER trg_purchases_updated_at
  BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
