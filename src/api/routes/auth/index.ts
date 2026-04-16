/**
 * Auth Routes
 *
 * POST /send-otp           - Send a one-time code to an email
 * POST /verify-otp         - Verify the code and create a session
 * POST /logout             - Clear session
 * GET  /me                 - Current user + org
 * GET  /config             - Public auth config
 * GET  /google             - Initiate Google OAuth
 * GET  /google/callback    - Handle Google OAuth callback
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { db } from "@/db/client.ts";
import { log } from "@/lib/logger.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError, UnauthorizedError } from "@/utils/errors.ts";
import { createSessionToken, requireAuth, getUser } from "@/api/middleware/auth.ts";
import { sendOtpEmail } from "@/services/email.ts";

const authRoutes = new Hono();

const SESSION_COOKIE = "session_id";
const IS_PROD = Deno.env.get("NODE_ENV") === "production";

// ── Config (public, no auth) ──

authRoutes.get("/config", (c) => {
  return c.json({
    googleEnabled: !!Deno.env.get("GOOGLE_CLIENT_ID"),
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

function setSessionCookie(
  // deno-lint-ignore no-explicit-any
  c: any,
  token: string,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  });
}

function generateOtp(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
}

// ── Schemas ──

const sendOtpSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  name: z.string().trim().min(1).optional(),
});

const verifyOtpSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  otpCode: z.string().length(6),
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

  // Delete any existing OTPs for this email
  await db
    .deleteFrom("app.otps")
    .where("email", "=", email)
    .execute();

  const otpCode = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db
    .insertInto("app.otps")
    .values({
      email,
      otpCode,
      expiresAt,
    })
    .execute();

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

  // Look up the OTP
  const otp = await db
    .selectFrom("app.otps")
    .selectAll()
    .where("email", "=", email)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();

  if (!otp) {
    throw new UnauthorizedError("Invalid or expired code");
  }

  // Check max attempts
  if (otp.attempts >= 5) {
    await db
      .deleteFrom("app.otps")
      .where("id", "=", otp.id)
      .execute();
    throw new UnauthorizedError("Too many attempts. Request a new code.");
  }

  // Check code match
  if (otp.otpCode !== otpCode) {
    // Increment attempts in a separate query so it commits even if we throw
    await db
      .updateTable("app.otps")
      .set({ attempts: otp.attempts + 1 })
      .where("id", "=", otp.id)
      .execute();
    throw new UnauthorizedError("Invalid code");
  }

  // Code matches -- delete the OTP
  await db
    .deleteFrom("app.otps")
    .where("id", "=", otp.id)
    .execute();

  // Look up or create user
  let user = await db
    .selectFrom("app.users")
    .select(["id", "email", "name", "role", "organizationId"])
    .where("email", "=", email)
    .executeTakeFirst();

  let organization: { id: string; name: string; slug: string | null; subscriptionTier: string } | undefined;

  if (!user) {
    // Create new user with org
    const displayName = name ?? email.split("@")[0];
    const orgSlug = slugify(displayName);

    const result = await db.transaction().execute(async (trx) => {
      const org = await trx
        .insertInto("app.organizations")
        .values({
          name: `${displayName}'s Organization`,
          slug: orgSlug,
          subscriptionTier: "FREE",
          creditsExhausted: false,
        })
        .returning(["id", "name", "slug", "subscriptionTier"])
        .executeTakeFirstOrThrow();

      const newUser = await trx
        .insertInto("app.users")
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
      .updateTable("app.users")
      .set({ emailVerified: true, lastLoginAt: new Date() })
      .where("id", "=", user.id)
      .execute();

    organization = await db
      .selectFrom("app.organizations")
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
 * Clears the session cookie.
 */
authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/**
 * GET /me
 * Returns the current authenticated user and their organization.
 */
authRoutes.get("/me", requireAuth, async (c) => {
  const user = getUser(c);

  const org = await db
    .selectFrom("app.organizations")
    .select(["id", "name", "slug", "subscriptionTier"])
    .where("id", "=", user.organizationId)
    .executeTakeFirst();

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    organization: org ?? null,
  });
});

/**
 * GET /google
 * Initiates Google OAuth flow.
 * Redirects to Google's consent screen.
 */
authRoutes.get("/google", (c) => {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!clientId) {
    throw new BadRequestError("Google OAuth not configured");
  }

  const redirectUri = `${Deno.env.get("APP_URL") ?? "http://localhost:8000"}/api/auth/google/callback`;
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  // Store state in a cookie for CSRF validation
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax",
    path: "/",
    maxAge: 600, // 10 minutes
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

/**
 * GET /google/callback
 * Handles the OAuth callback from Google.
 */
authRoutes.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, "oauth_state");

  if (!code || !state || state !== storedState) {
    throw new BadRequestError("Invalid OAuth callback");
  }

  deleteCookie(c, "oauth_state", { path: "/" });

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const redirectUri = `${Deno.env.get("APP_URL") ?? "http://localhost:8000"}/api/auth/google/callback`;

  if (!clientId || !clientSecret) {
    throw new BadRequestError("Google OAuth not configured");
  }

  // Exchange code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    log.warn("Google token exchange failed", {
      source: "auth",
      status: tokenResponse.status,
    });
    throw new BadRequestError("Failed to exchange authorization code");
  }

  const tokens = await tokenResponse.json();

  // Get user info
  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userInfoResponse.ok) {
    throw new BadRequestError("Failed to get user info from Google");
  }

  const googleUser = await userInfoResponse.json();
  const googleEmail = (googleUser.email as string).toLowerCase().trim();
  const googleName = googleUser.name as string | null;
  const picture = googleUser.picture as string | null;
  const googleId = googleUser.id as string;

  // Check if user exists
  let user = await db
    .selectFrom("app.users")
    .select(["id", "email", "name", "role", "organizationId"])
    .where("email", "=", googleEmail)
    .executeTakeFirst();

  if (!user) {
    // Create new user with org
    const orgSlug = slugify(googleName ?? googleEmail.split("@")[0]);

    const result = await db.transaction().execute(async (trx) => {
      const org = await trx
        .insertInto("app.organizations")
        .values({
          name: `${googleName ?? googleEmail}'s Organization`,
          slug: orgSlug,
          subscriptionTier: "FREE",
          creditsExhausted: false,
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      const newUser = await trx
        .insertInto("app.users")
        .values({
          email: googleEmail,
          name: googleName,
          picture,
          oauthProvider: "google",
          oauthId: googleId,
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
    // Link Google OAuth if not already linked
    await db
      .updateTable("app.users")
      .set({
        oauthProvider: "google",
        oauthId: googleId,
        picture,
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

  log.info("Google OAuth login", {
    source: "auth",
    userId: user.id,
    email: user.email,
  });

  // Redirect to the web app
  const webUrl = Deno.env.get("WEB_APP_URL") ?? "http://localhost:5173";
  return c.redirect(webUrl);
});

export { authRoutes };
