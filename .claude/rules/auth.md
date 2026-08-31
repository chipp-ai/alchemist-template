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
| `app.write` | editor |
| `app.read` | viewer |

Use the `can(role, capability)` helper for inline checks; **never compare
role strings directly.** The hierarchy enforces "fail closed" for unknown
roles — `rankOf("nonexistent")` returns 0, so `can()` returns false on
schema drift.

**Manage-vs-target rules** — the `canManage(actor, target)` helper enforces:

- Owner is untouchable. Only the explicit ownership-transfer flow (deferred) can change owner.
- Admins cannot manage other admins — only the owner can. Prevents lateral demotion wars.
- Viewers and editors can never manage anyone.

The Settings → Team UI uses `canManage` to gate role-edit dropdowns and
remove buttons per-row.

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
an account that already exists. Full contract: CLAUDE.md → "End-user
portal lane: use it, never build a parallel portal".

## WebSocket auth

WS connections authenticate with a short-lived `scope: "ws"` token, NOT
the session cookie. Scope segregation is enforced both ways — see the
`api-layer` rule's Realtime section.
