-- test-schema.sql
-- Drops and recreates the full schema for CI/test environments.
-- Idempotent: safe to run repeatedly.

BEGIN;

-- Drop schemas (CASCADE removes all contained objects)
DROP SCHEMA IF EXISTS jobs CASCADE;
DROP SCHEMA IF EXISTS billing CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;

-- Drop the migrations tracking table (lives in public schema)
DROP TABLE IF EXISTS schema_migrations;

-- Now apply the full migration inline:

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
CREATE TYPE app.workspace_role AS ENUM ('OWNER', 'EDITOR', 'VIEWER');
CREATE TYPE jobs.job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- Trigger function
CREATE OR REPLACE FUNCTION app.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- app.organizations
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_slug ON app.organizations(slug);
CREATE INDEX idx_organizations_stripe_customer_id ON app.organizations(stripe_customer_id);
CREATE INDEX idx_organizations_created_at ON app.organizations(created_at DESC);

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON app.organizations
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at_column();

-- app.users
CREATE TABLE app.users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  picture TEXT,
  role app.user_role NOT NULL DEFAULT 'member',
  organization_id UUID REFERENCES app.organizations(id) ON DELETE CASCADE,
  oauth_provider VARCHAR(50),
  oauth_id VARCHAR(255),
  password_hash TEXT,
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

-- app.sessions
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

-- app.workspaces
CREATE TABLE app.workspaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  organization_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspaces_organization_id ON app.workspaces(organization_id);
CREATE INDEX idx_workspaces_created_at ON app.workspaces(created_at DESC);

CREATE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON app.workspaces
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at_column();

-- app.workspace_members
CREATE TABLE app.workspace_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  role app.workspace_role NOT NULL DEFAULT 'EDITOR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_workspace_id ON app.workspace_members(workspace_id);
CREATE INDEX idx_workspace_members_user_id ON app.workspace_members(user_id);

CREATE TRIGGER trg_workspace_members_updated_at
  BEFORE UPDATE ON app.workspace_members
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at_column();

-- app.applications
CREATE TABLE app.applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  organization_id UUID REFERENCES app.organizations(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES app.workspaces(id) ON DELETE SET NULL,
  system_prompt TEXT,
  model VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-5',
  brand_styles JSONB,
  capabilities JSONB,
  settings JSONB,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_applications_slug ON app.applications(slug);
CREATE INDEX idx_applications_organization_id ON app.applications(organization_id);
CREATE INDEX idx_applications_workspace_id ON app.applications(workspace_id);
CREATE INDEX idx_applications_created_at ON app.applications(created_at DESC);

CREATE TRIGGER trg_applications_updated_at
  BEFORE UPDATE ON app.applications
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at_column();

-- app.api_credentials
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

-- app.invites
CREATE TABLE app.invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES app.workspaces(id) ON DELETE SET NULL,
  invited_by UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role app.workspace_role NOT NULL DEFAULT 'EDITOR',
  token TEXT NOT NULL UNIQUE,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invites_organization_id ON app.invites(organization_id);
CREATE INDEX idx_invites_workspace_id ON app.invites(workspace_id);
CREATE INDEX idx_invites_email ON app.invites(email);
CREATE INDEX idx_invites_token ON app.invites(token);
CREATE INDEX idx_invites_expires_at ON app.invites(expires_at);

-- billing.token_usage
CREATE TABLE billing.token_usage (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES app.organizations(id) ON DELETE SET NULL,
  application_id UUID,
  model VARCHAR(100) NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  source VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_usage_organization_id ON billing.token_usage(organization_id);
CREATE INDEX idx_token_usage_application_id ON billing.token_usage(application_id);
CREATE INDEX idx_token_usage_created_at ON billing.token_usage(created_at DESC);
CREATE INDEX idx_token_usage_model ON billing.token_usage(model);

-- jobs.history
CREATE TABLE jobs.history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_type VARCHAR(100) NOT NULL,
  organization_id UUID,
  application_id UUID,
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

-- Record this as an applied migration so the runner won't re-apply it
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
