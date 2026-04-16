/**
 * Authentication Middleware
 *
 * Validates JWT session cookies and loads user + org into Hono context.
 */

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import * as jose from "jose";
import { db, withTimeout } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { UnauthorizedError } from "@/utils/errors.ts";

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
 * Create a signed JWT for a user session.
 */
export async function createSessionToken(user: {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}): Promise<string> {
  return await new jose.SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

/**
 * Verify a JWT and return the payload, or null on failure.
 */
async function verifyToken(token: string): Promise<jose.JWTPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Resolve user from JWT payload. Falls back to DB lookup if needed.
 */
async function resolveUser(payload: jose.JWTPayload): Promise<AuthUser | null> {
  const userId = payload.sub;
  if (!userId) return null;

  // Fast path: use JWT claims directly
  if (payload.email && payload.organizationId && payload.role) {
    return {
      id: userId,
      email: payload.email as string,
      name: (payload.name as string) ?? null,
      organizationId: payload.organizationId as string,
      role: payload.role as string,
    };
  }

  // Slow path: DB lookup
  try {
    const user = await withTimeout(3000, (trx) =>
      trx
        .selectFrom("app.users")
        .select(["id", "email", "name", "organizationId", "role"])
        .where("id", "=", userId)
        .executeTakeFirst()
    );
    if (!user || !user.organizationId) return null;
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
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    await next();
    return;
  }

  const payload = await verifyToken(token);
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
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    throw new UnauthorizedError("Authentication required");
  }

  const payload = await verifyToken(token);
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
