/**
 * Auth Routes
 *
 * OTP login is always-on (works as long as SMTP is configured — and the
 * platform injects SMTP creds for free). OAuth providers (Google,
 * Microsoft, GitHub, …) are opt-in: set the per-provider client-id and
 * secret env vars and the routes + Login button auto-register.
 *
 * Endpoints:
 *   POST /send-otp                  Send a one-time code to an email
 *   POST /verify-otp                Verify the code and create a session
 *   POST /logout                    Clear session
 *   GET  /me                        Current user + org
 *   GET  /config                    Public auth config (which providers are wired up)
 *   GET  /:provider                 Initiate OAuth for a configured provider
 *   GET  /:provider/callback        Handle OAuth callback
 */

import { type Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { AppError, BadRequestError, UnauthorizedError } from "@/utils/errors.ts";
import { rateLimit } from "@/lib/redis.ts";
import { clientIp } from "@/lib/client-ip.ts";
import {
  type AuthUser,
  createSessionToken,
  createWsToken,
  getUser,
  requireAuth,
  resolveOptionalUser,
} from "@/api/middleware/auth.ts";
import { getSessionDurationMs, isHipaaEnabled } from "@/utils/session-duration.ts";
import { sendOtpEmail } from "@/services/email.ts";
import {
  deleteObject,
  getSignedDownloadUrl,
  isStorageConfigured,
  putObject,
} from "@/services/storage.service.ts";
import {
  fetchGitHubPrimaryEmail,
  findProvider,
  getConfiguredProviders,
  isProviderConfigured,
  type OAuthProvider,
} from "@/lib/oauth-providers.ts";
import { getEnv } from "@/lib/env.ts";
import { requestAppOrigin, requestWebOrigin } from "@/services/app-links.ts";
import { oauthTokenService } from "@/services/mcp-oauth/service.ts";
import { appPath } from "@/config/site.ts";
import { isVerificationAccountEmail } from "@/lib/verification-accounts.ts";
import { verificationSessionRoutes } from "./verification-session.ts";

const authRoutes = new Hono();

// Platform verification sessions (read-only, platform-signed token only).
// Disabled (404) unless the platform injected its secret. See the file.
authRoutes.route("/verification-session", verificationSessionRoutes);

const SESSION_COOKIE = "session_id";
const IS_PROD = getEnv("NODE_ENV") === "production";

// ── Config (public, no auth) ──
// Reports which OAuth providers are configured at runtime so the SPA
// can render a button per provider. OTP is always available as long as
// SMTP is configured — which the platform handles automatically.

authRoutes.get("/config", (c) => {
  const providers = getConfiguredProviders().map((p) => ({
    id: p.id,
    label: p.label,
    color: p.color,
  }));
  return c.json({
    otpEnabled: true, // always; sender domain is platform-managed
    providers,
    // `googleEnabled` is kept for backward compat with any existing
    // SPA bundle that hasn't yet picked up the providers array.
    googleEnabled: providers.some((p) => p.id === "google"),
  });
});

// ── Helpers ──

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function setSessionCookie(
  // deno-lint-ignore no-explicit-any
  c: any,
  token: string,
): void {
  // Cookie maxAge MUST match the JWT exp claim — otherwise the
  // browser drops the cookie before the JWT expires (silent
  // unauth) or keeps it after the JWT expires (silent 401 on
  // every request without re-login). getSessionDurationMs()
  // returns 4h on HIPAA pods, 30d elsewhere — same source the
  // JWT signer uses.
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(getSessionDurationMs() / 1000),
  });
}

/**
 * How long a sign-in code works. Hospital and school mail gateways can hold a
 * message for many minutes, so a 10 minute code could arrive already dead.
 */
export const OTP_TTL_MINUTES = 30;
/**
 * The most a code can ever live, counted from when it was minted. A resend
 * moves a live code's expiry to OTP_TTL_MINUTES from now, but never past
 * this. Without the cap, anyone who saw a code once could keep it working
 * forever by asking for a resend every half hour.
 */
export const OTP_MAX_LIFE_MINUTES = 60;
/** Wrong guesses a single code allows before it is spent. */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * Abuse limits on every route that mints or checks a code. Guards against
 * abuse, not limits real people meet. They run on the shared Redis limiter,
 * which fails open, so a Redis outage never blocks sign-in; the hard limit
 * is OTP_MAX_ATTEMPTS, enforced in Postgres.
 *
 * - sendPerAddress: code emails to one address, shared by send-otp and
 *   the email-change request, so neither route gets around the other.
 * - sendPerIp / verifyPerIp: per client IP (`cf-connecting-ip`). Skipped
 *   when the request carries no edge IP, so one bucket is never shared by
 *   everyone (local dev, tests).
 * - emailChangePerUser: email-change codes one signed-in user can ask for,
 *   across every address.
 */
