# Organization model

Created by `db/migrations/001_initial_schema.sql`; typed in
`src/db/schema.ts`.

## Shape

- `organizations`: the tenant and billing entity. `subscription_tier`,
  `stripe_customer_id`, `stripe_subscription_id`, `credits_exhausted` and the
  `subscription_*` dates are what billing reads.
- `users`: one row per person, exactly one organization
  (`organization_id`). `role` is one of `owner`, `admin`, `editor`,
  `viewer` (`src/lib/roles.ts`); unknown roles rank 0 and fail closed.
  `oauth_provider` / `oauth_id` link a social login; `email_verified` is set
  by OTP and OAuth login; `email` is unique.
- Team changes (`invites`, role edits, ownership transfer, soft disconnect)
  are documented in `.claude/rules/auth.md`.

## What keys off it

- The session: `requireAuth` loads `id`, `email`, `organizationId` and `role`
  from `users` on every request (`src/api/middleware/auth.ts`). A user with
  no `organization_id` gets no session.
- Authorization: `can(role, capability)` and `canManage(actor, target)` in
  `src/lib/roles.ts`. Never compare role strings directly.
- Data scoping: every tenant table carries `organization_id` (see
  `docs/agent-guidance/tenant-scope.md`).

## Extending

- Add a column to `users` or `organizations` in a new timestamped migration,
  nullable or with a default, and add it to `src/db/schema.ts` in the same
  change. Do not edit `001_initial_schema.sql`.
- Do not add a second membership table or a many-to-many org model without a
  product decision: the session, roles, billing and every scoped query assume
  one organization per user.
- A new role goes in `ROLES` and `CAPABILITY_MIN_ROLE` in `src/lib/roles.ts`
  plus a migration that extends the `user_role` enum (no DML in that same
  migration, a Postgres limit on `ALTER TYPE ... ADD VALUE`).
