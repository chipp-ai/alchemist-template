/**
 * Authentication Middleware
 *
 * Validates JWT session cookies and loads user + org into Hono context.
 */

import { createMiddleware } from "hono/factory";
import * as jose from "jose";
import { db, withTimeout } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { ForbiddenError, UnauthorizedError } from "@/utils/errors.ts";
import { can, type Capability } from "@/lib/roles.ts";
import { getSessionDurationMs } from "@/utils/session-duration.ts";

// ── Types ──

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}

export interface AuthVariables {
  user: AuthUser;
  organizationId: string;
}

// ── JWT ──

const JWT_SECRET_RAW = Deno.env.get("JWT_SECRET") ?? "development-secret";
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW);
const SESSION_COOKIE = "session_id";

/**
 * Create a signed JWT for a user session. Expiry is resolved from
 * `HIPAA_ENABLED` — 4 hours for HIPAA pods, 30 days otherwise. See
 * `src/utils/session-duration.ts` for the policy. Callers don't have
 * to know the policy; just call this and the right TTL gets stamped
 * into the JWT's `exp` claim.
 */
export async function createSessionToken(user: {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}): Promise<string> {
  const ttlSec = Math.floor(getSessionDurationMs() / 1000);
  return await new jose.SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(JWT_SECRET);
}

/**
 * Create a short-lived JWT for a WebSocket handshake. Browsers can't
 * send the httpOnly session cookie on cross-origin WS connections, and
 * many WS clients can't attach Cookie headers at all — so we mint a
 * scope-limited token (`scope: "ws"`, 60s TTL) the client can pass in
 * the WS URL or Authorization header.
 *
 * The customer-side WS handler verifies via `verifyWsToken` and uses
 * the returned `sub`/`organizationId` to attribute the connection.
 * After the handshake the token is no longer needed (and shouldn't be
 * re-used — its TTL is intentionally short).
 */
export async function createWsToken(user: {
  id: string;
  organizationId: string;
}): Promise<string> {
  return await new jose.SignJWT({
    sub: user.id,
    organizationId: user.organizationId,
    scope: "ws",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(JWT_SECRET);
}

/**
 * Verify a WebSocket handshake token. Returns the payload only if the
 * token's scope is "ws"; session-cookie tokens (`scope` absent) are
 * rejected so the surface for an exfiltrated session token doesn't
 * include WS connections to other tenants.
 */
export async function verifyWsToken(token: string): Promise<jose.JWTPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET);
    if (payload.scope !== "ws") return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify a JWT and return the payload, or null on failure.
 */
async function verifyToken(token: string): Promise<jose.JWTPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET);
    // Reject WS-scoped tokens here — they should ONLY be used by
    // verifyWsToken. Session cookies must NOT carry scope:"ws".
    if (payload.scope === "ws") return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * ALL values for the session cookie in the request's Cookie header, in
 * header order.
 *
 * Why not `getCookie(c, SESSION_COOKIE)`: browsers can legitimately send
 * MULTIPLE cookies named `session_id` on one request. Customer apps are
 * hosted at `<slug>.on.chipp.ai` -- a subdomain of chipp.ai -- and the
 * Chipp builder dashboard sets ITS OWN `session_id` cookie with
 * `Domain=.chipp.ai`, which the browser attaches to every *.chipp.ai
 * host. A user who is also logged into the Chipp dashboard therefore
 * sends BOTH the foreign platform JWT (older, domain-wide, ordered
 * FIRST per RFC 6265 creation-time ordering) and this app's own JWT
 * (host-only, second). Hono's `getCookie()` keeps only the FIRST
 * occurrence -- the foreign token -- so verification fails on every
 * request and login loops forever even after a successful OTP
 * (Valor Victoria incident, 2026-07-08). Collect every candidate and
 * try each until one verifies; foreign tokens simply fail this app's
 * JWT_SECRET and are skipped.
 */
function getSessionTokenCandidates(
  c: { req: { header: (name: string) => string | undefined } },
): string[] {
  const raw = c.req.header("Cookie") ?? "";
  const candidates: string[] = [];
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    try {
      candidates.push(decodeURIComponent(value));
    } catch {
      // Malformed percent-encoding -- try the raw value (JWTs are
      // base64url and never need decoding anyway).
      candidates.push(value);
    }
  }
  return candidates;
}

/**
 * Verify each session-token candidate in header order and return the
 * first payload that passes. Only tokens signed with THIS app's secret
 * can verify, so there is no ambiguity risk.
 */
