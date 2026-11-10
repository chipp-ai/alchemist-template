# Sign-in codes and social login

## Sign-in codes (OTP) contract

Email sign-in codes follow one contract. It landed in commit 16645bb. The
code is in `src/api/routes/auth/index.ts`; the email copy is the `otp` kind in
`src/services/email-kinds.ts`. Read this before you touch any of it.

- **One live code per address.** `POST /api/auth/send-otp` reuses the live,
  unspent code for the address (`issueOtp`) and keeps its try count. It never deletes a live
  code and mints a new one. The reason: people press Resend while a slow mail
  gateway still holds the first email. When every send killed the old code, the
  email the person finally opened held a dead code, and sign-in failed in a
  loop. With one live code, every email in the inbox works. A new code is
  minted only when no live code is left (none, expired, or spent).
- **Codes live 30 minutes, and never more than 60 from minting.** `OTP_TTL_MINUTES`
  is 30, and the email copy says "30 minutes". Change both together. A resend
  moves the live code's expiry to 30 minutes from now, capped at
  `OTP_MAX_LIFE_MINUTES` (60) after its `createdAt`. Without the cap, anyone who
  saw a code once could keep it alive forever by asking for a resend.
- **Every route that writes or checks `otps` is limited** (`OTP_LIMITS`):
  10 code emails per address per 15 minutes, one bucket shared by send-otp and
  the email-change request; 30 sends and 50 checks per client IP; 10
  email-change requests per signed-in user. The IP is `clientIp()` from
  `src/lib/client-ip.ts` (Cloudflare's `cf-connecting-ip`, never
  `X-Forwarded-For`); with no edge IP the per-IP limit is skipped rather than
  shared by everyone. The limiter is `rateLimit` in `src/lib/redis.ts` and fails
  open, so a Redis outage never blocks sign-in; the hard limit is the try cap in
  Postgres. Past a limit the route answers 429 (`RATE_LIMITED`) with a plain
  message. A new route that mints or checks a code calls
  `enforceOtpSendLimits` / `enforceOtpVerifyLimit` and goes through
  `issueOtp` / `claimOtpTry`.
- **`POST /api/auth/verify-otp` is forgiving about input.** It strips every
  non-digit from the pasted code ("123 456" works) and then needs exactly six
  digits. It checks every live row for the address, so a code left over from an
  older deploy still works.
- **It gives three distinct messages, never a bare "Invalid code".** Expired:
  "That code has expired...". Did not match: "That code doesn't match..." with
  the tries left. Out of tries: "Too many wrong tries..." (or "no tries left"
  on the last miss). Each one tells the person to tap Resend code when that
  helps.
- **5 wrong tries spend a code** (`OTP_MAX_ATTEMPTS`). A spent code stops
  working, even if the right digits come next. The next send mints a new one.
- **The try limit holds under parallel guesses.** Every guess (verify-otp and
  the email-change confirm) first claims a try with `claimOtpTry`, one statement, `UPDATE otps SET attempts = attempts + 1 WHERE ...
  AND attempts < OTP_MAX_ATTEMPTS RETURNING ...`, and only a guess that got a
  row back is compared. Never read the count and then increment it in a
  second query: parallel guesses all read the same count and slip past the
  limit. A right guess consumes its row with `DELETE ... WHERE id = ...
  RETURNING`, so only one request signs in on a code.
- **A refused guess never deletes a code.** The row holds the try count, so
  deleting it on a spent or expired guess resets the limit. A spent row stays
  until the next send replaces it or it expires.
- **The code is only in the email body.** The `otp` subject is "Your <App>
  verification code", never the digits: subjects are logged and shown on lock
  screens. The transport logs a message's `kind`, never its subject or body,
  and its no-SMTP console fallback prints the body only outside production.
  Guard: `src/__tests__/routes/auth-otp-email-privacy.test.ts`.
- **The client keeps the server's words.** `web/src/lib/api.ts` keeps the
  server's message on a 401 (`extractErrorMessage`) and falls back to
  "Unauthorized" only when the body has none. Do not replace it with a fixed
  string: that hid why a code was refused.
- **Login and Signup say the code is the same in every email.** The resend
  message in `web/src/routes/Login.svelte` and `web/src/routes/Signup.svelte`
  reads "The code is the same in every email, so any of them works." Keep that
  line true and keep it in both forms.

