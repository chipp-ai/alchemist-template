/**
 * MCP OAuth 2.1 authorization-server service layer.
 *
 * Three concerns, one module:
 *   - clientService     -- RFC 7591 Dynamic Client Registration + lookup
 *   - authCodeService   -- single-use, PKCE-bound authorization codes
 *   - oauthTokenService -- access/refresh token issue, refresh (rotation),
 *                          revoke, and the hot-path access-token lookup that
 *                          resolves to { userId, organizationId, scopes }.
 *
 * Tokens are USER-scoped: the organization is resolved LIVE from `users` at
 * lookup so it never goes stale if the user's org membership changes. Codes
 * and tokens are stored only as SHA-256 hex hashes.
 *
 * Modeled on the Alchemist platform's own MCP OAuth server (which is itself
 * modeled on chipp-deno's) -- the shape is battle-tested with claude.ai
 * custom connectors, ChatGPT, and Claude Code.
 */

import { db as baseDb } from "@/db/client.ts";
import type { McpOauthTables } from "@/db/mcp-oauth-tables.ts";
import { log } from "@/lib/logger.ts";
import {
  computeS256Challenge,
  generateMcpClientId,
  generateMcpToken,
  hashMcpToken,
} from "./pkce.ts";
import { ALL_MCP_SCOPES, normalizeMcpScopes } from "./permissions.ts";

const db = baseDb.withTables<McpOauthTables>();

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Client registration / lookup ───────────────────────────────────────────

export const clientService = {
  /** RFC 7591 dynamic client registration. Public client (no secret). */
  async register(params: {
    redirectUris: string[];
    clientName?: string | null;
    description?: string | null;
  }): Promise<{ clientId: string; issuedAtSeconds: number }> {
    const clientId = generateMcpClientId();
    await db
      .insertInto("mcp_oauth_clients")
      .values({
        clientId,
        name: params.clientName ?? clientId,
        description: params.description ?? null,
        redirectUris: params.redirectUris,
        clientType: "public",
      })
      .execute();

    log.info("MCP OAuth dynamic client registered", {
      source: "mcp-oauth",
      clientId,
    });

    return { clientId, issuedAtSeconds: Math.floor(Date.now() / 1000) };
  },

  /** Fetch an active client by its public client_id, or null. */
  async getActive(clientId: string) {
    if (!clientId) return null;
    const row = await db
      .selectFrom("mcp_oauth_clients")
      .where("clientId", "=", clientId)
      .where("isActive", "=", true)
      .selectAll()
      .executeTakeFirst();
    return row ?? null;
  },
};

// ── Authorization codes ─────────────────────────────────────────────────────

export const authCodeService = {
  /** Create a single-use authorization code; returns the raw code. */
  async create(params: {
    userId: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge: string;
    codeChallengeMethod: string;
  }): Promise<string> {
    const rawCode = generateMcpToken("ac");
    await db
      .insertInto("mcp_oauth_auth_codes")
      .values({
        codeHash: hashMcpToken(rawCode),
        userId: params.userId,
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        scopes: normalizeMcpScopes(params.scopes),
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: params.codeChallengeMethod,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      })
      .execute();
    return rawCode;
  },

  /**
   * Atomically consume a code (single-use). Returns the record if it was
   * valid + unused + unexpired, else null. FOR UPDATE closes the
   * double-redeem race under Stripe-style client retries.
   */
  async consume(rawCode: string): Promise<
    | {
      userId: string;
      clientId: string;
      redirectUri: string;
      scopes: string[];
      codeChallenge: string;
      codeChallengeMethod: string;
    }
    | null
  > {
    const codeHash = hashMcpToken(rawCode);
    return db.transaction().execute(async (trx) => {
      const code = await trx
        .selectFrom("mcp_oauth_auth_codes")
        .where("codeHash", "=", codeHash)
        .where("isUsed", "=", false)
        .where("expiresAt", ">", new Date())
        .selectAll()
        .forUpdate()
        .executeTakeFirst();
      if (!code) return null;

      await trx
        .updateTable("mcp_oauth_auth_codes")
        .set({ isUsed: true })
        .where("id", "=", code.id)
        .execute();

      return {
        userId: code.userId,
        clientId: code.clientId,
        redirectUri: code.redirectUri,
        scopes: normalizeMcpScopes(code.scopes),
        codeChallenge: code.codeChallenge,
        codeChallengeMethod: code.codeChallengeMethod,
      };
    });
  },

  /** Verify a PKCE code_verifier against a stored challenge. */
  verifyPkce(verifier: string, challenge: string, method: string): boolean {
    if (method === "S256") return computeS256Challenge(verifier) === challenge;
    if (method === "plain") return verifier === challenge;
    return false;
  },
};

// ── Tokens ──────────────────────────────────────────────────────────────────

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface ResolvedOauthToken {
  userId: string;
  organizationId: string | null;
  email: string;
  name: string | null;
  role: string;
  scopes: string[];
  tokenId: string;
}

