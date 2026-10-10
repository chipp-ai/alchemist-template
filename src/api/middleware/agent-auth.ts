/**
 * requireAgentAuth: the auth gate for POST /api/agent-mcp.
 *
 * Accepts ONLY `Authorization: Bearer <agentToken>` (see
 * src/services/agent-tools/agent-token.ts). Session cookies are never read
 * here, and a session JWT or a WS token in the Authorization header fails
 * verifyAgentToken, so neither can call agent tools.
 *
 * After the token verifies, the user is re-read through the SAME
 * `resolveUser` the session middleware uses. That gives agent calls the
 * current role and org (a demotion applies at once), drops soft-disconnected
 * users, and honours POST /api/auth/logout-all (a token minted before the
 * cutoff is refused).
 *
 * The token's organizationId must still be the user's org. A user who moved
 * to another org since the token was minted gets a 401, never access to the
 * new org through an old token.
 */

import { createMiddleware } from "hono/factory";
import { type AuthUser, resolveUser } from "@/api/middleware/auth.ts";
import { verifyAgentToken } from "@/services/agent-tools/agent-token.ts";
import { UnauthorizedError } from "@/utils/errors.ts";

export interface AgentAuthVariables {
  user: AuthUser;
  organizationId: string;
  agentTokenId: string;
}

/** The bearer token from the Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export const requireAgentAuth = createMiddleware<{ Variables: AgentAuthVariables }>(
  async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    if (!token) {
      c.header("WWW-Authenticate", 'Bearer realm="agent-mcp"');
      throw new UnauthorizedError("Agent token required");
    }

    const payload = await verifyAgentToken(token);
    if (!payload) {
      c.header("WWW-Authenticate", 'Bearer realm="agent-mcp", error="invalid_token"');
      throw new UnauthorizedError("Invalid or expired agent token");
    }

    const user = await resolveUser(payload);
    if (!user || user.organizationId !== payload.organizationId) {
      c.header("WWW-Authenticate", 'Bearer realm="agent-mcp", error="invalid_token"');
      throw new UnauthorizedError("Agent token is no longer valid for this user");
    }

    c.set("user", user);
    c.set("organizationId", user.organizationId);
    c.set("agentTokenId", payload.jti);
    await next();
  },
);
