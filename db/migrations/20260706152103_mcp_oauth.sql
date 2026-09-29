-- 20260706152103_mcp_oauth.sql
-- OAuth 2.1 authorization server for the MCP endpoint at /api/mcp.
--
-- Remote MCP hosts (claude.ai custom connectors, ChatGPT, IDE clients) speak
-- OAuth 2.1 + PKCE + Dynamic Client Registration -- most have no field for a
-- static API key. These tables back the AS endpoints in
-- src/api/routes/mcp/oauth.ts:
--
--   mcp_oauth_clients     RFC 7591 dynamically-registered public clients
--   mcp_oauth_auth_codes  single-use, PKCE-bound authorization codes (5 min)
--   mcp_oauth_tokens      access (1h) + refresh (30d, rotated) token pairs
--
-- Codes and tokens are stored ONLY as SHA-256 hex hashes; the raw value is
-- returned to the caller once. Tokens are USER-scoped: the org is resolved
-- live from users at lookup so it never goes stale.
--
-- API keys (the secondary auth method) reuse the existing api_credentials
-- table from 001_initial_schema.sql -- no new table needed.

CREATE TABLE mcp_oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  redirect_uris JSONB NOT NULL DEFAULT '[]',
  client_type VARCHAR(20) NOT NULL DEFAULT 'public',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_mcp_oauth_clients_updated_at
  BEFORE UPDATE ON mcp_oauth_clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE mcp_oauth_auth_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash VARCHAR(64) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id VARCHAR(64) NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]',
  code_challenge TEXT NOT NULL,
  code_challenge_method VARCHAR(10) NOT NULL DEFAULT 'S256',
  is_used BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mcp_oauth_auth_codes_expires_at ON mcp_oauth_auth_codes(expires_at);

CREATE TABLE mcp_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash VARCHAR(64) NOT NULL UNIQUE,
  refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id VARCHAR(64) NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]',
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  user_agent TEXT,
  ip_address VARCHAR(45),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mcp_oauth_tokens_user_id ON mcp_oauth_tokens(user_id);

CREATE TRIGGER trg_mcp_oauth_tokens_updated_at
  BEFORE UPDATE ON mcp_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
