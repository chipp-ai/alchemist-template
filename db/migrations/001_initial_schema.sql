-- 001_initial_schema.sql
-- Foundation for a multi-tenant SaaS: orgs, users, sessions, billing, jobs.
--
-- This is intentionally minimal. Add your own domain tables in new migrations.

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Schemas
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS jobs;

-- Enums
CREATE TYPE app.subscription_tier AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');
CREATE TYPE app.user_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE jobs.job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- --------------------------------------------------------------------------
-- Trigger function: auto-update updated_at on row modification
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------
-- app.organizations
-- The top-level tenant unit. Each customer/team gets one organization.
-- This is your billing entity for multi-tenant SaaS.
-- --------------------------------------------------------------------------
CREATE TABLE app.organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE,
  subscription_tier app.subscription_tier NOT NULL DEFAULT 'FREE',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  credits_exhausted BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_cancelled_at TIMESTAMPTZ,
  subscription_ends_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_slug ON app.organizations(slug);
CREATE INDEX idx_organizations_stripe_customer_id ON app.organizations(stripe_customer_id);
CREATE INDEX idx_organizations_created_at ON app.organizations(created_at DESC);

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON app.organizations
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at_column();

-- --------------------------------------------------------------------------
-- app.users
-- Members of an organization. One user belongs to exactly one organization.
-- --------------------------------------------------------------------------
CREATE TABLE app.users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  picture TEXT,
  role app.user_role NOT NULL DEFAULT 'member',
  organization_id UUID REFERENCES app.organizations(id) ON DELETE CASCADE,
  oauth_provider VARCHAR(50),
  oauth_id VARCHAR(255),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON app.users(email);
CREATE INDEX idx_users_organization_id ON app.users(organization_id);
CREATE INDEX idx_users_oauth_provider_id ON app.users(oauth_provider, oauth_id);
CREATE INDEX idx_users_created_at ON app.users(created_at DESC);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at_column();

-- --------------------------------------------------------------------------
-- app.otps
-- One-time passcodes for email-based authentication.
-- --------------------------------------------------------------------------
CREATE TABLE app.otps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL,
  otp_code VARCHAR(6) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otps_email ON app.otps(email);
CREATE INDEX idx_otps_expires_at ON app.otps(expires_at);

-- --------------------------------------------------------------------------
-- app.sessions
-- Server-side session records (used alongside JWT cookies for revocation).
-- --------------------------------------------------------------------------
CREATE TABLE app.sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id ON app.sessions(user_id);
CREATE INDEX idx_sessions_token ON app.sessions(token);
CREATE INDEX idx_sessions_expires_at ON app.sessions(expires_at);

-- --------------------------------------------------------------------------
-- app.invites
-- Pending org membership invitations.
-- --------------------------------------------------------------------------
CREATE TABLE app.invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role app.user_role NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invites_organization_id ON app.invites(organization_id);
CREATE INDEX idx_invites_email ON app.invites(email);
CREATE INDEX idx_invites_token ON app.invites(token);
CREATE INDEX idx_invites_expires_at ON app.invites(expires_at);

-- --------------------------------------------------------------------------
-- app.api_credentials
-- Per-user API keys for programmatic access.
-- --------------------------------------------------------------------------
CREATE TABLE app.api_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_credentials_user_id ON app.api_credentials(user_id);
CREATE INDEX idx_api_credentials_key_hash ON app.api_credentials(key_hash);
CREATE INDEX idx_api_credentials_key_prefix ON app.api_credentials(key_prefix);

-- --------------------------------------------------------------------------
-- billing.token_usage
-- AI/LLM usage tracking for cost attribution. Extend via migration with
-- your own resource references (e.g., resource_id VARCHAR(255)).
-- --------------------------------------------------------------------------
CREATE TABLE billing.token_usage (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES app.organizations(id) ON DELETE SET NULL,
  model VARCHAR(100) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_usage_organization_id ON billing.token_usage(organization_id);
CREATE INDEX idx_token_usage_created_at ON billing.token_usage(created_at DESC);
CREATE INDEX idx_token_usage_model ON billing.token_usage(model);

-- --------------------------------------------------------------------------
-- jobs.history
-- Generic background job audit log.
-- --------------------------------------------------------------------------
CREATE TABLE jobs.history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_type VARCHAR(100) NOT NULL,
  organization_id UUID,
  status jobs.job_status NOT NULL DEFAULT 'pending',
  payload JSONB,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_history_job_type ON jobs.history(job_type);
CREATE INDEX idx_jobs_history_organization_id ON jobs.history(organization_id);
CREATE INDEX idx_jobs_history_status ON jobs.history(status);
CREATE INDEX idx_jobs_history_created_at ON jobs.history(created_at DESC);
