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
  buildSalesforceProvider(Deno.env.get("SALESFORCE_LOGIN_URL")),
  ...oidcProviderEntries(Deno.env.toObject()),
];

/**
 * Salesforce. Enable with SALESFORCE_CLIENT_ID + SALESFORCE_CLIENT_SECRET
 * (a Salesforce Connected App with the OAuth "openid email profile" scopes
 * and the callback URL registered). Sandbox orgs authenticate against
 * test.salesforce.com instead of login.salesforce.com: set
 * SALESFORCE_LOGIN_URL=https://test.salesforce.com for those.
 *
 * Exported as a pure builder so tests can exercise the base-URL override
 * without mutating process env.
 */
export function buildSalesforceProvider(loginUrl?: string): OAuthProvider {
  const base = (loginUrl?.trim() || "https://login.salesforce.com").replace(/\/+$/, "");
  return {
    id: "salesforce",
    label: "Continue with Salesforce",
    color: "#00A1E0",
    clientIdEnv: "SALESFORCE_CLIENT_ID",
    clientSecretEnv: "SALESFORCE_CLIENT_SECRET",
    authUrl: `${base}/services/oauth2/authorize`,
    tokenUrl: `${base}/services/oauth2/token`,
    userInfoUrl: `${base}/services/oauth2/userinfo`,
    scopes: "openid email profile",
    mapUser: (raw) => ({
      email: String(raw.email ?? "").toLowerCase().trim(),
      name: raw.name ?? null,
      picture: raw.picture ?? null,
      // Salesforce userinfo returns `user_id` plus a standard OIDC `sub`.
      providerUserId: String(raw.user_id ?? raw.sub ?? ""),
    }),
  };
}

/**
 * Generic OIDC slot: covers Keycloak, Okta, Auth0, Azure AD single-tenant,
 * and any other spec-compliant IdP WITHOUT a code change. The entry only
 * exists when the three endpoint env vars are set (they are per-deployment
 * values, so there is nothing sensible to default them to):
 *
 *   OIDC_AUTH_URL      authorization endpoint (browser redirect)
 *   OIDC_TOKEN_URL     token endpoint (server POST)
 *   OIDC_USERINFO_URL  userinfo endpoint (server GET, bearer)
 *   OIDC_CLIENT_ID / OIDC_CLIENT_SECRET   the client credentials
 *   OIDC_LABEL         optional button label (default "Continue with SSO")
 *   OIDC_SCOPES        optional scopes (default "openid email profile")
 *
 * Endpoint recipes (also in CLAUDE.md → "Social login / SSO is prebuilt"):
 *   Keycloak:  <issuer>/protocol/openid-connect/{auth,token,userinfo}
 *              where issuer = https://<host>/realms/<realm>
 *   Okta:      https://<domain>/oauth2/default/v1/{authorize,token,userinfo}
 *   Auth0:     https://<domain>/{authorize,oauth/token,userinfo}
 *
 * Pure function over an env snapshot so it is unit-testable; the module
 * calls it once at load with the real env (env is static per deployment).
 */
export function oidcProviderEntries(
  env: Record<string, string | undefined>,
): OAuthProvider[] {
  const authUrl = env.OIDC_AUTH_URL?.trim();
  const tokenUrl = env.OIDC_TOKEN_URL?.trim();
  const userInfoUrl = env.OIDC_USERINFO_URL?.trim();
  if (!authUrl || !tokenUrl || !userInfoUrl) return [];
  return [{
    id: "oidc",
    label: env.OIDC_LABEL?.trim() || "Continue with SSO",
    color: "#5C6BC0",
    clientIdEnv: "OIDC_CLIENT_ID",
    clientSecretEnv: "OIDC_CLIENT_SECRET",
    authUrl,
    tokenUrl,
    userInfoUrl,
    scopes: env.OIDC_SCOPES?.trim() || "openid email profile",
    mapUser: (raw) => ({
      // Standard OIDC userinfo claims. `preferred_username` covers IdPs
      // (some Keycloak realms) that omit `name`.
      email: String(raw.email ?? "").toLowerCase().trim(),
      name: raw.name ?? raw.preferred_username ?? null,
      picture: raw.picture ?? null,
      providerUserId: String(raw.sub ?? ""),
    }),
  }];
}

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
