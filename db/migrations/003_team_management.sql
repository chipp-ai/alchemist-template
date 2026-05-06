-- @no-transaction
-- 003_team_management.sql
-- Real team / member management: extends the existing `invites` table +
-- adds the 'editor' role + backfills 'member' → 'editor'.
--
-- Runs OUTSIDE the migrate runner's wrapping transaction (see the
-- @no-transaction marker above): `ALTER TYPE ... ADD VALUE` followed
-- by an UPDATE that USES that new value in the same transaction is a
-- PG 55P04 error ("unsafe use of new value of enum type"). Every
-- statement below is guarded with IF NOT EXISTS / WHERE clauses so a
-- partial failure + re-run resumes cleanly.
--
-- Why
--
-- v0.1 had the schema scaffolding (invites table + user_role enum) but no
-- working code. POST /org/invite was a stub that logged + returned 201
-- without persisting anything or sending email. DELETE /org/members/:userId
-- hard-deleted the user row, taking sessions, oauth bindings, and any
-- FK'd data with it. There was no token-based accept flow, no pending-
-- invite list, no role transitions.
--
-- The schema additions
--
--   1. Add 'editor' to the user_role enum. Going forward, write-capable
--      non-admin members are "editors". The existing 'member' value stays
--      in the enum (PostgreSQL ALTER TYPE doesn't support DROP VALUE
--      cleanly) but is treated as a synonym in code -- see
--      src/api/middleware/permissions.ts → ROLE_HIERARCHY.
--
--   2. Backfill any existing users whose role = 'member' to 'editor' so
--      fresh databases never have 'member' rows. Existing customer apps
--      that already shipped 'member' rows are migrated in place when this
--      migration runs against them.
--
--   3. Extend the existing `invites` table with `revoked_at` + `updated_at`,
--      a partial unique index for "one pending invite per (org, email)",
--      a token-lookup index, and an updated_at trigger.
--
-- Role hierarchy after this migration:
--
--   owner   1 per org   full control, cannot be invited (created at signup)
--   admin   N per org   manage team + org settings + everything editor can
--   editor  N per org   write app data, no team/org settings access
--   viewer  N per org   read-only

-- ── 1. Add 'editor' to user_role ────────────────────────────────────────────
-- ALTER TYPE ADD VALUE + same-transaction USE-of-the-new-value is
-- PG 55P04. The `-- @no-transaction` marker at the top of this file
-- tells the migrate runner to skip its wrapping transaction, so the
-- ALTER TYPE auto-commits before the UPDATE below uses 'editor'.
-- ADD VALUE IF NOT EXISTS keeps re-runs idempotent.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'editor';

-- ── 2. Backfill 'member' → 'editor' ─────────────────────────────────────────
-- Idempotent: the WHERE clause is a no-op on already-migrated rows.

UPDATE users SET role = 'editor' WHERE role = 'member';

-- ── 3. Extend invites table ─────────────────────────────────────────────────

-- revoked_at: nullable; admin-revoked invites get this set at revoke time.
-- Either accepted_at OR revoked_at can be set, never both. NULL on both =
-- pending and live (so long as expires_at hasn't passed).
ALTER TABLE invites ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- updated_at: trigger-managed.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- updated_at trigger. The trigger function is from migration 001.
DROP TRIGGER IF EXISTS invites_updated_at ON invites;
CREATE TRIGGER invites_updated_at
  BEFORE UPDATE ON invites
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- One pending invite per (organization_id, email). Partial index so an
-- email can be re-invited after a previous invite is accepted, expired,
-- or revoked. (PG won't enforce expires_at via a partial predicate
-- portably, so we let the application-layer collision check accept-or-
-- recreate logic handle expired pending invites.)
CREATE UNIQUE INDEX IF NOT EXISTS invites_pending_unique
  ON invites (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Hot path: token lookup on every /invite/:token page load. The token
-- column already has UNIQUE from migration 001, which created an index;
-- this is just an explicit confirmation for query planner clarity.
CREATE INDEX IF NOT EXISTS invites_token_lookup ON invites (token);

-- Listing pending invites for an org's settings page.
CREATE INDEX IF NOT EXISTS invites_org_pending
  ON invites (organization_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
