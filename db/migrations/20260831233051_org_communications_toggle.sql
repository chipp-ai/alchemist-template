-- Org-level master switch for outbound communications.
--
-- Pairs with the PER-USER switch that already exists in
-- `users.preferences` (005_user_preferences.sql, key
-- `communicationsEnabled`). Both must be on for ordinary mail to go out;
-- see src/services/communications.service.ts.
--
-- A column, not a JSONB key, because this is a single stable boolean the
-- gate reads on every ordinary send. `credits_exhausted` on the same table
-- sets the precedent for a first-class org-level flag.
--
-- DEFAULT true is load-bearing: every existing org keeps receiving mail
-- after this migration, and a NOT NULL default keeps the gate's read
-- branch-free. Backward compatible with running code, which ignores the
-- column (expand/contract).
--
-- AUTH-CRITICAL MAIL IGNORES THIS FLAG. Sign-in codes, invite links, and
-- portal access links are sent regardless, because suppressing them locks
-- a person out of their account rather than quieting their inbox.

ALTER TABLE organizations
  ADD COLUMN communications_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN organizations.communications_enabled IS
  'Org master switch for ordinary outbound email. Auth-critical mail (OTP, invite, portal link) ignores it.';
