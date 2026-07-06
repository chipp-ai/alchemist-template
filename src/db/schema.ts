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
  tokenInvalidatedBefore: ColumnType<
    Date | null,
    Date | null | undefined,
    Date | null | undefined
  >;
  /** JSONB blob of arbitrary user-scoped preferences (notifications, tz, locale, …). */
  preferences: Generated<Record<string, unknown>>;
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
  /** Set when an admin revokes a pending invite. NULL = not revoked. */
  revokedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  expiresAt: Date;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export type Invite = Selectable<InvitesTable>;
export type NewInvite = Insertable<InvitesTable>;
export type InviteUpdate = Updateable<InvitesTable>;

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

// ── monetization (products + purchases) ──

export type ProductType = "one_time" | "subscription";
export type BillingInterval = "month" | "year";
export type PurchaseStatus = "active" | "past_due" | "canceled" | "refunded";

/**
 * App-global sales catalog. Each row is backed by a Stripe Product +
 * Price created automatically by product.service.ts. Gate features on
 * `productKey` via hasActiveEntitlement(), never on the UUID.
 */
export interface ProductsTable {
  id: Generated<string>;
  productKey: string;
  name: string;
  description: string | null;
  type: ProductType;
  priceCents: number;
  currency: Generated<string>;
  billingInterval: BillingInterval | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
  active: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export type Product = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;
export type ProductUpdate = Updateable<ProductsTable>;

/**
 * Org-scoped entitlement records, written by the Stripe webhook. One row
 * per one-time checkout or per product subscription.
 */
export interface PurchasesTable {
  id: Generated<string>;
  organizationId: string;
  productId: string;
  purchasedBy: string | null;
  status: Generated<PurchaseStatus>;
  stripeCheckoutSessionId: string | null;
  stripeSubscriptionId: string | null;
  stripePaymentIntentId: string | null;
  amountCents: Generated<number>;
  currency: Generated<string>;
  currentPeriodEnd: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  canceledAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export type Purchase = Selectable<PurchasesTable>;
export type NewPurchase = Insertable<PurchasesTable>;
export type PurchaseUpdate = Updateable<PurchasesTable>;

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

/**
 * In-app docs search index. One row per heading-scoped chunk of a
 * registry page (src/services/docs/registry.ts). App-global (docs are
 * product docs, identical for every org) — no organization scope. The
 * embedding is a JSON-encoded float array stored as text; cosine is
 * computed in-process (the corpus is tiny). Maintained by the boot
 * reindexer (src/services/docs/reindex.ts).
 */
export interface DocSearchIndexTable {
  id: Generated<string>;
  slug: string;
  chunkSeq: number;
  heading: Generated<string>;
  content: string;
  contentHash: string;
  /** JSON-encoded number[] (the embedding vector). */
  embedding: string;
  embedModel: string;
  embeddedAt: Generated<Date>;
}

export type DocSearchIndexRow = Selectable<DocSearchIndexTable>;
export type NewDocSearchIndexRow = Insertable<DocSearchIndexTable>;
export type DocSearchIndexUpdate = Updateable<DocSearchIndexTable>;

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  otps: OtpsTable;
  sessions: SessionsTable;
  api_credentials: ApiCredentialsTable;
  invites: InvitesTable;
  token_usage: TokenUsageTable;
  job_history: JobHistoryTable;
  doc_search_index: DocSearchIndexTable;
  products: ProductsTable;
  purchases: PurchasesTable;
}