export const OTP_LIMITS = {
  sendPerAddress: { limit: 10, windowSeconds: 15 * 60 },
  sendPerIp: { limit: 30, windowSeconds: 15 * 60 },
  verifyPerIp: { limit: 50, windowSeconds: 15 * 60 },
  emailChangePerUser: { limit: 10, windowSeconds: 15 * 60 },
} as const;

type Limiter = (
  name: string,
  opts: { limit: number; windowSeconds: number },
) => Promise<{ allowed: boolean }>;

let limiter: Limiter = rateLimit;

/** Test seam: count limits in memory. `null` restores the Redis limiter. */
export function _setAuthRateLimiterForTest(fn: Limiter | null): void {
  limiter = fn ?? rateLimit;
}

function rateLimited(message: string): AppError {
  return new AppError(message, 429, "RATE_LIMITED");
}

/** The per-address and per-IP limits on every route that emails a code. */
async function enforceOtpSendLimits(c: Context, email: string): Promise<void> {
  const perAddress = await limiter(`otp-send:${email}`, OTP_LIMITS.sendPerAddress);
  if (!perAddress.allowed) {
    throw rateLimited(
      "We already sent several codes to this address. Use the code in any of those emails, or wait a few minutes to ask again.",
    );
  }
  const ip = clientIp(c.req);
  if (ip) {
    const perIp = await limiter(`otp-send:ip:${ip}`, OTP_LIMITS.sendPerIp);
    if (!perIp.allowed) {
      throw rateLimited(
        "Too many code requests from this network. Wait a few minutes and try again.",
      );
    }
  }
}

/** The per-IP limit on every route that checks a code. */
async function enforceOtpVerifyLimit(c: Context): Promise<void> {
  const ip = clientIp(c.req);
  if (!ip) return;
  const perIp = await limiter(`otp-verify:ip:${ip}`, OTP_LIMITS.verifyPerIp);
  if (!perIp.allowed) {
    throw rateLimited("Too many tries from this network. Wait a few minutes and try again.");
  }
}

/** A code's expiry: OTP_TTL_MINUTES from now, capped at OTP_MAX_LIFE_MINUTES from minting. */
function otpExpiresAt(now = new Date(), createdAt = now): Date {
  return new Date(
    Math.min(
      now.getTime() + OTP_TTL_MINUTES * 60 * 1000,
      createdAt.getTime() + OTP_MAX_LIFE_MINUTES * 60 * 1000,
    ),
  );
}

function generateOtp(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
}

/**
 * The code to email to `email`: the live, unspent one when there is one,
 * else a new one. A resend sends the SAME code while one is still live.
 * Email arrives late and out of order, and people press Resend while they
 * wait. When every send minted a new code and killed the old one, the email
 * a person finally opened held a dead code, and sign-in failed in a loop.
 * With one live code per address, every email in the inbox works.
 *
 * Reusing a code keeps its try count, and its expiry moves only up to the
 * OTP_MAX_LIFE_MINUTES cap. Shared by send-otp and the email-change request.
 */
async function issueOtp(email: string): Promise<string> {
  const now = new Date();
  await db.deleteFrom("otps").where("email", "=", email).where("expiresAt", "<=", now).execute();
  const live = await db
    .selectFrom("otps")
    .select(["id", "otpCode", "createdAt"])
    .where("email", "=", email)
    .where("attempts", "<", OTP_MAX_ATTEMPTS)
    .orderBy("createdAt", "desc")
    .executeTakeFirst();

  if (live) {
    const expiresAt = otpExpiresAt(now, new Date(live.createdAt));
    await db.updateTable("otps").set({ expiresAt }).where("id", "=", live.id).execute();
    return live.otpCode;
  }
  const otpCode = generateOtp();
  await db.deleteFrom("otps").where("email", "=", email).execute(); // spent codes
  await db.insertInto("otps").values({ email, otpCode, expiresAt: otpExpiresAt(now) }).execute();
  return otpCode;
}

/**
 * Claim one try on every live, unspent code for `email`, before any compare.
 * The increment and the limit check are one statement, so parallel guesses
 * cannot all read the same count: Postgres serializes the row updates and at
 * most OTP_MAX_ATTEMPTS guesses ever get a row back. Never read the count
 * and increment it in a second query.
 */
async function claimOtpTry(
  email: string,
): Promise<{ id: string; otpCode: string; attempts: number }[]> {
  return await db
    .updateTable("otps")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("email", "=", email)
    .where("expiresAt", ">", new Date())
    .where("attempts", "<", OTP_MAX_ATTEMPTS)
    .returning(["id", "otpCode", "attempts"])
    .execute();
}

