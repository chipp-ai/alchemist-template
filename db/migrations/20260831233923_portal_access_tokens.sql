-- Portal access tokens -- the end-user lane.
--
-- Two audiences, two doors. ADMINS arrive through the existing invite
-- flow: invite-only, role-bearing, seat-consuming. END USERS (an employee
-- checking their own certifications, a client watching one project) must
-- never touch that flow. They get a long-lived tokenized link, bound to
-- one record and one address, that signs them into a read-only portal.
--
-- One row per issued link. See src/services/portal-access.service.ts.
--
-- token_hash, not the token
--
--   These links live in inboxes for months, which is a longer exposure
--   than the 7-day invite token this table sits beside. We store only a
--   SHA-256 of the secret, so a database read cannot mint a session. The
--   cost is that a re-send cannot resurrect the same URL: re-sending
--   ISSUES A FRESH TOKEN and revokes the old one. That is the safer
--   default anyway, since it retires a link that may have been forwarded.
--
-- subject_type / subject_id
--
--   The record this portal is a window onto ('employee', 'project',
--   'claim', ...). TEXT rather than a typed FK, because the template does
--   not know the customer's tables. Adapt it to a real FK when you know
--   yours.
--
-- user_id
--
--   The auto-provisioned viewer account the link signs in as. Minting
--   find-or-creates by email and NEVER downgrades an existing account:
--   an admin who also holds a portal link keeps their admin role.
--
-- ON DELETE CASCADE from both parents keeps the existing org-cleanup
-- path (and the test helper's org cascade) working unchanged.

CREATE TABLE portal_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  -- NULL = never expires. A portal link is meant to outlive a season.
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claim path: a single indexed lookup on the hash. UNIQUE above already
-- provides the index.

-- Admin list, newest first, org-scoped. Every read of this table is
-- org-scoped; the index matches.
CREATE INDEX idx_portal_access_tokens_org
  ON portal_access_tokens (organization_id, created_at DESC);

-- "Which link is live for this record" -- the lookup a re-issue does
-- before revoking the previous one.
CREATE INDEX idx_portal_access_tokens_subject
  ON portal_access_tokens (organization_id, subject_type, subject_id)
  WHERE revoked_at IS NULL;

-- "What can this signed-in portal user see" -- the /api/portal/me read.
CREATE INDEX idx_portal_access_tokens_user
  ON portal_access_tokens (user_id)
  WHERE revoked_at IS NULL;

-- Same updated_at trigger every other table in this schema uses
-- (defined in 001_initial_schema.sql).
CREATE TRIGGER trg_portal_access_tokens_updated_at
  BEFORE UPDATE ON portal_access_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
