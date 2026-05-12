-- Migration: 002_set_statement_timeout (NO-OP since 2026-05-12)
--
-- The role-level GUC defaults (statement_timeout,
-- idle_in_transaction_session_timeout, lock_timeout) are now set by
-- the alchemist-ai platform's customer-db-provisioning service at
-- the time the customer's DB user is created. That path runs as the
-- platform admin (which owns the customer role), so it works
-- regardless of the customer's `ALTER ROLE CURRENT_USER` permissions
-- — a path that empirically failed for at least one customer's role
-- and broke their pod boot for 42+h before the platform-side fix
-- landed.
--
-- This file stays as a placeholder so the migration sequence
-- (001 → 003) doesn't get a numbering hole, and so existing customer
-- repos whose `_migrations` table already records 002-applied don't
-- see an unexpected "missing migration" error. Customers shouldn't
-- remove or re-number this file.

SELECT 1 WHERE FALSE;  -- intentional no-op; the row never returns