/** True when a live code for `email` exists but has no tries left. */
async function hasSpentOtp(email: string): Promise<boolean> {
  const spent = await db
    .selectFrom("otps")
    .select("id")
    .where("email", "=", email)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  return spent !== undefined;
}

/** Use up the matched code with a delete only one request can win, then every other code for the address. */
async function consumeOtp(id: string, email: string): Promise<boolean> {
  const consumed = await db
    .deleteFrom("otps")
    .where("id", "=", id)
    .returning("id")
    .executeTakeFirst();
  if (!consumed) return false;
  await db.deleteFrom("otps").where("email", "=", email).execute();
  return true;
}

// ── Schemas ──

const sendOtpSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  name: z.string().trim().min(1).optional(),
});

// Pasted codes carry spaces ("123 456") or a stray character. Keep the digits.
const otpCodeSchema = z.string().transform((v) => v.replace(/\D/g, "")).pipe(z.string().length(6));

const verifyOtpSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  otpCode: otpCodeSchema,
  name: z.string().trim().min(1).optional(),
});

// ── Routes ──

/**
 * POST /send-otp
 * Sends a one-time verification code to the given email.
 * In dev mode, the code is logged to the console.
 */
authRoutes.post("/send-otp", zValidator("json", sendOtpSchema, validationHook), async (c) => {
  const { email } = c.req.valid("json");

  // Platform verification accounts sign in ONLY through the platform-signed
  // verification token. Never issue a guessable email code for them.
  if (isVerificationAccountEmail(email)) {
    throw new BadRequestError("This address cannot sign in by email code");
  }

  await enforceOtpSendLimits(c, email);
  const otpCode = await issueOtp(email);

  // Send the OTP email (falls back to console.log when SMTP not configured)
  sendOtpEmail(email, otpCode).catch((err) => {
    log.error("Failed to send OTP email", { source: "auth", email }, err as Error);
  });

  log.info("OTP sent", { source: "auth", email });

  return c.json({ ok: true, message: "Verification code sent" });
});

/**
 * POST /verify-otp
 * Verifies the one-time code and creates a session.
 * If the user doesn't exist, creates a new user and org.
 */
authRoutes.post("/verify-otp", zValidator("json", verifyOtpSchema, validationHook), async (c) => {
  const { email, otpCode, name } = c.req.valid("json");

  if (isVerificationAccountEmail(email)) {
    throw new UnauthorizedError("Invalid or expired code");
  }
  await enforceOtpVerifyLimit(c);

  // Every guess, right or wrong, first claims one try on each live, unspent
  // code for this email (claimOtpTry). A resend reuses the live code, so this
  // is normally one row; rows from an older deploy can leave a few, and any
  // of them works.
  const claimed = await claimOtpTry(email);

  if (claimed.length === 0) {
    // No try left to claim. Tell expired apart from spent. Never delete here:
    // a spent row holds the count, and deleting it would reset the limit. The
    // next send replaces it, or it expires.
    throw new UnauthorizedError(
      (await hasSpentOtp(email))
        ? "Too many wrong tries on that code. Tap Resend code to get a new one."
        : "That code has expired. Tap Resend code to get a new one.",
    );
  }

  const match = claimed.find((o) => o.otpCode === otpCode);
  if (!match) {
    const left = OTP_MAX_ATTEMPTS - Math.max(...claimed.map((o) => o.attempts));
    throw new UnauthorizedError(
      left > 0
        ? `That code doesn't match. Check the code in the email. ${left} ${
          left === 1 ? "try" : "tries"
        } left.`
        : "That code doesn't match, and there are no tries left. Tap Resend code to get a new one.",
    );
  }

  // Code matches. Consume it with a delete that only one request can win, so
  // two parallel right guesses cannot both sign in on one code.
  if (!(await consumeOtp(match.id, email))) {
    throw new UnauthorizedError("That code was already used. Tap Resend code to get a new one.");
  }

  // Look up or create user
  let user = await db
    .selectFrom("users")
    .select(["id", "email", "name", "role", "organizationId"])
    .where("email", "=", email)
    .executeTakeFirst();

  let organization:
    | { id: string; name: string; slug: string | null; subscriptionTier: string }
    | undefined;

  if (!user) {
    // Create new user with org
    const displayName = name ?? email.split("@")[0];
    const orgSlug = slugify(displayName);

    const result = await db.transaction().execute(async (trx) => {
      const org = await trx
        .insertInto("organizations")
        .values({
          name: `${displayName}'s Organization`,
          slug: orgSlug,
          subscriptionTier: "FREE",
          creditsExhausted: false,
        })
        .returning(["id", "name", "slug", "subscriptionTier"])
        .executeTakeFirstOrThrow();

      const newUser = await trx
        .insertInto("users")
        .values({
          email,
          name: displayName,
          role: "owner",
          organizationId: org.id,
          emailVerified: true,
        })
        .returning(["id", "email", "name", "role", "organizationId"])
        .executeTakeFirstOrThrow();

      return { user: newUser, org };
    });

    user = result.user;
    organization = result.org;
  } else {
    // Update existing user
    await db
      .updateTable("users")
      .set({ emailVerified: true, lastLoginAt: new Date() })
      .where("id", "=", user.id)
      .execute();

    organization = await db
      .selectFrom("organizations")
      .select(["id", "name", "slug", "subscriptionTier"])
      .where("id", "=", user.organizationId!)
      .executeTakeFirst();
  }

  const token = await createSessionToken({
    id: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId!,
    role: user.role,
  });

  setSessionCookie(c, token);

  log.info("OTP verified", {
    source: "auth",
    userId: user.id,
    email: user.email,
  });

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    organization: organization ?? null,
  });
});

