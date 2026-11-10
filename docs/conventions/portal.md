# End-user portal lane

## End-user portal lane: use it, never build a parallel portal

Two audiences, two doors. **ADMINS are invite-only** through
`src/services/invite.service.ts`: they belong to the workspace, they carry
a role, they show up in Settings. **END USERS never touch the invite
flow** -- an employee checking their own certifications, a client watching
one project, a customer tracking one order. They get a tokenized portal
link.

**When a ticket says "let employees see their own records", "give the
client a login", "send them a link to their portal", or "customers need to
check their status", issue a portal link.** Do not send them an invite, do
not add a second login form, do not build a second session mechanism, and
do not add a "customer" role. All three already exist.

| Piece | File |
|---|---|
| Service | `src/services/portal-access.service.ts` |
| Routes | `src/api/routes/portal/index.ts` |
| Table | `portal_access_tokens` (`db/migrations/20260831233923_portal_access_tokens.sql`) |
| Email kind | `portal_link` (auth-critical) in `src/services/email-kinds.ts` |
| SPA shell | `web/src/components/PortalLayout.svelte` |
| SPA pages | `web/src/routes/portal/PortalHome.svelte`, `PortalClaim.svelte` |

```
POST   /api/portal/tokens             admin   issue + email a link
GET    /api/portal/tokens             admin   list live links for the org
POST   /api/portal/tokens/:id/resend  admin   fresh link, retires the old one
DELETE /api/portal/tokens/:id         admin   revoke
POST   /api/portal/claim              PUBLIC  token -> session cookie
GET    /api/portal/me                 auth    the caller's OWN bindings only
```

Invariants:

- **Minting NEVER modifies an account that already exists.** It
  find-or-creates by email; a pre-existing admin who is also an employee
  keeps their role and their org. Downgrading them to `viewer` because
  someone issued a portal link would be a live privilege regression.
- **Only a SHA-256 of the token is stored.** A database read cannot mint a
  session. The consequence: a re-send cannot resurrect the same URL, so it
  ISSUES A FRESH LINK and retires the old one. Tell admins "resend"; the
  mechanism is a rotation, and it also retires a forwarded copy.
- **Claim is POST-only and public.** The token is the credential (same
  trust basis as `claimInvite`), so it mints a session with no OTP. A GET
  would let a mail client's link prefetch sign someone in.
- **Claim is NOT single-use.** A portal is somewhere people come back to.
  Revocation and expiry are the controls, not consumption.
- **Every service query is org-scoped in its WHERE clause** (CWE-639).
  Another workspace's id is a 404, not a cross-tenant read. The route gate
  is not the authorization check.
- **`GET /api/portal/me` is the portal's only data source.** Do not widen
  the portal home with an org-scoped read "for context".
- **The portal shell carries no admin navigation**, and portal routes are
  registered public so a lapsed session renders "ask for a new link"
  instead of bouncing an end user to the workspace sign-in form.

Adapt `subjectType` / `subjectId` to your domain: they are the record an
admin bound the link to. Join them against your own table in
`PortalHome.svelte` and render the real thing.
