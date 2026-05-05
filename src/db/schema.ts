/**
 * Kysely Database Type Definitions
 *
 * Maps the PostgreSQL schema to TypeScript types. The CamelCasePlugin in client.ts
 * maps snake_case DB columns to camelCase properties at runtime.
 *
 * This file covers the foundation tables. Add your own domain table interfaces
 * here and register them in the `Database` interface at the bottom.
 */

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

// ── Helpers ──

/** A timestamp column that is set automatically on INSERT and never updated. */
type CreatedAt = ColumnType<Date, Date | undefined, never>;

/** A timestamp column that is set automatically on INSERT and updated on UPDATE. */
type UpdatedAt = ColumnType<Date, Date | undefined, Date | undefined>;

// ── app schema ──

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string | null;
  subscriptionTier: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  creditsExhausted: Generated<boolean>;
  subscriptionCancelledAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  subscriptionEndsAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export type Organization = Selectable<OrganizationsTable>;
export type NewOrganization = Insertable<OrganizationsTable>;
export type OrganizationUpdate = Updateable<OrganizationsTable>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string | null;
  picture: string | null;
  role: string;
  organizationId: string | null;
  oauthProvider: string | null;
  oauthId: string | null;
  emailVerified: Generated<boolean>;
  lastLoginAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export interface OtpsTable {
  id: Generated<string>;
  email: string;
  otpCode: string;
  attempts: Generated<number>;
  expiresAt: Date;
  createdAt: CreatedAt;
}

export type Otp = Selectable<OtpsTable>;
export type NewOtp = Insertable<OtpsTable>;

export interface SessionsTable {
  id: Generated<string>;
  userId: string;
  token: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: CreatedAt;
}

export type Session = Selectable<SessionsTable>;
export type NewSession = Insertable<SessionsTable>;

export interface ApiCredentialsTable {
  id: Generated<string>;
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: string | null; // JSONB stored as string
  isActive: Generated<boolean>;
  lastUsedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdAt: CreatedAt;
}

export type ApiCredential = Selectable<ApiCredentialsTable>;
export type NewApiCredential = Insertable<ApiCredentialsTable>;

export interface InvitesTable {
  id: Generated<string>;
  organizationId: string;
  invitedBy: string;
  email: string;
  role: string;
  token: string;
  acceptedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  expiresAt: Date;
  createdAt: CreatedAt;
}

export type Invite = Selectable<InvitesTable>;
export type NewInvite = Insertable<InvitesTable>;

// ── billing schema ──

export interface TokenUsageTable {
  id: Generated<string>;
  organizationId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: Generated<number>;
  source: string | null;
  createdAt: CreatedAt;
}

export type TokenUsage = Selectable<TokenUsageTable>;
export type NewTokenUsage = Insertable<TokenUsageTable>;

// ── jobs schema ──

export interface JobHistoryTable {
  id: Generated<string>;
  jobType: string;
  organizationId: string | null;
  status: string;
  payload: string | null; // JSONB stored as string
  result: string | null; // JSONB stored as string
  error: string | null;
  startedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  completedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdAt: CreatedAt;
}

export type JobHistory = Selectable<JobHistoryTable>;
export type NewJobHistory = Insertable<JobHistoryTable>;

// ── Database interface ──
// Register your domain tables here.
//
// Tables are unqualified -- the customer's DB role has its `search_path` set
// to `<their_schema>, public`, so unqualified queries resolve into their own
// schema. See `db/migrations/001_initial_schema.sql` for the rationale.
// Local dev against a single Postgres also works (default search_path).

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  otps: OtpsTable;
  sessions: SessionsTable;
  api_credentials: ApiCredentialsTable;
  invites: InvitesTable;
  token_usage: TokenUsageTable;
  job_history: JobHistoryTable;
}
