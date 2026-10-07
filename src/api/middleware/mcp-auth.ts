/**
 * Bearer auth for the MCP endpoint at /api/mcp.
 *
 * Two auth methods, routed by token prefix (OAuth is PRIMARY -- it's what
 * remote MCP hosts speak natively; API keys are the headless secondary):
 *
 *   mcp_at_...  OAuth 2.1 access token (src/services/mcp-oauth/)
 *   mcp_sk_...  API key (src/services/mcp-oauth/api-key.service.ts)
 *
 * Mode is controlled by MCP_AUTH_MODE:
 *   "public" (default) -- no auth; the starter's echo tool is harmless and
 *                         this preserves the out-of-the-box quickstart.
 *   "oauth"            -- Bearer token REQUIRED. 401 responses carry the
 *                         RFC 9728 WWW-Authenticate challenge pointing at
 *                         the Protected Resource Metadata URL, which is
 *                         step 1 of modern MCP OAuth discovery (claude.ai,
 *                         ChatGPT, Claude Code probe it on 401).
 *
 * Flip to "oauth" the moment the server exposes anything non-public. Paid
 * (MPP) tools work in BOTH modes -- payment is its own credential.
 *
 * IMPORTANT: the challenge's `resource_metadata` MUST point at the RFC 9728
 * PRM URL (/.well-known/oauth-protected-resource), NOT the RFC 8414 AS URL.
 */

import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { oauthTokenService } from "@/services/mcp-oauth/service.ts";
import { mcpApiKeyService } from "@/services/mcp-oauth/api-key.service.ts";
import { requestBaseUrl } from "@/api/routes/well-known.ts";
import { log } from "@/lib/logger.ts";
import { getEnv } from "@/lib/env.ts";

export type McpAuthMode = "public" | "oauth";

export function mcpAuthMode(): McpAuthMode {
  const raw = (getEnv("MCP_AUTH_MODE") ?? "public").toLowerCase();
  return raw === "oauth" ? "oauth" : "public";
}

/** Identity attached to authenticated MCP requests. */
export interface McpAuthContext {
  userId: string;
  organizationId: string | null;
  email: string;
  role: string;
  scopes: string[];
  method: "oauth" | "api_key";
}

function unauthorized(c: Context, message: string): Response {
  const base = requestBaseUrl(c);
  c.header(
    "WWW-Authenticate",
    `Bearer realm="MCP", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  );
  // JSON-RPC-shaped body so MCP clients render a sensible error.
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    },
    401,
  );
}

/**
 * Hono middleware for /api/mcp. In "public" mode it still RESOLVES a
 * presented token (so tools can personalize when a client sends one) but
 * never rejects. In "oauth" mode a valid token is required.
 */
export const mcpAuthMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const mode = mcpAuthMode();
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (!token) {
    if (mode === "public") return await next();
    return unauthorized(c, "Authentication required. Connect via OAuth or supply an API key.");
  }

  let resolved: McpAuthContext | null = null;
  try {
    if (token.startsWith("mcp_at_")) {
      const t = await oauthTokenService.lookupByAccessToken(token);
      if (t) {
        resolved = {
          userId: t.userId,
          organizationId: t.organizationId,
          email: t.email,
          role: t.role,
          scopes: t.scopes,
          method: "oauth",
        };
      }
    } else if (token.startsWith("mcp_sk_")) {
      const k = await mcpApiKeyService.verify(token);
      if (k) {
        resolved = {
          userId: k.userId,
          organizationId: k.organizationId,
          email: k.email,
          role: k.role,
          scopes: k.scopes,
          method: "api_key",
        };
      }
    }
  } catch (err) {
    // A transient DB failure must NOT masquerade as an invalid token --
    // 503 tells well-behaved clients to retry instead of re-consenting.
    log.warn("MCP auth lookup failed", { source: "mcp-auth" }, err as Error);
    return c.json(
      { jsonrpc: "2.0", error: { code: -32002, message: "Auth backend unavailable, retry" }, id: null },
      503,
    );
  }

  if (!resolved) {
    if (mode === "public") return await next();
    return unauthorized(c, "Invalid or expired credentials.");
  }

  c.set("mcpAuth", resolved);
  return await next();
});

/** Read the resolved MCP identity (null when unauthenticated in public mode). */
export function getMcpAuth(c: Context): McpAuthContext | null {
  return (c.get("mcpAuth") as McpAuthContext | undefined) ?? null;
}
