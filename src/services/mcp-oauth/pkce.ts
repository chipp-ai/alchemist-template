/**
 * PKCE (RFC 7636) + token/code generation for the MCP OAuth server.
 *
 * Only the S256 challenge method is accepted at /authorize (plain is rejected
 * upstream). Tokens are CSPRNG-random with a typed prefix; only their SHA-256
 * hex hash is ever persisted -- the raw value is returned to the caller once.
 *
 * Prefixes:
 *   mcp_at_  access token (1 hour)
 *   mcp_rt_  refresh token (30 days, rotated on every use)
 *   mcp_ac_  authorization code (5 minutes, single-use)
 *   mcpc_    OAuth client id
 *   mcp_sk_  API key (secondary auth method; see api-key.service.ts)
 */

import { createHash, randomBytes } from "node:crypto";

export type McpTokenType = "at" | "rt" | "ac" | "sk";

/** Generate a prefixed CSPRNG token (32 random bytes, base64url, no padding). */
export function generateMcpToken(type: McpTokenType): string {
  return `mcp_${type}_${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex of a raw token/code -- what we store and compare against. */
export function hashMcpToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Compute the S256 PKCE challenge for a verifier: base64url(SHA-256(verifier)). */
export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Generate a fresh `mcpc_<32 hex>` client_id for dynamic client registration. */
export function generateMcpClientId(): string {
  return `mcpc_${randomBytes(16).toString("hex")}`;
}
