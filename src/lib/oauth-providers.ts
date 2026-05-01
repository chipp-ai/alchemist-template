/**
 * OAuth provider registry.
 *
 * Adding a new provider is one entry in PROVIDERS plus matching env vars.
 * The auth routes loop over this list to register `/auth/:provider` and
 * `/auth/:provider/callback` endpoints, and `/auth/config` reports which
 * providers the deployer has configured (env-var presence is the source
 * of truth — no DB lookup, no admin UI).
 *
 * Adding GitHub Enterprise / Auth0 / Okta etc. later: add the entry,
 * route paths follow automatically.
 */

import { log } from "@/lib/logger.ts";

export interface OAuthProvider {
  /** URL slug — `/auth/<id>` and `/auth/<id>/callback`. */
  id: string;
  /** User-facing label on the Login button. */
  label: string;
  /** Brand color for the button border / icon (hex). Optional cosmetic. */
  color: string;
  /** Env var holding the OAuth client ID. Empty means not configured. */
  clientIdEnv: string;
  /** Env var holding the OAuth client secret. */
  clientSecretEnv: string;
  /** Authorization endpoint (browser redirect target). */
  authUrl: string;
  /** Token-exchange endpoint (server POST). */
  tokenUrl: string;
  /** Userinfo endpoint (server GET with bearer token). */
  userInfoUrl: string;
  /** OAuth scopes to request. */
  scopes: string;
  /**
   * Adapter from the provider's userinfo response to the canonical
   * `{ email, name?, picture?, providerUserId }` shape we persist.
   * Each provider returns slightly different field names.
   */
  // deno-lint-ignore no-explicit-any
  mapUser: (raw: any) => {
    email: string;
    name: string | null;
    picture: string | null;
    providerUserId: string;
  };
}

/**
 * The default provider registry. Set the corresponding env vars to enable
 * any provider; the routes auto-register and the Login page auto-shows
 * a button. No DB migration, no code change.
 */
export const PROVIDERS: OAuthProvider[] = [
  {
    id: "google",
    label: "Continue with Google",
    color: "#4285F4",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    scopes: "openid email profile",
    mapUser: (raw) => ({
      email: String(raw.email).toLowerCase().trim(),
      name: raw.name ?? null,
      picture: raw.picture ?? null,
      providerUserId: String(raw.id),
    }),
  },
  {
    id: "microsoft",
    label: "Continue with Microsoft",
    color: "#2F2F2F",
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    // `common` lets BOTH personal Microsoft accounts (outlook.com, etc.)
    // and any Azure AD work/school account sign in. If you want only
    // your org's tenant, replace `common` with the tenant ID.
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    scopes: "openid email profile User.Read",
    mapUser: (raw) => ({
      // Graph returns `mail` for Azure AD users and `userPrincipalName`
      // for personal accounts. Fall through.
      email: String(raw.mail ?? raw.userPrincipalName ?? "").toLowerCase().trim(),
      name: raw.displayName ?? null,
      picture: null, // Graph requires a separate /photo call; skip for v0.1
      providerUserId: String(raw.id),
    }),
  },
  {
    id: "github",
    label: "Continue with GitHub",
    color: "#181717",
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    // `read:user user:email` together cover the case where the user has
    // their email private (we then need a /user/emails fetch to recover
    // the primary verified one — see callback handler).
    scopes: "read:user user:email",
    mapUser: (raw) => ({
      email: String(raw.email ?? "").toLowerCase().trim(),
      name: raw.name ?? raw.login ?? null,
      picture: raw.avatar_url ?? null,
      providerUserId: String(raw.id),
    }),
  },
];

/**
 * The subset of providers whose env vars are actually populated at
 * runtime. /auth/config returns this — Login.svelte renders one button
 * per entry.
 */
export function getConfiguredProviders(): OAuthProvider[] {
  return PROVIDERS.filter((p) => {
    const id = Deno.env.get(p.clientIdEnv);
    const secret = Deno.env.get(p.clientSecretEnv);
    return !!(id && secret);
  });
}

export function findProvider(id: string): OAuthProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isProviderConfigured(p: OAuthProvider): boolean {
  return !!(Deno.env.get(p.clientIdEnv) && Deno.env.get(p.clientSecretEnv));
}

/**
 * GitHub-specific: the default /user response can have `email: null`
 * when the user has hidden their email. Hit /user/emails and pick the
 * primary verified address. Other providers don't need this — Google
 * and Microsoft always include email when the `email` scope is granted.
 */
export async function fetchGitHubPrimaryEmail(
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alchemist-template",
      },
    });
    if (!res.ok) return null;
    const emails = await res.json() as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const primary = emails.find((e) => e.primary && e.verified);
    return primary?.email.toLowerCase().trim() ?? null;
  } catch (err) {
    log.warn(
      "GitHub /user/emails fetch failed",
      { source: "auth", feature: "github-emails" },
      err instanceof Error ? err : new Error(String(err)),
    );
    return null;
  }
}
