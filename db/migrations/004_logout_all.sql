-- 004_logout_all.sql
-- Adds a per-user "invalidate all sessions issued before this instant"
-- timestamp so POST /auth/logout-all can revoke every existing JWT in
-- one write.
--
-- Why
--
-- Sessions are stateless JWTs (cookie-only, no sessions row consulted
-- on each request). That's fast but means "log out of all devices"
-- can't simply DELETE rows — the JWT still verifies until expiry.
-- The fix: store a NULL-able cutoff timestamp on users; the auth
-- middleware compares the JWT's `iat` claim against the cutoff and
-- treats older tokens as revoked.
--
-- NULL = no cutoff = every signed JWT is acceptable until expiry.
-- The auth middleware short-circuits the comparison when the cutoff
-- is NULL, so unaffected users pay zero overhead beyond the indexed
-- lookup of the user row itself.

ALTER TABLE users ADD COLUMN token_invalidated_before TIMESTAMPTZ;
