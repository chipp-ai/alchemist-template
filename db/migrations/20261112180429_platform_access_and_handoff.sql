-- Platform access mode and one-time sign-in handoff.
--
-- platform_member_sync_state gains the project's access setting, sent by
-- the Chipp platform with every member sync (POST /api/platform/member-sync).
-- access_mode NULL means no setting was ever sent: sign-in works as before.
-- When it is 'restricted', sign-in admits only the people
-- src/services/platform-access.service.ts allows.
--
-- platform_handoff_claims makes each Chipp sign-in handoff token single
-- use (POST /api/auth/platform-handoff): the jti insert wins once. No token
-- or email is stored.

ALTER TABLE platform_member_sync_state
  ADD COLUMN access_mode TEXT NULL
    CHECK (access_mode IN ('open', 'sign_in_required', 'restricted')),
  ADD COLUMN allowed_emails TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE platform_handoff_claims (
  jti TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_platform_handoff_claims_claimed_at ON platform_handoff_claims(claimed_at);
