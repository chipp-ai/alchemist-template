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
import {
  fetchGitHubPrimaryEmail,
  findProvider,
  getConfiguredProviders,
  isProviderConfigured,
  type OAuthProvider,
} from "@/lib/oauth-providers.ts";

const authRoutes = new Hono();

const SESSION_COOKIE = "session_id";
const IS_PROD = Deno.env.get("NODE_ENV") === "production";

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
    .deleteFrom("otps")
    .where("email", "=", email)
    .execute();

  const otpCode = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db
    .insertInto("otps")
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
    .selectFrom("otps")
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
      .deleteFrom("otps")
      .where("id", "=", otp.id)
      .execute();
    throw new UnauthorizedError("Too many attempts. Request a new code.");
  }

  // Check code match
  if (otp.otpCode !== otpCode) {
    // Increment attempts in a separate query so it commits even if we throw
    await db
      .updateTable("otps")
      .set({ attempts: otp.attempts + 1 })
      .where("id", "=", otp.id)
      .execute();
    throw new UnauthorizedError("Invalid code");
  }

  // Code matches -- delete the OTP
  await db
    .deleteFrom("otps")
    .where("id", "=", otp.id)
    .execute();

  // Look up or create user
  let user = await db
    .selectFrom("users")
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

  // Drop the current device's cookie too — otherwise the user stays
  // logged in here while every OTHER device gets kicked, which is
  // confusing UX even though it's technically correct.
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  log.info("Logout all sessions", {
    source: "auth",
    feature: "logout-all",
    userId: user.id,
  });

  return c.json({ ok: true });
});

/**
 * GET /me
 * Returns the current authenticated user and their organization.
 */
authRoutes.get("/me", requireAuth, async (c) => {
  const user = getUser(c);

  const org = await db
    .selectFrom("organizations")
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
 * PATCH /me
 * Update the current authenticated user's profile (name, email, picture).
 * Email change resets emailVerified — the user has to re-verify via OTP
 * before we trust the new address.
 */
const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().email().trim().toLowerCase().optional(),
    picture: z.string().url().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.email !== undefined || v.picture !== undefined, {
    message: "At least one field is required",
  });

authRoutes.patch("/me", requireAuth, zValidator("json", updateMeSchema, validationHook), async (c) => {
  const user = getUser(c);
  const body = c.req.valid("json");

  // Email collision: 409. Tenants don't share users, but globally a
  // user row is keyed on email — same address can only belong to one
  // account. Fail fast so the SPA can show "that address is in use"
  // rather than letting the UPDATE crash with a unique-constraint 500.
  if (body.email && body.email !== user.email) {
    const conflict = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", body.email)
      .where("id", "!=", user.id)
      .executeTakeFirst();
    if (conflict) {
      return c.json(
        { error: "Email is already in use", code: "EMAIL_IN_USE" },
        409,
      );
    }
  }

  const updates: Partial<{
    name: string;
    email: string;
    picture: string | null;
    emailVerified: boolean;
  }> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.picture !== undefined) updates.picture = body.picture;
  if (body.email !== undefined && body.email !== user.email) {
    updates.email = body.email;
    updates.emailVerified = false;
  }

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
});

// ── OAuth (provider-driven) ────────────────────────────────────────────────
// One pair of routes (`/:provider` + `/:provider/callback`) handles every
// provider in src/lib/oauth-providers.ts. Adding a new provider is one
// entry in that file plus matching env vars — no code change here.

function buildAuthorizeUrl(provider: OAuthProvider, state: string): string {
  const params = new URLSearchParams({
    client_id: Deno.env.get(provider.clientIdEnv)!,
    redirect_uri:
      `${Deno.env.get("APP_URL") ?? "http://localhost:8000"}/api/auth/${provider.id}/callback`,
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

  return c.redirect(buildAuthorizeUrl(provider, state));
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

  const clientId = Deno.env.get(provider.clientIdEnv)!;
  const clientSecret = Deno.env.get(provider.clientSecretEnv)!;
  const redirectUri =
    `${Deno.env.get("APP_URL") ?? "http://localhost:8000"}/api/auth/${provider.id}/callback`;

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

  const webUrl = Deno.env.get("WEB_APP_URL") ?? "http://localhost:5173";
  return c.redirect(webUrl);
});

export { authRoutes };
