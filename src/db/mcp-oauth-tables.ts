/**
 * Kysely types for the MCP OAuth authorization server tables
 * (db/migrations/20260706152103_mcp_oauth.sql).
 *
 * The base src/db/schema.ts does not declare these tables. The OAuth service
 * widens the shared client with them, which changes types only:
 *
 *   import { db as baseDb } from "@/db/client.ts";
 *   const db = baseDb.withTables<McpOauthTables>();
 */
import type { ColumnType, Generated } from "kysely";

type CreatedAt = ColumnType<Date, Date | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | undefined, Date | undefined>;

/** RFC 7591 dynamically-registered OAuth client (public, PKCE-only). */
export type McpOauthClientsTable = {
  id: Generated<string>;
  clientId: string;
  name: string;
  description: string | null;
  /** JSONB string[]. Pass an array on write; it may read back as an array or a JSON string. */
  redirectUris: unknown;
  clientType: Generated<string>;
  isActive: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
};

/** Single-use, PKCE-bound authorization code (5-minute TTL). */
export type McpOauthAuthCodesTable = {
  id: Generated<string>;
  codeHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  /** JSONB string[]. */
  scopes: unknown;
  codeChallenge: string;
  codeChallengeMethod: Generated<string>;
  isUsed: Generated<boolean>;
  expiresAt: Date;
  createdAt: CreatedAt;
};

/** Access (1h) + refresh (30d, rotated) token pair. Hashes only. */
export type McpOauthTokensTable = {
  id: Generated<string>;
  accessTokenHash: string;
  refreshTokenHash: string;
  userId: string;
  clientId: string;
  /** JSONB string[]. */
  scopes: unknown;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  isRevoked: Generated<boolean>;
  userAgent: string | null;
  ipAddress: string | null;
  lastUsedAt: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
};

export type McpOauthTables = {
  mcp_oauth_clients: McpOauthClientsTable;
  mcp_oauth_auth_codes: McpOauthAuthCodesTable;
  mcp_oauth_tokens: McpOauthTokensTable;
};
