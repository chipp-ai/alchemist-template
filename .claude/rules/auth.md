---
name: auth
description: Authentication + authorization — the 4-role hierarchy, requireAuth/requireCapability middleware, the can()/canManage() helpers, the invite flow, and soft-disconnect semantics. Load when touching auth, roles, permissions, or team management.
paths:
  - "src/auth/**"
  - "src/api/middleware/**"
  - "src/lib/roles.ts"
  - "web/src/lib/permissions.ts"
  - "src/api/routes/org/**"
  - "src/api/routes/invite/**"
  - "src/api/routes/auth/**"
  - "src/lib/verification-*.ts"
---

# Auth + authorization

Authoritative for authentication, the role hierarchy, and team
management. Fail closed: unknown roles get rank 0.

## Middleware

- `requireAuth` populates `c.get("user")` and `c.get("session")`. Place it before any handler that needs a logged-in user.
- `requireCapability("team.invite")` gates a route on a capability. Both live in `src/api/middleware/auth.ts`.

```typescript
import { requireAuth, requireCapability } from "@/api/middleware/auth.ts";

orgRoutes.post(
  "/invites",
  requireCapability("team.invite"),
  zValidator("json", inviteSchema, validationHook),
  handler,
);
```

## Roles

A 4-role hierarchy lives in **one** file — `src/lib/roles.ts` on the
server, mirrored EXACTLY in `web/src/lib/permissions.ts` on the client.
A regression test (`src/__tests__/team.test.ts → "client mirror"`) lints
the two files for the same capability list and roles.

| Role | Count | Powers |
|---|---|---|
| `owner` | 1 per org | Full control. Set at org creation. CANNOT be invited. |
| `admin` | N per org | Manage team (invite, change roles, remove) + edit org settings + everything an editor can do. |
| `editor` | N per org | Write app data. Cannot manage team or org settings. The default invitee role. |
| `viewer` | N per org | Read-only across the board. |

The schema enum still allows the legacy `member` value for backward compat
with rows pre-dating migration 003. `member` is a synonym for `editor` —
same rank, same capabilities. Migration 003 backfills `member` → `editor`.

## Capabilities

| Capability | Min role |
|---|---|
| `team.invite` | admin |
| `team.update_role` | admin |
| `team.remove` | admin |
| `org.update` | admin |
| `org.transfer_ownership` | owner |
| `app.write` | editor |
| `app.read` | viewer |

Use the `can(role, capability)` helper for inline checks; **never compare
role strings directly.** The hierarchy enforces "fail closed" for unknown
roles — `rankOf("nonexistent")` returns 0, so `can()` returns false on
schema drift.

**Manage-vs-target rules** — the `canManage(actor, target)` helper enforces:

- Owner is untouchable to other members. Only `POST /api/org/transfer-ownership` (owner-only) moves the owner role: the named member becomes `owner` and the caller drops to `admin` in one transaction, with the caller's demotion predicated on `role = 'owner'` so a concurrent transfer can never mint a second owner.
- Admins cannot manage other admins — only the owner can. Prevents lateral demotion wars.
- Viewers and editors can never manage anyone.

The Settings → Team UI uses `canManage` to gate role-edit dropdowns and
remove buttons per-row.

**Owner lifecycle.** Transfer-then-act is the answer to every "owner is a
dead end" request: remove an owner (transfer, then `DELETE /members/:userId`),
owner leaving (transfer, then `POST /leave`), owner switching to a new
email (change email via the verify-first flow below, or invite the new
address and transfer to it).

## Sign-in codes

The full contract is `docs/conventions/auth.md`, "Sign-in codes (OTP) contract". Two rules
every change here keeps:

- **A try cap is one statement.** Claim the try with
  `UPDATE otps SET attempts = attempts + 1 WHERE email = $1 AND expires_at > now() AND attempts < 5 RETURNING ...`
  (`claimOtpTry`) before the compare; no row back means refuse. Never read the
  count and increment it in a second query, and never delete a spent row.
- **Every route that writes `otps` uses the same limits.** send-otp and both
  email-change steps go through `issueOtp`, `enforceOtpSendLimits` and
  `enforceOtpVerifyLimit`: per address, per IP, per user. A resend never resets
  `attempts` and never moves expiry past `OTP_MAX_LIFE_MINUTES` from
  `createdAt`. Messages never say whether an account exists.

## REST routes and portal users

`requireCapability("app.read")` admits every viewer, and portal users are
viewer accounts. A REST route that returns org-wide data refuses portal
sessions (check `listPortalAccessForUser(user.id)` or scope to the bindings),
the same way a tool without `portalSafe: true` is hidden from them. The route
and its agent tool use the same capability. Every new route gets a test as a
viewer, a portal user and a user of another org.

## Role changes reach live sessions

Demotion, removal, unlink, invite accept and email change take effect on the
next request of every live session: `requireAuth` re-reads the user row, so
never trust a role or org from the JWT alone. An invite never carries a role
from another org into this one. Sign-up makes each new user the owner of a new
org of their own. If the project adds a shared org that people join, no one
becomes its admin by signing in first: name the admin by an explicit address
in env, and grant nothing when that env var is unset.

## The startup session check never 401s