/**
 * POST /logout
 * Clears the session cookie on the current device.
 */
authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/**
 * POST /logout-all
 * Revokes every JWT issued before this instant for the current user.
 * The auth middleware compares each request's JWT iat against
 * users.tokenInvalidatedBefore — anything older returns 401 on next
 * use, forcing re-login on every other device.
 */
authRoutes.post("/logout-all", requireAuth, async (c) => {
  const user = getUser(c);
  await db
    .updateTable("users")
    .set({ tokenInvalidatedBefore: new Date() })
    .where("id", "=", user.id)
    .execute();

  // Connected assistants (ChatGPT, Claude) hold MCP OAuth tokens that reach
  // the app's agent tools. Revoke them too. mcp_sk_ API keys are separate,
  // explicitly minted credentials with their own revoke, like api_sk_ keys.
  const revokedAssistantTokens = await oauthTokenService.revokeAllForUser(user.id);

  // Drop the current device's cookie too — otherwise the user stays
  // logged in here while every OTHER device gets kicked, which is
  // confusing UX even though it's technically correct.
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  log.info("Logout all sessions", {
    source: "auth",
    feature: "logout-all",
    userId: user.id,
    revokedAssistantTokens,
  });

  return c.json({ ok: true });
});

/**
 * GET /me
 * Returns the current authenticated user and their organization, plus
 * `hipaaEnabled` so the SPA knows whether to arm its session-timeout
 * activity tracker. The HIPAA flag is deployment-scoped (HIPAA_ENABLED
 * env var on the customer pod), not per-user or per-org — see
 * src/utils/session-duration.ts for the rationale.
 */
authRoutes.get("/me", requireAuth, async (c) => {
  return c.json(await sessionBody(getUser(c)));
});

/**
 * GET /session
 * The SPA's startup session check. Same body as GET /me for a signed-in
 * user; for an anonymous visitor it answers 200 `{ user: null }` instead
 * of a 401. A 401 is the expected answer for a visitor on a public page,
 * but the browser still prints every 4xx fetch as a console error, so every
 * public page logged one. GET /me keeps its 401 for callers that need it.
 *
 * Read-only and it authorizes nothing: the user comes from the same verify
 * path `requireAuth` uses (`resolveOptionalUser`).
 */
authRoutes.get("/session", async (c) => {
  const user = await resolveOptionalUser(c);
  if (!user) {
    return c.json({
      user: null,
      organization: null,
      hipaaEnabled: isHipaaEnabled(),
      sessionDurationMs: getSessionDurationMs(),
    });
  }
  return c.json(await sessionBody(user));
});

async function sessionBody(user: AuthUser) {
  const org = await db
    .selectFrom("organizations")
    .select(["id", "name", "slug", "subscriptionTier"])
    .where("id", "=", user.organizationId)
    .executeTakeFirst();

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    organization: org ?? null,
    hipaaEnabled: isHipaaEnabled(),
    sessionDurationMs: getSessionDurationMs(),
  };
}

/**
 * POST /touch
 * Extends the session on user activity. The SPA's session-timeout
 * store calls this every 5 minutes during active use so the JWT exp
 * stays ahead of the inactivity ceiling. When NO call lands inside a
 * sessionDurationMs window, the JWT expires naturally and the next
 * request 401s — that's the HIPAA "automatic logoff" requirement.
 *
 * Re-issues a fresh JWT with current iat + ttl, sets it as the
 * session cookie. Idempotent and cheap.
 */
authRoutes.post("/touch", requireAuth, async (c) => {
  const user = getUser(c);

  const token = await createSessionToken({
    id: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId,
    role: user.role,
  });
  setSessionCookie(c, token);

  return c.json({
    ok: true,
    sessionDurationMs: getSessionDurationMs(),
    expiresAt: new Date(Date.now() + getSessionDurationMs()).toISOString(),
  });
});

