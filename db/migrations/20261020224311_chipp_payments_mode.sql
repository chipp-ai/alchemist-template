-- 20261020224311_chipp_payments_mode.sql
-- Chipp Payments: record the mode Chipp sold in on each mirrored sale.
--
-- 'test' or 'live'. Access counts only for the mode this app runs in now
-- (CHIPP_PAYMENTS_MODE, or 'live' when Chipp Payments is not set up), so a
-- sale paid with a test card can never unlock a live app.
--
-- Additive only.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS chipp_mode TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_chipp_mode_check') THEN
    ALTER TABLE purchases
      ADD CONSTRAINT purchases_chipp_mode_check CHECK (chipp_mode IS NULL OR chipp_mode IN ('test', 'live'));
  END IF;
END $$;
