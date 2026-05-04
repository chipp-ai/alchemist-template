-- Migration: 002_set_statement_timeout
-- Description: Set default statement timeout and connection limits for tenant safety.
-- Prevents runaway queries from exhausting the shared connection pool.
--
-- Uses `CURRENT_USER` (a reserved keyword in ALTER ROLE) so each per-customer
-- DB user alters its OWN role configuration. Earlier revisions hardcoded
-- `ALTER ROLE alchemist` which was correct in chipp-deno (where `alchemist`
-- is the app's own DB user) but fails in alchemist-ai (where `alchemist` is
-- the platform user owned by the hosting infra and customers have no rights
-- to alter it). Tracked in chipp-deno task #100, fixed 2026-05-03.

-- Default statement timeout: 10 seconds.
-- Long-running analytical queries should use explicit SET LOCAL statement_timeout
-- inside a transaction. Background jobs may increase this per-connection.
ALTER ROLE CURRENT_USER SET statement_timeout = '10s';

-- Idle-in-transaction timeout: kill connections left open in a transaction for >30s.
-- Prevents long-held row locks from blocking other tenants.
ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '30s';

-- Lock timeout: fail fast rather than waiting indefinitely for a lock.
-- Prevents deadlock pileups during concurrent migrations or writes.
ALTER ROLE CURRENT_USER SET lock_timeout = '5s';