/**
 * PATCH /me
 * Update the current authenticated user's profile (name, picture).
 *
 * Email is deliberately NOT accepted here. An unverified email swap on
 * an OTP-login app is a lockout trap (typo the new address and the
 * next login code goes somewhere you can't read) and makes a stolen
 * session cookie durable (attacker rebinds the account to their own
 * address). Email moves ONLY through the verify-first flow below:
 * POST /me/email-change then POST /me/email-change/confirm.
 */
const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    picture: z.string().url().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.picture !== undefined, {
    message: "At least one field is required",
  });

authRoutes.patch(
  "/me",
  requireAuth,
  zValidator("json", updateMeSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const body = c.req.valid("json");

    const updates: Partial<{
      name: string;
      picture: string | null;
    }> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.picture !== undefined) updates.picture = body.picture;

    await db
      .updateTable("users")
      .set(updates)
      .where("id", "=", user.id)
      .execute();

    const updated = await db
      .selectFrom("users")
      .select(["id", "email", "name", "picture", "role", "emailVerified"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();

    const org = await db
      .selectFrom("organizations")
      .select(["id", "name", "slug", "subscriptionTier"])
      .where("id", "=", user.organizationId)
      .executeTakeFirst();

    log.info("Profile updated", {
      source: "auth",
      feature: "profile-update",
      userId: user.id,
      fieldsChanged: Object.keys(updates),
    });

    return c.json({
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        picture: updated.picture,
        role: updated.role,
        emailVerified: updated.emailVerified,
      },
      organization: org ?? null,
    });
  },
);

// ── Email change (verify-first) ────────────────────────────────────────────
// Two-step flow: request a code to the NEW address, then confirm with
// that code. The address only changes after the code proves the user
// can actually receive mail there, which is what makes the next OTP
// login possible. Reuses the `otps` table (keyed on the new email), so
// no schema change: an OTP is "a code that proves control of an
// address at this moment", regardless of which flow minted it.
//
// OAuth caveat: a user who signs in via an OAuth provider is keyed to
// the provider account's email. After changing the app-side email they
// must log in via OTP to the new address; an OAuth login on the OLD
// address would mint a fresh account. That's inherent to email-keyed
// identity, and the SPA copy should steer changed users to OTP login.

const emailChangeRequestSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
});

const emailChangeConfirmSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  otpCode: z.string().length(6),
});

/** 409 when another account already holds `email`. Checked at request
 *  AND confirm time: someone can sign up with the address between the
 *  two steps, and the unique index on users.email would otherwise turn
 *  the confirm UPDATE into a 500. */
async function findEmailCollision(
  email: string,
  selfId: string,
): Promise<boolean> {
  const conflict = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", email)
    .where("id", "!=", selfId)
    .executeTakeFirst();
  return conflict !== undefined;
}

authRoutes.post(
  "/me/email-change",
  requireAuth,
  zValidator("json", emailChangeRequestSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { email } = c.req.valid("json");

    if (email === user.email) {
      throw new BadRequestError("That is already your email address.");
    }
    if (await findEmailCollision(email, user.id)) {
      return c.json(
        { error: "Email is already in use", code: "EMAIL_IN_USE" },
        409,
      );
    }

    // The same limits as POST /send-otp (one per-address bucket for both
    // routes), plus a per-user cap across addresses.
    const perUser = await limiter(`email-change:user:${user.id}`, OTP_LIMITS.emailChangePerUser);
    if (!perUser.allowed) {
      throw rateLimited("You asked for several codes already. Wait a few minutes and try again.");
    }
    await enforceOtpSendLimits(c, email);

    // Same code semantics as POST /send-otp: a resend reuses the live code
    // and keeps its try count.
    const otpCode = await issueOtp(email);

    sendOtpEmail(email, otpCode).catch((err) => {
      log.error(
        "Failed to send email-change OTP",
        { source: "auth", feature: "email-change", email },
        err as Error,
      );
    });

    log.info("Email change requested", {
      source: "auth",
      feature: "email-change",
      userId: user.id,
      newEmail: email,
    });

    return c.json({ ok: true, message: "Verification code sent to the new address" });
  },
);

