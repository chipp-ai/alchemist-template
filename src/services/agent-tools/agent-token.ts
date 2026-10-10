/**
 * Agent tokens: the credential the embedded Chipp agent uses to call this
 * app's tools (POST /api/agent-mcp) on behalf of ONE signed-in user.
 *
 * Flow: the embedded-agent session proxy (src/services/embedded-agent/
 * router.ts, rendered by the embedded-chipp-agent pack) mints an agent token
 * for the session user and hands it to Chipp with the chat session request.
 * The Chipp runtime sends it back as `Authorization: Bearer <token>` on every
 * tool call. The browser never needs it.
 *
 * Claims (shared contract with the Chipp side, do not change one side alone):
 *
 *   sub             user id
 *   organizationId  the user's org at mint time
 *   role            the user's role at mint time (informational: the
 *                   middleware re-reads the CURRENT role from the DB)
 *   scope           "agent"
 *   aud             "chipp-embed"
 *   aid             CHIPP_AGENT_APPLICATION_ID, only when that env is set
 *   jti, iat, exp   exp = iat + 15 minutes
 *
 * Scope segregation is enforced both ways. `verifyAgentToken` accepts only
 * scope "agent" + aud "chipp-embed", so a session cookie or a WS token is
 * refused here. The session verifier in src/api/middleware/auth.ts refuses
 * any token that carries a `scope` or an `aud`, so an agent token is never a
 * session.
 *
 * Fail closed: agent tokens are signed with JWT_SECRET and NEVER with the
 * "development-secret" fallback the session layer uses. With JWT_SECRET
 * unset, minting throws AgentTokenConfigError and verification refuses
 * every token.
 */

import * as jose from "jose";
import { getEnv } from "@/lib/env.ts";

export const AGENT_TOKEN_SCOPE = "agent";
export const AGENT_TOKEN_AUDIENCE = "chipp-embed";
export const AGENT_TOKEN_TTL_SECONDS = 15 * 60;

/** Clock skew we accept between this pod and the Chipp runtime. */
const CLOCK_TOLERANCE_SECONDS = 30;

export interface AgentTokenUser {
  id: string;
  organizationId: string;
  role: string;
}

export interface AgentTokenPayload extends jose.JWTPayload {
  sub: string;
  organizationId: string;
  role: string;
  scope: typeof AGENT_TOKEN_SCOPE;
  aud: typeof AGENT_TOKEN_AUDIENCE;
  aid?: string;
  jti: string;
  iat: number;
  exp: number;
}

/** JWT_SECRET is missing, so no agent token can be minted. */
export class AgentTokenConfigError extends Error {
  constructor() {
    super("JWT_SECRET is not set; agent tokens are disabled (no development fallback).");
    this.name = "AgentTokenConfigError";
  }
}

/** The signing key, or null when JWT_SECRET is unset. Read per call. */
function signingKey(): Uint8Array | null {
  const raw = getEnv("JWT_SECRET");
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

/** The Chipp agent application id this app is bound to, when known. */
function boundApplicationId(): string | undefined {
  const raw = getEnv("CHIPP_AGENT_APPLICATION_ID")?.trim();
  return raw ? raw : undefined;
}

/**
 * Mint a 15-minute agent token for `user`. Throws AgentTokenConfigError when
 * JWT_SECRET is unset.
 */
export async function mintAgentToken(user: AgentTokenUser): Promise<string> {
  const key = signingKey();
  if (!key) throw new AgentTokenConfigError();

  const claims: Record<string, unknown> = {
    organizationId: user.organizationId,
    role: user.role,
    scope: AGENT_TOKEN_SCOPE,
  };
  const aid = boundApplicationId();
  if (aid) claims.aid = aid;

  // One clock read, so exp - iat is exactly the TTL.
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setAudience(AGENT_TOKEN_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + AGENT_TOKEN_TTL_SECONDS)
    .sign(key);
}

/**
 * Verify an agent token. Returns the payload, or null for anything that is
 * not a live agent token signed by this app: wrong signature, expired,
 * wrong audience, wrong scope, missing claims, an `aid` that does not match
 * CHIPP_AGENT_APPLICATION_ID, or a lifetime longer than 15 minutes.
 */
export async function verifyAgentToken(token: string): Promise<AgentTokenPayload | null> {
  const key = signingKey();
  if (!key || !token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, key, {
      algorithms: ["HS256"],
      audience: AGENT_TOKEN_AUDIENCE,
      requiredClaims: ["sub", "iat", "exp", "jti"],
      maxTokenAge: `${AGENT_TOKEN_TTL_SECONDS}s`,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.scope !== AGENT_TOKEN_SCOPE) return null;
    if (typeof payload.organizationId !== "string" || !payload.organizationId) return null;
    if (typeof payload.role !== "string") return null;
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    // A token that claims to live longer than the contract allows was not
    // minted by mintAgentToken.
    if (payload.exp - payload.iat > AGENT_TOKEN_TTL_SECONDS) return null;

    const aid = boundApplicationId();
    if (aid && payload.aid !== aid) return null;

    return payload as AgentTokenPayload;
  } catch {
    return null;
  }
}