`checkAuth()` (web/src/stores/auth.svelte.ts) calls `GET /auth/session`,
not `GET /auth/me`. For an anonymous visitor it answers 200
`{ user: null }`; signed in, it answers the same body as `/auth/me`. The
browser prints every 4xx fetch as a console error, so a 401 here logged an
error on every public page. Keep `/auth/me` at 401 for callers that need a
hard auth check. Test: `src/__tests__/routes/auth-session.test.ts`.

## Email change is verify-first

`PATCH /auth/me` does NOT accept `email`. The address changes only via
`POST /auth/me/email-change` (sends a 6-digit code to the NEW address)
followed by `POST /auth/me/email-change/confirm` (verifies the code, swaps
the address, re-issues the session cookie). Rationale: on an OTP-login app
an unverified swap to a typo'd address locks the user out, and lets a
stolen session cookie durably rebind the account. A regression test in
`src/__tests__/team.test.ts` forbids `email:` from growing back into
`updateMeSchema`.

## Invite flow

```
POST   /api/org/invites              → admin creates invite (sends email)
GET    /api/org/invites              → admin lists pending invites
DELETE /api/org/invites/:id          → admin revokes a pending invite
PATCH  /api/org/members/:userId/role → admin changes role
DELETE /api/org/members/:userId      → admin SOFT-DISCONNECTS member

GET    /api/invite/:token            → public preview (no auth)
POST   /api/invite/:token/accept     → consume token (auth required;
                                       authenticated email must match invite email)
```

Frontend route: `/#/invite/:token` → `web/src/routes/InviteAccept.svelte`.

**CRITICAL: removing a member is SOFT-DISCONNECT, not hard-delete.** The
`DELETE /members/:userId` route sets `users.organization_id = NULL` and
`role = 'viewer'`. The user row is preserved — sessions, oauth bindings,
and FK'd domain data persist. Re-inviting lands cleanly via the same flow.
A regression test (`src/__tests__/team.test.ts`) lints the route for
`organizationId: null` and forbids `db.deleteFrom("users")`.

Invite emails go through `src/services/email.ts → sendInviteEmail`, which
routes through the `invite` email kind. With no SMTP the send is captured
to the dev mailbox (`GET /api/dev/mailbox`) and logged to console, so the
accept URL is grabbable during local testing. `APP_URL` determines the
link host.

## Invites are for ADMINS. End users get a portal link.

The invite flow above is the door for people who BELONG to the workspace:
they carry a role, they appear in Settings, they can be promoted. An
employee checking their own certifications, a client watching one project,
or a customer tracking one order is NOT that. Issuing them an invite gives
away a workspace seat to answer a read-only question.

Those people go through the portal lane instead:
`src/services/portal-access.service.ts` and `src/api/routes/portal/`. An
admin issues a tokenized link bound to one record and one address; the
recipient clicks it and lands in a read-only portal with no admin
navigation. Minting auto-provisions a `viewer` account and NEVER modifies
an account that already exists. Full contract: `docs/conventions/portal.md` → "End-user
portal lane: use it, never build a parallel portal".

## WebSocket auth

WS connections authenticate with a short-lived `scope: "ws"` token, NOT
the session cookie. Scope segregation is enforced both ways — see the
`api-layer` rule's Realtime section.

## Platform verification sessions (read-only, platform-signed)

The Alchemist platform verifies deployed changes in a real browser. Login
here is by emailed code, which an automated verifier cannot receive, so the
platform signs a short-lived token and trades it at
`POST /api/auth/verification-session` for a session on a dedicated
verification account.

- **Off unless the platform injected `ALCH_VERIFICATION_SESSION_SECRET` and
  `PROJECT_ID`.** Without both the route 404s. Never set the secret by hand.
- **Single-use, project-bound token.** Every claim is checked in
  `src/lib/verification-session-token.ts`; the jti is burned in the
  `verification_sessions` table (also the audit log) before a session exists.
- **Read-only everywhere.** The minted JWT carries a `vrf` claim, and
  `verificationReadOnlyGuard` (mounted in `app.ts` before every route)
  answers 403 to any POST/PUT/PATCH/DELETE from it. Do not add a write
  exemption; logout is the only one.
- **Dedicated accounts, never real users.** `src/lib/verification-accounts.ts`
  keeps one user per role (`admin`, `editor`, `viewer`; `member` maps to
  `editor`; never `owner`) in its own "Alchemist verification" org, at
  `@verification.invalid` addresses that cannot sign in by email code.
- **Custom personas.** If your app derives a persona from extra rows (a
  `students` row makes a student), extend `provisionVerificationAccount` to
  create that row for the matching role and add the role to
  `VERIFICATION_ROLES`. Keep the account in the verification org.

## Agent tokens (embedded Chipp agent)

The embedded agent calls `POST /api/agent-mcp` with a 15-minute
`scope: "agent"`, `aud: "chipp-embed"` token from `mintAgentToken`
(`src/services/agent-tools/agent-token.ts`), never with the session cookie.
`requireAgentAuth` (`src/api/middleware/agent-auth.ts`) verifies it and then
runs the same `resolveUser` as `requireAuth`, so the current role, the
current org and logout-all apply. The session verifier refuses any token
that carries a `scope` or an `aud`, so neither an agent token nor a WS token
works as a session. Agent tokens need `JWT_SECRET`; there is no
development fallback. Tool rules: `docs/conventions/embedded-agent.md`, "Embedded agent tools".
