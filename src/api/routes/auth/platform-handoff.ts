/**
 * POST /api/auth/platform-handoff
 *
 * One-time sign-in from Chipp: a platform member who opens the app from
 * Chipp arrives signed in, with no email code. Chipp's page auto-submits a
 * FORM POST, so the token is never in a URL, a log line or browser history.
 *
 *   Content-Type: application/x-www-form-urlencoded
 *   token=<jwt>&next=<optional relative path>
 *
 * Token: HS256 JWT, header typ "alch-handoff+jwt". The key is the UTF-8
 * bytes of the lowercase hex HMAC-SHA256(ALCH_MEMBER_SYNC_SECRET,
 * "member-handoff:v1"), so the sync secret itself never signs a session.
 * Claims: iss "chipp-alchemist", aud "alchemist-member-handoff",
 * sub = PROJECT_ID, email (lowercase), jti, iat, exp. exp - iat is at most
 * 120 s; the clock tolerance is 30 s.
 *
 * - 404 unless ALCH_MEMBER_SYNC_SECRET (32+ chars) and PROJECT_ID are set,
 *   the same rule as the member sync.
 * - Single use: the jti is claimed in platform_handoff_claims before any
 *   session exists. The unique key lets exactly one request win.
 * - Only a synced member signs in this way: a users row with
 *   managed_by 'platform' and an organization. Anyone else must sign in
 *   with an email code.
 * - Success: the same session cookie verify-otp sets, then 303 to `next`
 *   when it is a safe relative path, else the app home.
 * - Any failure: 303 to the login page with ?handoff=failed, which shows
 *   "That sign-in link expired or was already used."
 *
 * Logs carry a coarse reason slug only, never the token or the email.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import * as jose from "jose";
import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { appPath } from "@/config/site.ts";
import { createSessionToken } from "@/api/middleware/auth.ts";
// A cycle (index.ts mounts this router), safe because it is only used per request.
import { setSessionCookie } from "@/api/routes/auth/index.ts";
import { memberSyncConfig } from "@/api/routes/platform/member-sync.ts";
import { MANAGED_BY_PLATFORM } from "@/services/platform-member-sync.service.ts";
import { NotFoundError } from "@/utils/errors.ts";

export const HANDOFF_TYP = "alch-handoff+jwt";
export const HANDOFF_ISSUER = "chipp-alchemist";
export const HANDOFF_AUDIENCE = "alchemist-member-handoff";
export const HANDOFF_KEY_LABEL = "member-handoff:v1";
export const HANDOFF_MAX_LIFETIME_S = 120;
export const HANDOFF_CLOCK_TOLERANCE_S = 30;
const JTI_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The signing key: UTF-8 bytes of the lowercase hex HMAC of the label. */
export function handoffKey(syncSecret: string): Uint8Array {
  const hex = createHmac("sha256", new TextEncoder().encode(syncSecret))
    .update(HANDOFF_KEY_LABEL)
    .digest("hex");
  return new TextEncoder().encode(hex);
}

/** A same-origin relative path, or null. */
export function safeNextPath(next: string | undefined | null): string | null {
  if (!next) return null;
  const v = next.trim();
  if (v.length === 0 || v.length > 2000) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  // Backslashes and control characters: browsers fold "/\\evil.com" into a
  // protocol-relative URL. A scheme can never start with "/", but check
  // anyway for "/javascript:" style inputs after normalization.
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return null;
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  return v;
}

type Verified = { ok: true; email: string; jti: string } | { ok: false; reason: string };

export async function verifyHandoffToken(
  token: string,
  syncSecret: string,
  projectId: string,
  nowMs = Date.now(),
): Promise<Verified> {
  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, handoffKey(syncSecret), {
      algorithms: ["HS256"],
      issuer: HANDOFF_ISSUER,
      audience: HANDOFF_AUDIENCE,
      typ: HANDOFF_TYP,
      clockTolerance: HANDOFF_CLOCK_TOLERANCE_S,
      currentDate: new Date(nowMs),
      requiredClaims: ["iat", "exp", "jti", "sub"],
    });
    payload = result.payload;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    return { ok: false, reason: code === "ERR_JWT_EXPIRED" ? "expired" : "invalid" };
  }
  if (payload.sub !== projectId) return { ok: false, reason: "wrong_project" };
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    return { ok: false, reason: "invalid" };
  }
  if (payload.exp - payload.iat > HANDOFF_MAX_LIFETIME_S) return { ok: false, reason: "overlong" };
  if (payload.iat * 1000 > nowMs + HANDOFF_CLOCK_TOLERANCE_S * 1000) {
    return { ok: false, reason: "issued_in_future" };
  }
  const jti = payload.jti;
  if (typeof jti !== "string" || !JTI_PATTERN.test(jti)) return { ok: false, reason: "invalid" };
  const email = (payload as { email?: unknown }).email;
  if (typeof email !== "string" || email.length === 0 || email.length > 320) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, email: email.trim().toLowerCase(), jti };
}

const FAILED_PATH = "/#/login?handoff=failed";

function fail(c: Context, reason: string) {
  log.info("platform handoff refused", { source: "auth", feature: "platform-handoff", reason });
  c.header("Cache-Control", "no-store");
  return c.redirect(appPath(FAILED_PATH), 303);
}

export const platformHandoffRoutes = new Hono();

platformHandoffRoutes.post("/", async (c) => {
  const config = memberSyncConfig();
  if (!config) throw new NotFoundError("Route not found");

  let token = "";
  let next: string | null = null;
  try {
    const form = await c.req.parseBody();
    token = typeof form.token === "string" ? form.token.trim() : "";
    next = safeNextPath(typeof form.next === "string" ? form.next : null);
  } catch {
    return fail(c, "bad_body");
  }
  if (!token || token.length > 4096) return fail(c, "missing_token");

  const verified = await verifyHandoffToken(token, config.secret, config.projectId);
  if (!verified.ok) return fail(c, verified.reason);

  // Claim the jti FIRST. Exactly one request per token gets past this line.
  const claimed = await db
    .insertInto("platform_handoff_claims")
    .values({ jti: verified.jti })
    .onConflict((oc) => oc.column("jti").doNothing())
    .returning("jti")
    .executeTakeFirst();
  if (!claimed) return fail(c, "replayed");

  const user = await db
    .selectFrom("users")
    .select(["id", "email", "name", "role", "organizationId"])
    .where(sql<string>`lower(email)`, "=", verified.email)
    .where("managedBy", "=", MANAGED_BY_PLATFORM)
    .where("organizationId", "is not", null)
    .executeTakeFirst();
  if (!user || !user.organizationId) return fail(c, "not_a_member");

  await db.updateTable("users")
    .set({ emailVerified: true, lastLoginAt: new Date() })
    .where("id", "=", user.id)
    .execute();
  await db.updateTable("platform_handoff_claims")
    .set({ userId: user.id })
    .where("jti", "=", verified.jti)
    .execute();

  const session = await createSessionToken({
    id: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    role: user.role,
  });
  setSessionCookie(c, session);

  log.info("platform handoff signed in", {
    source: "auth",
    feature: "platform-handoff",
    userId: user.id,
  });
  c.header("Cache-Control", "no-store");
  return c.redirect(next ?? appPath("/#/"), 303);
});
