/**
 * OAuth discovery metadata for the MCP authorization server.
 *
 *   RFC 8414 -- /.well-known/oauth-authorization-server   (authorization server)
 *   RFC 9728 -- /.well-known/oauth-protected-resource     (the /api/mcp resource)
 *
 * Remote MCP clients (claude.ai connectors, ChatGPT, Claude Code) probe the
 * root `.well-known` paths and/or the `resource_metadata` URL advertised in
 * the MCP endpoint's 401 `WWW-Authenticate` header. Both the bare paths and
 * the path-suffixed variants some clients derive from a resource URL with a
 * path (`/api/mcp`) are served; all return the same documents.
 *
 * ISSUER RULE (RFC 8414 section 2): the `issuer` MUST match the URL the
 * client fetched the document from. We derive it per-request from
 * X-Forwarded-Proto/X-Forwarded-Host (set by the platform edge) falling back
 * to the Host header, then APP_URL. A hardcoded internal origin here silently
 * breaks Claude Code's OAuth discovery.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { ALL_MCP_SCOPES } from "@/services/mcp-oauth/permissions.ts";
import { getEnv } from "@/lib/env.ts";

/** Public base URL as the CLIENT sees it, e.g. "https://myapp.example.com". */
export function requestBaseUrl(c: Context): string {
  const forwardedHost = c.req.header("x-forwarded-host");
  const host = forwardedHost ?? c.req.header("host");
  if (host) {
    const proto = c.req.header("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return getEnv("APP_URL") ?? "http://localhost:8000";
}

/** RFC 8414 authorization-server metadata. */
export function buildAuthServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    revocation_endpoint: `${base}/api/mcp/oauth/revoke`,
    scopes_supported: [...ALL_MCP_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

/** RFC 9728 protected-resource metadata for the /api/mcp resource. */
export function buildProtectedResourceMetadata(base: string) {
  return {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: [...ALL_MCP_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

const wellKnownRoutes = new Hono();

wellKnownRoutes.get(
  "/oauth-authorization-server",
  (c) => c.json(buildAuthServerMetadata(requestBaseUrl(c))),
);
wellKnownRoutes.get(
  "/oauth-authorization-server/api/mcp",
  (c) => c.json(buildAuthServerMetadata(requestBaseUrl(c))),
);
wellKnownRoutes.get(
  "/oauth-protected-resource",
  (c) => c.json(buildProtectedResourceMetadata(requestBaseUrl(c))),
);
wellKnownRoutes.get(
  "/oauth-protected-resource/api/mcp",
  (c) => c.json(buildProtectedResourceMetadata(requestBaseUrl(c))),
);

export { wellKnownRoutes };
