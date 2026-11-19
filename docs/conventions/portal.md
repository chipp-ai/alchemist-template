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
- **A portal link only ever signs in a portal account of the issuing
  org.** A portal account has role `viewer` and belongs to the org that
  issued the link. The rule works at three points:
  - **Issue refuses other accounts.** If the address already belongs to
    any non-viewer account, or to an account in another org, issuing
    throws `ForbiddenError` (HTTP 403). No link row is written and no
    email is sent. The existing account is not changed.
  - **Claim checks the rule again.** A link minted before this rule, or
    one whose account was later promoted or moved to another org, is dead.
    Claim returns the same ambiguous 404 as for any invalid link.
  - **The session org is the link's org**, never the account's own org.
  - A refused person signs in the normal way (the standard sign-in), not
    through a portal link.
  - **Why:** every self-signup owns an org and holds `team.invite`, so
    that person can issue portal links. Without this rule, anyone could
    mint a link for someone else's address with `sendEmail: false`, claim
    it, and take over that account. The rule works with the invariant
    above: minting never modifies an account, and it never binds a link to
    an account that is not a portal account of the issuing org.
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
