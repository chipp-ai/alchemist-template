/**
 * POST /api/auth/verification-session
 *
 * Lets the Alchemist platform sign its post-deploy verifier in to this app.
 * The app's only login is an email code, which an automated verifier cannot
 * receive, so without this every signed-in check on the deployed app was
 * deferred.
 *
 * Contract (server to server; the platform host calls it, never a browser):
 *
 *   Authorization: Bearer <platform verification token>
 *   -> 200 { sessionToken, cookieName, expiresAt, readOnly: true,
 *            user: { id, email, role } }
 *
 * What it refuses (fail closed):
 *   - 404 unless BOTH ALCH_VERIFICATION_SESSION_SECRET and PROJECT_ID are
 *     set. The platform injects both on managed deploys; a local or
 *     self-hosted stack without them looks exactly like a stack without
 *     the route (CWE-306).
 *   - 401 for a missing, malformed, wrongly signed, expired, overlong,
 *     other-project, or write-capable token (CWE-287/639). See
 *     src/lib/verification-session-token.ts for every check.
 *   - 401 for a REPLAYED token: its jti is claimed in
 *     `verification_sessions` before any session is minted, and the UNIQUE
 *     constraint lets exactly one request win.
 *   - 403 for a role outside VERIFICATION_ROLES (never `owner`).
 *
 * It mints exactly one thing: a session JWT for a dedicated verification
 * account (src/lib/verification-accounts.ts) that lives minutes, carries
 * the `vrf` claim, and is READ-ONLY app-wide (`verificationReadOnlyGuard`
 * in src/api/middleware/auth.ts). It never signs in a real user, never
 * sets a cookie on this response, and never returns or logs a secret.
 */

import { Hono } from "hono";
import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { getEnv } from "@/lib/env.ts";
import { createVerificationSessionToken } from "@/api/middleware/auth.ts";
import { verifyVerificationToken } from "@/lib/verification-session-token.ts";
import { isVerificationRole, provisionVerificationAccount } from "@/lib/verification-accounts.ts";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/utils/errors.ts";

const SESSION_COOKIE = "session_id";

/** Both env values, or null when the route is disabled on this deploy. */
export function verificationSessionConfig(): { secret: string; projectId: string } | null {
  const secret = getEnv("ALCH_VERIFICATION_SESSION_SECRET")?.trim() ?? "";
  const projectId = getEnv("PROJECT_ID")?.trim() ?? "";
  // A short secret is a misconfiguration, never a real derived value
  // (the platform injects a 64-char hex HMAC). Treat it as absent.
  if (secret.length < 32 || !projectId) return null;
  return { secret, projectId };
}

const verificationSessionRoutes = new Hono();

verificationSessionRoutes.post("/", async (c) => {
  const config = verificationSessionConfig();
  if (!config) throw new NotFoundError("Route not found");

  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw new UnauthorizedError("Verification token required");

  const verified = await verifyVerificationToken(match[1], config.secret, config.projectId);
  if (!verified.ok) {
    log.warn("verification session refused", {
      source: "auth",
      feature: "verification-session",
      reason: verified.reason,
    });
    throw new UnauthorizedError(`Verification token rejected (${verified.reason})`);
  }
  const { claims } = verified;
  if (!isVerificationRole(claims.role)) {
    log.warn("verification session refused", {
      source: "auth",
      feature: "verification-session",
      reason: "role_not_allowed",
      role: claims.role,
      ticketId: claims.ticketId,
    });
    throw new ForbiddenError(`Role "${claims.role}" is not available for verification sessions`);
  }

  // Claim the jti FIRST. Exactly one request per token gets past this line.
  const claimed = await db
    .insertInto("verification_sessions")
    .values({
      jti: claims.jti,
      ticketId: claims.ticketId,
      runId: claims.runId,
      role: claims.role,
    })
    .onConflict((oc) => oc.column("jti").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!claimed) {
    log.warn("verification session refused", {
      source: "auth",
      feature: "verification-session",
      reason: "replayed",
      ticketId: claims.ticketId,
      runId: claims.runId,
    });
    throw new UnauthorizedError("Verification token rejected (replayed)");
  }

  let account;
  try {
    account = await provisionVerificationAccount(claims.role);
  } catch (err) {
    await db
      .updateTable("verification_sessions")
      .set({ status: "failed" })
      .where("id", "=", claimed.id)
      .execute()
      .catch((markErr) =>
        log.error("verification session: could not mark the audit row failed", {
          source: "auth",
          feature: "verification-session",
          auditId: claimed.id,
        }, markErr as Error)
      );
    log.error("verification session: account provisioning failed", {
      source: "auth",
      feature: "verification-session",
      ticketId: claims.ticketId,
      runId: claims.runId,
      role: claims.role,
    }, err as Error);
    throw err;
  }

  const expiresAt = new Date(Date.now() + claims.sessionTtlSeconds * 1000);
  const sessionToken = await createVerificationSessionToken(account, {
    ttlSeconds: claims.sessionTtlSeconds,
    jti: claims.jti,
  });

  await db
    .updateTable("verification_sessions")
    .set({ status: "issued", userId: account.id, expiresAt })
    .where("id", "=", claimed.id)
    .execute();

  log.info("verification session issued", {
    source: "auth",
    feature: "verification-session",
    auditId: claimed.id,
    ticketId: claims.ticketId,
    runId: claims.runId,
    role: account.role,
    userId: account.id,
    expiresAt: expiresAt.toISOString(),
  });

  c.header("Cache-Control", "no-store");
  return c.json({
    sessionToken,
    cookieName: SESSION_COOKIE,
    expiresAt: expiresAt.toISOString(),
    readOnly: true,
    user: { id: account.id, email: account.email, role: account.role },
  });
});

export { verificationSessionRoutes };
