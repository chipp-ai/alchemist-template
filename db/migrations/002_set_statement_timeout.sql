-- Migration: 002_set_statement_timeout
-- Description: Set default statement timeout and connection limits for tenant safety.
-- Prevents runaway queries from exhausting the shared connection pool.

-- Default statement timeout: 10 seconds.
-- Long-running analytical queries should use explicit SET LOCAL statement_timeout
-- inside a transaction. Background jobs may increase this per-connection.
ALTER ROLE alchemist SET statement_timeout = '10s';

-- Idle-in-transaction timeout: kill connections left open in a transaction for >30s.
-- Prevents long-held row locks from blocking other tenants.
ALTER ROLE alchemist SET idle_in_transaction_session_timeout = '30s';

-- Lock timeout: fail fast rather than waiting indefinitely for a lock.
-- Prevents deadlock pileups during concurrent migrations or writes.
ALTER ROLE alchemist SET lock_timeout = '5s';