async function verifyFirstValidToken(
  candidates: string[],
): Promise<jose.JWTPayload | null> {
  for (const token of candidates) {
    const payload = await verifyToken(token);
    if (payload) return payload;
  }
  return null;
}

/**
 * Resolve user from JWT payload. Always checks `users.tokenInvalidatedBefore`
 * against the JWT's `iat` claim to enforce POST /auth/logout-all
 * server-side — without a check on every request, revocation can't
 * outpace the JWT's own 7-day TTL.
 */
async function resolveUser(payload: jose.JWTPayload): Promise<AuthUser | null> {
  const userId = payload.sub;
  if (!userId) return null;

  try {
    // Single indexed row read. We always need `tokenInvalidatedBefore`
    // to honor logout-all; the rest is cheap to bring along and lets
    // us keep the resolved AuthUser self-consistent with the DB
    // (e.g. if the user's role changed since the JWT was issued, the
    // server should respect the current role, not the stale one).
    const user = await withTimeout(3000, (trx) =>
      trx
        .selectFrom("users")
        .select([
          "id",
          "email",
          "name",
          "organizationId",
          "role",
          "tokenInvalidatedBefore",
        ])
        .where("id", "=", userId)
        .executeTakeFirst()
    );
    if (!user || !user.organizationId) return null;

    // logout-all enforcement: any JWT signed before the cutoff is
    // revoked. Compare in seconds (the JWT spec stores `iat` as
    // seconds since epoch).
    if (user.tokenInvalidatedBefore && typeof payload.iat === "number") {
      const cutoffSec = Math.floor(user.tokenInvalidatedBefore.getTime() / 1000);
      if (payload.iat < cutoffSec) return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      organizationId: user.organizationId,
      role: user.role,
    };
  } catch (err) {
    log.warn("DB user lookup failed during auth", { source: "auth" }, err);
    return null;
  }
}

/**
 * Auth middleware that populates c.get("user") and c.get("organizationId").
 * Does NOT throw on missing/invalid auth -- sets user to undefined.
 * Use `requireAuth` for routes that must be authenticated.
 */
export const authMiddleware = createMiddleware(async (c, next) => {
  const candidates = getSessionTokenCandidates(c);
  if (candidates.length === 0) {
    await next();
    return;
  }

  const payload = await verifyFirstValidToken(candidates);
  if (!payload) {
    await next();
    return;
  }

  const user = await resolveUser(payload);
  if (user) {
    c.set("user", user);
    c.set("organizationId", user.organizationId);
  }

  await next();
});

/**
 * Strict auth middleware. Throws 401 if not authenticated.
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const candidates = getSessionTokenCandidates(c);
  if (candidates.length === 0) {
    throw new UnauthorizedError("Authentication required");
  }

  const payload = await verifyFirstValidToken(candidates);
  if (!payload) {
    throw new UnauthorizedError("Invalid or expired session");
  }

  const user = await resolveUser(payload);
  if (!user) {
    throw new UnauthorizedError("User not found");
  }

  c.set("user", user);
  c.set("organizationId", user.organizationId);
  await next();
});

/**
 * Helper to get the authenticated user from context.
 * Throws if not authenticated (use after requireAuth).
 */
export function getUser(c: { get: (key: string) => unknown }): AuthUser {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) {
    throw new UnauthorizedError("Authentication required");
  }
  return user;
}

/**
 * Capability-gated middleware. Apply AFTER `requireAuth` on any route
 * that should only be reachable by users above the named capability's
 * minimum role.
 *
 * @example
 *   orgRoutes.post(
 *     "/invite",
 *     requireAuth,
 *     requireCapability("team.invite"),
 *     handler,
 *   );
 *
 * The capability set + role hierarchy lives in `src/lib/roles.ts` —
 * the SAME file the client-side store/UI mirrors. Add new
 * capabilities by extending the `Capability` union there, not here.
 *
 * Behavior:
 *   - Throws 401 (UnauthorizedError) if no user is in context (i.e.
 *     `requireAuth` wasn't applied first — defensive).
 *   - Throws 403 (ForbiddenError) if the user lacks the capability.
 *   - Otherwise calls next().
 *
 * The error message names the missing capability so client-side
 * error handlers can surface useful copy ("You need admin permission
 * to invite members") instead of a generic "Forbidden".
 */
export function requireCapability(cap: Capability) {
  return createMiddleware(async (c, next) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user) {
      throw new UnauthorizedError("Authentication required");
    }
    if (!can(user.role, cap)) {
      throw new ForbiddenError(
        `Your role (${user.role}) does not have the "${cap}" permission.`,
      );
    }
    await next();
  });
}
