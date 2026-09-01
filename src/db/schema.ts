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
  /**
   * Org master switch for ORDINARY outbound email. Auth-critical mail
   * (OTP, invite, portal link) ignores it. Read by the communications
   * gate in src/services/communications.service.ts.
   */
  communicationsEnabled: Generated<boolean>;
  subscriptionCancelledAt: ColumnType<
    Date | null,
    Date | null | undefined,
    Date | null | undefined
  >;
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

/**
 * One issued portal access link: a long-lived, revocable, re-sendable
 * token that signs an END USER into the read-only portal for ONE record.
 * Admins never use this lane (they arrive by invite); end users never use
 * the invite lane. See src/services/portal-access.service.ts.
 *
 * `tokenHash` is a SHA-256 of the secret, never the secret. A re-send
 * therefore issues a fresh token and revokes the old one.
 */
export interface PortalAccessTokensTable {
  id: Generated<string>;
  organizationId: string;
  /** The auto-provisioned (or pre-existing) account the link signs in as. */
  userId: string;
  email: string;
  /** What kind of record this portal shows: 'employee', 'project', ... */
  subjectType: string;
  /** The record's id, as text -- the template does not know your PK type. */
  subjectId: string;
  tokenHash: string;
  /** NULL = never expires. */
  expiresAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  revokedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  lastSentAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  lastUsedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdBy: string | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export type PortalAccessToken = Selectable<PortalAccessTokensTable>;
export type NewPortalAccessToken = Insertable<PortalAccessTokensTable>;
export type PortalAccessTokenUpdate = Updateable<PortalAccessTokensTable>;

// ── uploaded files ──

export type UploadedFileStatus = "pending_review" | "approved" | "rejected";

/**
 * One row per end-user upload. See src/services/uploaded-file.service.ts
 * and db/migrations/20260901000537_uploaded_files.sql.
 *
 * `storageKey` is the RELATIVE key (no tenant prefix), which is what
 * storage.service.ts takes and returns.
 */
export interface UploadedFilesTable {
  id: Generated<string>;
  organizationId: string;
  /** NULL once the uploader's account is deleted. The file survives. */
  uploadedBy: string | null;
  /** The record this file belongs to, or NULL when it belongs to nothing. */
  subjectType: string | null;
  subjectId: string | null;
  storageKey: string;
  filename: string;
  contentType: string;
  /**
   * BIGINT. postgres.js hands a bigint back as a STRING, so the select
   * side is widened and the service coerces with Number() at the mapper.
   * Reading this field off a raw row without that coercion gives you a
   * string that compares wrong against a number.
   */
  sizeBytes: ColumnType<string | number, number, number>;
  status: Generated<UploadedFileStatus>;
  reviewReason: string | null;
  reviewedBy: string | null;
  reviewedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export type UploadedFileRow = Selectable<UploadedFilesTable>;
export type NewUploadedFile = Insertable<UploadedFilesTable>;
export type UploadedFileUpdate = Updateable<UploadedFilesTable>;

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

// ── inbound email (capture-first ingestion substrate) ──

/**
 * Terminal-status machine for a captured inbound email.
 *   received      — captured, not yet extracted (the only non-terminal state)
 *   extracted     — domain data extracted + applied via the registered profile
 *   human_message — a person wrote to the inbox; no domain data to apply
 *   unclear       — looked like data but nothing reliable could be extracted
 *   failed        — extraction/apply threw; re-pickable by the reaper
 */
export type InboundEmailStatus =
  | "received"
  | "extracted"
  | "human_message"
  | "unclear"
  | "failed";

/**
 * One captured inbound email (Postmark webhook -> durable raw). The raw is
 * IMMUTABLE after capture; extraction only advances status/status_reason/
 * apply_result/processed_at. `organization_id` is nullable by design
 * (capture proceeds when INGEST_ORG_ID is unset), and org-null rows are
 * invisible to the org-scoped dashboard API.
 */
export interface InboundEmailTable {
  id: Generated<string>;
  organizationId: string | null;
  messageId: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** JSONB — the full Postmark header array, kept for forensics. */
  headers: unknown | null;
  /** RELATIVE storage key of the raw MIME blob (null when not stored). */
  rawMimeKey: string | null;
  attachmentCount: Generated<number>;
  status: Generated<InboundEmailStatus>;
  statusReason: string | null;
  /** JSONB — the extraction profile's applyData() outcome. */
  applyResult: unknown | null;
  receivedAt: Generated<Date>;
  processedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
}

export type InboundEmail = Selectable<InboundEmailTable>;
export type NewInboundEmail = Insertable<InboundEmailTable>;
export type InboundEmailUpdate = Updateable<InboundEmailTable>;

/**
 * One attachment on a captured inbound email. `r2_key` is the RELATIVE
 * storage key (storage.service.ts prepends the tenant prefix); the empty
 * string is the recorded-but-not-stored sentinel (disallowed type,
 * oversized, or storage unconfigured) — such attachments are never
 * silently dropped, just not retrievable.
 */
export interface InboundEmailAttachmentTable {
  id: Generated<string>;
  inboundEmailId: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  r2Key: string;
  /** JSONB — reserved for freeform per-attachment extraction output. */
  extractedRaw: unknown | null;
  createdAt: CreatedAt;
}

export type InboundEmailAttachment = Selectable<InboundEmailAttachmentTable>;
export type NewInboundEmailAttachment = Insertable<InboundEmailAttachmentTable>;
export type InboundEmailAttachmentUpdate = Updateable<InboundEmailAttachmentTable>;

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  otps: OtpsTable;
  sessions: SessionsTable;
  api_credentials: ApiCredentialsTable;
  invites: InvitesTable;
  portal_access_tokens: PortalAccessTokensTable;
  uploaded_files: UploadedFilesTable;
  token_usage: TokenUsageTable;
  job_history: JobHistoryTable;
  doc_search_index: DocSearchIndexTable;
  inbound_email: InboundEmailTable;
  inbound_email_attachment: InboundEmailAttachmentTable;
  products: ProductsTable;
  purchases: PurchasesTable;
}
