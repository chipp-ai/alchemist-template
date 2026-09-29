# Auth: OTP login, OAuth providers, sessions

Auth is already wired. Do not write a new login path.

## What exists

- Email OTP login, always on: `POST /api/auth/send-otp` then
  `POST /api/auth/verify-otp` (`src/api/routes/auth/index.ts`).
- OAuth providers, opt-in by env var: `src/lib/oauth-providers.ts`. Setting a
  provider's `<PROVIDER>_CLIENT_ID` + `<PROVIDER>_CLIENT_SECRET` registers
  `/api/auth/<id>` and `/api/auth/<id>/callback` and shows the button on the
  Login page through `GET /api/auth/config`. A generic OIDC slot covers
  Keycloak, Okta, Auth0 and similar (`OIDC_*` vars). Full table: the "Social
  login / SSO is PREBUILT" section of `CLAUDE.md`.
- Sessions: an HttpOnly JWT cookie signed with the platform-injected
  `JWT_SECRET`.
- Route guards in `src/api/middleware/auth.ts`: `requireAuth` (sets the user
  and organization on the context), `getUser(c)`, `requireCapability(cap)`.
  Roles and capabilities: `.claude/rules/auth.md`.

## Rules

- Gate a protected route with `requireAuth` and read the caller with
  `getUser(c)`. Never parse the cookie or the JWT yourself.
- To enable a provider, request its client id and secret through the platform
  credential-request flow, naming the exact callback URL
  (`${APP_URL}/api/auth/<id>/callback`) and scopes. Never put a client secret
  in code, a ticket, a commit or a doc, and never ship a placeholder value.
- A provider that does not fit the OIDC slot gets ONE new entry in
  `src/lib/oauth-providers.ts`, following the existing entries and
  `src/__tests__/oauth-providers.test.ts`. Never a parallel auth route.