authRoutes.post(
  "/me/email-change/confirm",
  requireAuth,
  zValidator("json", emailChangeConfirmSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { email, otpCode } = c.req.valid("json");

    if (email === user.email) {
      throw new BadRequestError("That is already your email address.");
    }

    await enforceOtpVerifyLimit(c);

    // Same verification semantics as POST /verify-otp: claim a try before
    // the compare (claimOtpTry), never delete a spent code (it holds the
    // count), consume on success with a delete only one request can win.
    const claimed = await claimOtpTry(email);
    if (claimed.length === 0) {
      throw new UnauthorizedError(
        (await hasSpentOtp(email))
          ? "Too many attempts. Request a new code."
          : "Invalid or expired code",
      );
    }
    const match = claimed.find((o) => o.otpCode === otpCode);
    if (!match) {
      throw new UnauthorizedError("Invalid code");
    }
    if (!(await consumeOtp(match.id, email))) {
      throw new UnauthorizedError("Invalid or expired code");
    }

    // Re-check the collision: the address may have been claimed since
    // the request step.
    if (await findEmailCollision(email, user.id)) {
      return c.json(
        { error: "Email is already in use", code: "EMAIL_IN_USE" },
        409,
      );
    }

    const previousEmail = user.email;
    await db
      .updateTable("users")
      .set({ email, emailVerified: true })
      .where("id", "=", user.id)
      .execute();

    // Re-issue the session cookie so the JWT's email claim matches the
    // DB (the middleware reads the DB copy either way; this just keeps
    // the token self-consistent).
    const token = await createSessionToken({
      id: user.id,
      email,
      name: user.name,
      organizationId: user.organizationId,
      role: user.role,
    });
    setSessionCookie(c, token);

    log.info("Email changed", {
      source: "auth",
      feature: "email-change",
      userId: user.id,
      previousEmail,
      newEmail: email,
    });

    return c.json({
      user: { id: user.id, email, name: user.name, role: user.role },
    });
  },
);

// ── Avatar / picture upload ────────────────────────────────────────────────
// Customers (or end users) can upload a picture that overrides the OAuth-
// provider avatar. Stored at `users/<userId>/avatar.<ext>` in the project's
// R2 prefix. We keep a 7-day presigned download URL in users.picture so
// the SPA can <img src> it directly without a refresh round-trip; after 7
// days a re-upload (or a follow-up "refresh URL" endpoint a customer adds)
// is required. OAuth-provided URLs (https://...) stay as-is and never
// expire — only avatars uploaded through THIS endpoint get the TTL.

const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const AVATAR_TTL_SECONDS = 7 * 24 * 60 * 60;
const ALLOWED_AVATAR_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function avatarExtension(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

authRoutes.post("/me/picture", requireAuth, async (c) => {
  const user = getUser(c);

  if (!isStorageConfigured()) {
    throw new BadRequestError("File storage is not configured on this app");
  }

  const ct = c.req.header("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    throw new BadRequestError("Use multipart/form-data with a `file` field");
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new BadRequestError("`file` field is required and must be a file");
  }
  if (file.size === 0) throw new BadRequestError("Empty file");
  if (file.size > AVATAR_MAX_BYTES) {
    throw new BadRequestError(
      `Avatar exceeds size limit (${AVATAR_MAX_BYTES} bytes)`,
    );
  }
  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED_AVATAR_TYPES.has(contentType)) {
    throw new BadRequestError(
      `Unsupported image type: ${contentType}. Allowed: png, jpeg, webp, gif.`,
    );
  }

  const relativeKey = `users/${user.id}/avatar.${avatarExtension(contentType)}`;
  const buffer = new Uint8Array(await file.arrayBuffer());

  await putObject({ key: relativeKey, body: buffer, contentType });

  // Stable presigned download URL (7-day TTL). Customer apps can either
  // re-upload to refresh, or add a /me/picture/refresh endpoint that
  // re-presigns — leaving that out of the baseline keeps this endpoint
  // self-contained.
  const pictureUrl = getSignedDownloadUrl(relativeKey, AVATAR_TTL_SECONDS);

  await db
    .updateTable("users")
    .set({ picture: pictureUrl })
    .where("id", "=", user.id)
    .execute();

  log.info("Avatar uploaded", {
    source: "auth",
    feature: "avatar-upload",
    userId: user.id,
    bytes: buffer.length,
    contentType,
  });

  return c.json({ picture: pictureUrl });
});

authRoutes.delete("/me/picture", requireAuth, async (c) => {
  const user = getUser(c);

  if (isStorageConfigured()) {
    // Best-effort R2 delete — if storage is detached from the picture
    // (e.g. an OAuth URL stored as picture, never uploaded), this is
    // a no-op. Don't fail the request just because the blob isn't
    // there: the user's intent ("remove my avatar") is the picture
    // column, and clearing that column is the load-bearing action.
    for (const ext of ["png", "jpg", "webp", "gif"]) {
      await deleteObject(`users/${user.id}/avatar.${ext}`).catch(() => {});
    }
  }

  await db
    .updateTable("users")
    .set({ picture: null })
    .where("id", "=", user.id)
    .execute();

  log.info("Avatar removed", {
    source: "auth",
    feature: "avatar-remove",
    userId: user.id,
  });

  return c.json({ picture: null });
});