export const oauthTokenService = {
  /** Issue a fresh access + refresh pair for a user. */
  async issueTokens(params: {
    userId: string;
    clientId: string;
    scopes: string[];
    userAgent?: string | null;
    ipAddress?: string | null;
  }): Promise<IssuedTokens> {
    const accessToken = generateMcpToken("at");
    const refreshToken = generateMcpToken("rt");
    const now = Date.now();
    const scopes = normalizeMcpScopes(params.scopes);

    await db
      .insertInto("mcp_oauth_tokens")
      .values({
        accessTokenHash: hashMcpToken(accessToken),
        refreshTokenHash: hashMcpToken(refreshToken),
        userId: params.userId,
        clientId: params.clientId,
        scopes,
        accessTokenExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
        refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
        userAgent: params.userAgent ?? null,
        ipAddress: params.ipAddress ?? null,
      })
      .execute();

    log.info("MCP OAuth tokens issued", {
      source: "mcp-oauth",
      userId: params.userId,
      clientId: params.clientId,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: scopes.join(" "),
    };
  },

  /**
   * Hot path: resolve a presented access token to its owner. Returns null if
   * the token is unknown, revoked, expired, or its user has been deleted.
   * Org is resolved live from `users` (single source of truth).
   */
  async lookupByAccessToken(rawToken: string): Promise<ResolvedOauthToken | null> {
    const row = await db
      .selectFrom("mcp_oauth_tokens as t")
      .innerJoin("users as u", "u.id", "t.userId")
      .where("t.accessTokenHash", "=", hashMcpToken(rawToken))
      .where("t.isRevoked", "=", false)
      .where("t.accessTokenExpiresAt", ">", new Date())
      .select([
        "t.id as tokenId",
        "t.userId as userId",
        "t.scopes as scopes",
        "u.organizationId as organizationId",
        "u.email as email",
        "u.name as name",
        "u.role as role",
      ])
      .executeTakeFirst();
    if (!row) return null;

    // Best-effort last-used stamp -- never blocks the request; a failure is
    // harmless (next call re-stamps). log.warn, never log.error.
    db.updateTable("mcp_oauth_tokens")
      .set({ lastUsedAt: new Date() })
      .where("id", "=", row.tokenId)
      .execute()
      .catch((e) => {
        log.warn("MCP OAuth token last-used stamp failed", {
          source: "mcp-oauth",
          tokenId: row.tokenId,
        }, e instanceof Error ? e : new Error(String(e)));
      });

    return {
      userId: row.userId,
      organizationId: row.organizationId,
      email: row.email,
      name: row.name,
      role: row.role,
      scopes: normalizeMcpScopes(row.scopes),
      tokenId: row.tokenId,
    };
  },

  /**
   * Refresh-token rotation: atomically revoke the presented pair and issue a
   * new one. Returns null if the refresh token is unknown/revoked/expired or
   * the client_id doesn't match.
   */
  async refreshTokens(rawRefreshToken: string, clientId: string): Promise<IssuedTokens | null> {
    const refreshTokenHash = hashMcpToken(rawRefreshToken);
    const rotated = await db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("mcp_oauth_tokens")
        .where("refreshTokenHash", "=", refreshTokenHash)
        .where("isRevoked", "=", false)
        .where("refreshTokenExpiresAt", ">", new Date())
        .selectAll()
        .forUpdate()
        .executeTakeFirst();
      if (!existing || existing.clientId !== clientId) return null;

      await trx
        .updateTable("mcp_oauth_tokens")
        .set({ isRevoked: true, updatedAt: new Date() })
        .where("id", "=", existing.id)
        .execute();

      return { userId: existing.userId, scopes: normalizeMcpScopes(existing.scopes) };
    });
    if (!rotated) return null;

    return this.issueTokens({
      userId: rotated.userId,
      clientId,
      scopes: rotated.scopes,
    });
  },

  /** RFC 7009 revoke by raw access OR refresh token. Always idempotent. */
  async revokeToken(rawToken: string): Promise<void> {
    const tokenHash = hashMcpToken(rawToken);
    const byAccess = await db
      .updateTable("mcp_oauth_tokens")
      .set({ isRevoked: true, updatedAt: new Date() })
      .where("accessTokenHash", "=", tokenHash)
      .executeTakeFirst();
    if (Number(byAccess.numUpdatedRows ?? 0) > 0) return;

    await db
      .updateTable("mcp_oauth_tokens")
      .set({ isRevoked: true, updatedAt: new Date() })
      .where("refreshTokenHash", "=", tokenHash)
      .execute();
  },
};

// ── Redirect-URI matching (exact, with localhost wildcard-port) ──────────────

/**
 * RFC 8252-style redirect matching: exact match, plus a `:*` wildcard port
 * for loopback so a native client on an ephemeral localhost port still
 * matches. Never unconditionally allows localhost -- only registered
 * patterns.
 */
export function isRedirectUriAllowed(uri: string, allowed: string[]): boolean {
  for (const a of allowed) {
    if (a === uri) return true;
    if (a.includes(":*")) {
      const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = escaped.replace(":\\*", ":\\d+");
      if (new RegExp(`^${pattern}$`).test(uri)) return true;
    }
  }
  return false;
}

/** Parse a JSONB string[] column that may arrive as an array or a JSON string. */
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw === "string") {
    try {
      return parseStringArray(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

export { ALL_MCP_SCOPES, normalizeMcpScopes };
