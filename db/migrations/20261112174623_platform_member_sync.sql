-- 20261112174623_platform_member_sync.sql
-- Platform member sync (`POST /api/platform/member-sync`).
--
-- The Chipp platform keeps the people who hold a role on the Chipp project
-- in step with this app's users. Rows the sync creates carry
-- managed_by = 'platform'. Every other row (invited in the app, or signed
-- up by itself) keeps managed_by NULL, and the sync never touches it.
--
-- platform_member_sync_state holds one row: the highest `seq` the app has
-- applied. A delivery whose seq is not newer is a replay or an
-- out-of-order retry, and the route ignores it.

ALTER TABLE users ADD COLUMN managed_by TEXT NULL;
ALTER TABLE users
  ADD CONSTRAINT users_managed_by_check CHECK (managed_by IN ('platform'));

CREATE INDEX idx_users_managed_by ON users(managed_by) WHERE managed_by IS NOT NULL;

CREATE TABLE platform_member_sync_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_seq BIGINT NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