// ── User preferences ───────────────────────────────────────────────────────
// Free-form per-user prefs (notifications, timezone, locale, theme).
// Stored as JSONB on users; GET returns the stored object, PATCH does
// a SHALLOW merge with the existing prefs so a client can update one
// key without round-tripping the whole shape.
//
// The shape is intentionally loose: customers add fields as their UI
// needs them. The template itself doesn't read prefs anywhere — the
// SPA decides what means what.

authRoutes.get("/me/preferences", requireAuth, async (c) => {
  const user = getUser(c);
  const row = await db
    .selectFrom("users")
    .select(["preferences"])
    .where("id", "=", user.id)
    .executeTakeFirstOrThrow();

  // postgres.js returns JSONB columns as already-parsed JS values.
  // Coerce a defensive null/undefined to {} so the SPA can always
  // assume an object on the wire.
  const prefs = (row.preferences ?? {}) as Record<string, unknown>;
  return c.json({ preferences: prefs });
});

const updatePreferencesSchema = z.object({
  preferences: z.record(z.unknown()),
});

authRoutes.patch(
  "/me/preferences",
  requireAuth,
  zValidator("json", updatePreferencesSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { preferences: incoming } = c.req.valid("json");

    // Shallow merge — keys in `incoming` overwrite keys in stored,
    // others stay. Setting a key to null is the explicit "delete this
    // pref" signal, mirroring what the SPA likely wants.
    const current = await db
      .selectFrom("users")
      .select(["preferences"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();

    const merged: Record<string, unknown> = {
      ...((current.preferences ?? {}) as Record<string, unknown>),
      ...incoming,
    };
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null) delete merged[k];
    }

    await db
      .updateTable("users")
      .set({ preferences: merged })
      .where("id", "=", user.id)
      .execute();

    log.info("Preferences updated", {
      source: "auth",
      feature: "preferences-update",
      userId: user.id,
      keysChanged: Object.keys(incoming),
    });

    return c.json({ preferences: merged });
  },
);

// ── WebSocket handshake token ──────────────────────────────────────────────
// Customer apps building real-time features (chat, presence, live
// dashboards) need to authenticate the WS connection. Cookies don't
// reliably travel on cross-origin WS connections and many client
// libraries can't set cookies anyway; the standard pattern is "fetch
// a short-lived token from an authenticated REST endpoint, then pass
// it on the WS handshake." This is that endpoint.

authRoutes.get("/ws-token", requireAuth, async (c) => {
  const user = getUser(c);
  const token = await createWsToken({
    id: user.id,
    organizationId: user.organizationId,
  });
  return c.json({ token, expiresInSeconds: 60 });
});

// ── OAuth (provider-driven) ────────────────────────────────────────────────
// One pair of routes (`/:provider` + `/:provider/callback`) handles every
// provider in src/lib/oauth-providers.ts. Adding a new provider is one
// entry in that file plus matching env vars — no code change here.

// The callback comes back to the host the flow started on: the state cookie
// is host-only, and an app can answer on its on.chipp.ai address and a
// custom domain (see app-links.ts). Register both callback URLs with the
// provider.
function buildAuthorizeUrl(provider: OAuthProvider, state: string, origin: string): string {
  const params = new URLSearchParams({
    client_id: getEnv(provider.clientIdEnv)!,
    redirect_uri: `${origin}/api/auth/${provider.id}/callback`,
    response_type: "code",
    scope: provider.scopes,
    state,
  });
  if (provider.id === "google") {
    // Google-only knobs: refresh tokens + re-consent.
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  return `${provider.authUrl}?${params.toString()}`;
}

authRoutes.get("/:provider", (c) => {
  const providerId = c.req.param("provider");
  // Reserved internal paths under the same router. If a future provider
  // ever happens to collide, rename the provider id.
  if (
    providerId === "send-otp" || providerId === "verify-otp" ||
    providerId === "logout" || providerId === "me" ||
    providerId === "config"
  ) {
    return c.notFound();
  }
  const provider = findProvider(providerId);
  if (!provider) {
    throw new BadRequestError(`Unknown OAuth provider: ${providerId}`);
  }
  if (!isProviderConfigured(provider)) {
    throw new BadRequestError(
      `${provider.label} is not configured (set ${provider.clientIdEnv} and ${provider.clientSecretEnv})`,
    );
  }

  const state = crypto.randomUUID();
  // Cookie name is provider-suffixed so concurrent OAuth flows in
  // different tabs don't clobber each other's state.
  setCookie(c, `oauth_state_${provider.id}`, state, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax",
    path: "/",
    maxAge: 600, // 10 minutes
  });

  return c.redirect(buildAuthorizeUrl(provider, state, requestAppOrigin(c.req)));
});