**Do not reintroduce the old shape:** delete every code for the address, then
insert a new one with a 10 minute life. It breaks Resend on slow mail, and
10 minutes is too short for gateways that hold mail.

The guards are `src/__tests__/routes/auth-otp-resend.test.ts` (reuse on
resend, the first email still working after resends, the 30 minute window and
its extension, the expired message, tries left and spent codes, legacy rows,
parallel wrong guesses, a spent code keeping its count, parallel right guesses
signing in once) and `src/__tests__/routes/auth-otp-abuse.test.ts` (the
email-change confirm under parallel guesses, a resend keeping the try count,
the 60 minute cap, every 429 limit through `_setAuthRateLimiterForTest`).

The email-change routes (`POST /api/auth/me/email-change` and `/confirm`) follow
this same contract: same code reuse, same limits, same atomic try claim.

## Social login / SSO is PREBUILT — enable with env vars, never rebuild it

The template ships a complete, flag-gated social-login experience. When a builder asks for "sign in with Google" (or Microsoft, GitHub, Salesforce, Keycloak, Okta, Auth0, any OIDC IdP), the answer is env vars + a credential request, NOT new code. Do not write OAuth routes, do not add login buttons, do not touch the session layer.

How it works (`src/lib/oauth-providers.ts` + `src/api/routes/auth/index.ts` + `web/src/routes/Login.svelte`):

- Email OTP login is always-on (the platform injects SMTP creds). OAuth providers are opt-in per deployment.
- Setting a provider's env-var pair auto-registers `/api/auth/<id>` + `/api/auth/<id>/callback` and auto-shows its button on the Login page via `/auth/config`. Nothing else to wire.
- The callback finds-or-creates the user by email, links the OAuth identity (`users.oauthProvider`/`oauthId`), marks the email verified, and issues the normal session. Provider switching on the same email is allowed.

| Provider | Enable with | Notes |
|---|---|---|
| Google | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | offline access + consent prompt already set |
| Microsoft | `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET` | `common` tenant: personal + any work/school account |
| GitHub | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | private-email recovery via /user/emails is handled |
| Salesforce | `SALESFORCE_CLIENT_ID` + `SALESFORCE_CLIENT_SECRET` | sandbox orgs: also set `SALESFORCE_LOGIN_URL=https://test.salesforce.com` |
| Any OIDC IdP (Keycloak / Okta / Auth0 / Azure AD single-tenant / ...) | `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` + `OIDC_AUTH_URL` + `OIDC_TOKEN_URL` + `OIDC_USERINFO_URL` (optional `OIDC_LABEL`, `OIDC_SCOPES`) | endpoint recipes below |

OIDC endpoint recipes:

- Keycloak (issuer `https://<host>/realms/<realm>`): `<issuer>/protocol/openid-connect/auth`, `.../token`, `.../userinfo`
- Okta: `https://<domain>/oauth2/default/v1/authorize`, `.../v1/token`, `.../v1/userinfo`
- Auth0: `https://<domain>/authorize`, `https://<domain>/oauth/token`, `https://<domain>/userinfo`

The redirect/callback URL is `<origin>/api/auth/<provider-id>/callback`, where `<origin>` is the host the sign-in started on (`requestAppOrigin()` in `src/services/app-links.ts`). An app with a connected custom domain answers on both `https://<id>.on.chipp.ai` and the custom domain (the platform lists both in `ALCHEMIST_PUBLIC_HOSTS`), so the builder registers BOTH callback URLs in their IdP console. A provider that allows only one (a GitHub OAuth App) gets the canonical `${APP_URL}` one, and sign-in with it works from that host.

Getting the credentials: the client id/secret belong to the BUILDER's own IdP tenancy (their Google Cloud project, Azure app registration, Salesforce Connected App, Keycloak realm client). Request them through the platform credential-request flow (`request_human_input` / credential invite) with the exact callback URL and required scopes named in the request; the values are applied to the deployment env by the platform. NEVER paste client secrets into code, tickets, commit messages, or docs, and never invent placeholder values that ship.

If a ticket asks for a provider that genuinely does not fit the generic OIDC slot (e.g. Apple's JWT-based client secret, SAML-only IdPs), add ONE registry entry mirroring the existing pattern in `src/lib/oauth-providers.ts` (see `src/__tests__/oauth-providers.test.ts`) rather than building a parallel auth path.
