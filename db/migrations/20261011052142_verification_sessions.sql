-- 20261011052142_verification_sessions.sql
-- Audit log and replay guard for platform verification sessions.
--
-- `POST /api/auth/verification-session` trades a short-lived,
-- platform-signed token for a read-only session on a dedicated
-- verification account. Every accepted token writes one row here BEFORE a
-- session is minted. The UNIQUE jti makes each token single-use: a replayed
-- token loses the insert and is refused.
--
-- No secret is stored: the jti is a random nonce, and the session token
-- itself never touches the database.

CREATE TABLE verification_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jti TEXT NOT NULL UNIQUE,
  -- Platform ticket and run (graph node) the session was issued for.
  ticket_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  -- Set once the account is resolved; NULL means the mint failed after the
  -- jti was claimed (the token is still spent).
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'issued', 'failed')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX verification_sessions_created_idx ON verification_sessions(created_at DESC);
