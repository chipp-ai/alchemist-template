# Tenant scope: every query carries the organization id

The tenant unit is the organization (`organizations` table). Every user
belongs to exactly one (`users.organization_id`). Tenant data is safe only
when each query filters by the caller's organization id.

## Where the scope comes from

- Server side, the scope is `getUser(c).organizationId` (or
  `c.get("organizationId")`), set by `requireAuth` in
  `src/api/middleware/auth.ts`. `requireAuth` re-reads the user row, so the
  id is current, not whatever the JWT said at login.
- Never take an organization id, tenant id or owner id from the request body,
  query string or path and use it as the scope. A client-supplied id is only
  a lookup key; the WHERE clause still binds the session's organization.

## Adding a tenant-scoped table

1. Migration in `db/migrations/<UTC timestamp>_<slug>.sql` (see
   `.claude/rules/database.md`). Add `organization_id UUID NOT NULL
   REFERENCES organizations(id) ON DELETE CASCADE` and an index on it.
   Unqualified table names: the runner's search_path puts them in the
   project's own schema.
2. Kysely type in `src/db/schema.ts` (camelCase `organizationId`).
3. Every service method that reads or writes the table takes
   `organizationId` as a parameter and puts it in its WHERE clause, including
   update-by-id and delete-by-id. A row from another organization then reads
   as "not found" (404), never as someone else's data.

```typescript
export async function getInvoice(organizationId: string, id: string) {
  return await db.selectFrom("invoices")
    .where("id", "=", id)
    .where("organizationId", "=", organizationId) // never optional
    .selectAll()
    .executeTakeFirst();
}
```

## What does NOT count as authorization

- A tier, plan or capability check (`requireCapability`, an entitlement gate)
  says what a caller may do, not whose rows they may touch (CWE-862).
- A route-level check alone. The service must scope its own query, because
  the next caller of that service may forget (CWE-639).

## Schema changes

Expand/contract only: add a column or table in one deploy, stop reading the
old shape in the next, drop it later. Old pods keep serving during a rolling
deploy, so a migration must work with the code that is already running.
