-- 001_initial_schema.sql
-- Foundation for a multi-tenant SaaS: orgs, users, sessions, billing, jobs.
--
-- This is intentionally minimal. Add your own domain tables in new migrations.
--
-- ─── Schema strategy (alchemist-ai customer runtime) ──────────────────────
-- This template runs inside a per-customer Postgres SCHEMA in a shared DB,
-- not in its own database. The customer's DB role has its `search_path` set
-- to `<their_schema>, public`, so unqualified DDL (`CREATE TABLE foo`) lands
-- in their schema. We deliberately avoid:
--   - `CREATE EXTENSION ...` -- the customer role is NOSUPERUSER. Cloud SQL
--     pre-installs `uuid-ossp` + `pgcrypto` in `public`; the search_path's
--     `, public` segment routes unqualified `gen_random_uuid()` calls there.
--   - `CREATE SCHEMA app/billing/jobs` -- top-level schemas in a shared DB
--     would collide across customers (PG `IF NOT EXISTS` is a no-op when an
--     existing schema is owned by a different role, so customer-2's
--     `CREATE TABLE app.users` would fail with "permission denied"). Keeping
--     everything in the customer's own schema sidesteps the conflict.
--
-- Local development against a single Postgres database also works -- you'll
-- just get one un-prefixed copy of the schema in your default search_path.

-- Trigger function for auto-updating updated_at on row modification.
-- Defined unqualified so it lives in the caller's schema (per search_path).
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Enums
CREATE TYPE subscription_tier AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- --------------------------------------------------------------------------
-- organizations
-- The top-level tenant unit. Each customer/team gets one organization.
-- This is your billing entity for multi-tenant SaaS.
-- --------------------------------------------------------------------------
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE,
  subscription_tier subscription_tier NOT NULL DEFAULT 'FREE',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  credits_exhausted BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_cancelled_at TIMESTAMPTZ,
  subscription_ends_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_stripe_customer_id ON organizations(stripe_customer_id);
CREATE INDEX idx_organizations_created_at ON organizations(created_at DESC);

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- users
-- Members of an organization. One user belongs to exactly one organization.
-- --------------------------------------------------------------------------
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  picture TEXT,
  role user_role NOT NULL DEFAULT 'member',
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  oauth_provider VARCHAR(50),
  oauth_id VARCHAR(255),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_organization_id ON users(organization_id);
CREATE INDEX idx_users_oauth_provider_id ON users(oauth_provider, oauth_id);
CREATE INDEX idx_users_created_at ON users(created_at DESC);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------------
-- otps
-- One-time passcodes for email-based authentication.
-- --------------------------------------------------------------------------
CREATE TABLE otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  otp_code VARCHAR(6) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otps_email ON otps(email);
CREATE INDEX idx_otps_expires_at ON otps(expires_at);

-- --------------------------------------------------------------------------
-- sessions
-- Server-side session records (used alongside JWT cookies for revocation).
-- --------------------------------------------------------------------------
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- --------------------------------------------------------------------------
-- invites
-- Pending org membership invitations.
-- --------------------------------------------------------------------------
CREATE TABLE invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invites_organization_id ON invites(organization_id);
CREATE INDEX idx_invites_email ON invites(email);
CREATE INDEX idx_invites_token ON invites(token);
CREATE INDEX idx_invites_expires_at ON invites(expires_at);

-- --------------------------------------------------------------------------
-- api_credentials
-- Per-user API keys for programmatic access.
-- --------------------------------------------------------------------------
CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_credentials_user_id ON api_credentials(user_id);
CREATE INDEX idx_api_credentials_key_hash ON api_credentials(key_hash);
CREATE INDEX idx_api_credentials_key_prefix ON api_credentials(key_prefix);

-- --------------------------------------------------------------------------
-- token_usage
-- AI/LLM usage tracking for cost attribution. Extend via migration with
-- your own resource references (e.g., resource_id VARCHAR(255)).
-- --------------------------------------------------------------------------
CREATE TABLE token_usage (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  model VARCHAR(100) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_usage_organization_id ON token_usage(organization_id);
CREATE INDEX idx_token_usage_created_at ON token_usage(created_at DESC);
CREATE INDEX idx_token_usage_model ON token_usage(model);

-- --------------------------------------------------------------------------
-- job_history
-- Generic background job audit log. (Renamed from `jobs.history` to a single
-- unqualified table to avoid the multi-schema layout in shared-DB tenancy.)
-- --------------------------------------------------------------------------
CREATE TABLE job_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type VARCHAR(100) NOT NULL,
  organization_id UUID,
  status job_status NOT NULL DEFAULT 'pending',
  payload JSONB,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_history_job_type ON job_history(job_type);
CREATE INDEX idx_job_history_organization_id ON job_history(organization_id);
CREATE INDEX idx_job_history_status ON job_history(status);
CREATE INDEX idx_job_history_created_at ON job_history(created_at DESC);