authRoutes.get("/:provider/callback", async (c) => {
  const providerId = c.req.param("provider");
  const provider = findProvider(providerId);
  if (!provider) throw new BadRequestError(`Unknown OAuth provider: ${providerId}`);
  if (!isProviderConfigured(provider)) {
    throw new BadRequestError(`${provider.label} is not configured`);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, `oauth_state_${provider.id}`);

  if (!code || !state || state !== storedState) {
    throw new BadRequestError("Invalid OAuth callback");
  }
  deleteCookie(c, `oauth_state_${provider.id}`, { path: "/" });

  const clientId = getEnv(provider.clientIdEnv)!;
  const clientSecret = getEnv(provider.clientSecretEnv)!;
  const redirectUri = `${requestAppOrigin(c.req)}/api/auth/${provider.id}/callback`;

  // ── Exchange code for tokens ─────────────────────────────────────────
  // GitHub returns `application/x-www-form-urlencoded` by default; setting
  // `Accept: application/json` makes every provider return parseable JSON.
  const tokenResponse = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text().catch(() => "<unreadable>");
    log.warn(
      `${provider.id} token exchange failed`,
      {
        source: "auth",
        feature: `oauth-${provider.id}-token`,
        status: tokenResponse.status,
        body: body.slice(0, 300),
      },
    );
    throw new BadRequestError("Failed to exchange authorization code");
  }

  const tokens = await tokenResponse.json() as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokens.access_token) {
    throw new BadRequestError(
      tokens.error_description ?? tokens.error ?? "OAuth token exchange returned no access_token",
    );
  }

  // ── Fetch userinfo ───────────────────────────────────────────────────
  // GitHub requires a User-Agent (otherwise it 403s). Send one for every
  // provider; harmless for those that ignore it.
  const userInfoResponse = await fetch(provider.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "User-Agent": "alchemist-template",
      Accept: "application/json",
    },
  });
  if (!userInfoResponse.ok) {
    throw new BadRequestError(`Failed to get user info from ${provider.label}`);
  }
  const rawUser = await userInfoResponse.json();
  let mapped = provider.mapUser(rawUser);

  // GitHub-specific: when the user has a private email, the `email` field
  // on /user is null. Recover the primary verified email from /user/emails.
  if (provider.id === "github" && !mapped.email) {
    const recovered = await fetchGitHubPrimaryEmail(tokens.access_token);
    if (!recovered) {
      throw new BadRequestError(
        "Couldn't read your GitHub email — make sure you have at least one verified address.",
      );
    }
    mapped = { ...mapped, email: recovered };
  }
  if (!mapped.email) {
    throw new BadRequestError(`${provider.label} did not return an email address.`);
  }

  // ── Find or create user ──────────────────────────────────────────────
  let user = await db
    .selectFrom("users")
    .select(["id", "email", "name", "role", "organizationId"])
    .where("email", "=", mapped.email)
    .executeTakeFirst();

  if (!user) {
    const displayName = mapped.name ?? mapped.email.split("@")[0];
    const orgSlug = slugify(displayName);

    const result = await db.transaction().execute(async (trx) => {
      const org = await trx
        .insertInto("organizations")
        .values({
          name: `${displayName}'s Organization`,
          slug: orgSlug,
          subscriptionTier: "FREE",
          creditsExhausted: false,
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      const newUser = await trx
        .insertInto("users")
        .values({
          email: mapped.email,
          name: mapped.name,
          picture: mapped.picture,
          oauthProvider: provider.id,
          oauthId: mapped.providerUserId,
          role: "owner",
          organizationId: org.id,
          emailVerified: true,
        })
        .returning(["id", "email", "name", "role", "organizationId"])
        .executeTakeFirstOrThrow();

      return newUser;
    });

    user = result;
  } else {
    // Link / update OAuth identity on the existing user. Provider switch
    // (e.g. user previously signed in with Google, now coming back via
    // GitHub on the same email) is allowed and updates the linkage.
    await db
      .updateTable("users")
      .set({
        oauthProvider: provider.id,
        oauthId: mapped.providerUserId,
        picture: mapped.picture ?? null,
        lastLoginAt: new Date(),
        emailVerified: true,
      })
      .where("id", "=", user.id)
      .execute();
  }

  const token = await createSessionToken({
    id: user.id,
    email: user.email,
    name: user.name,
    organizationId: user.organizationId!,
    role: user.role,
  });
  setSessionCookie(c, token);

  log.info(`OAuth login (${provider.id})`, {
    source: "auth",
    feature: `oauth-${provider.id}-login`,
    userId: user.id,
    email: user.email,
  });

  // Land on the SPA, not the landing site that may own "/".
  return c.redirect(`${requestWebOrigin(c.req)}${appPath("/#/")}`);
});

export { authRoutes };
