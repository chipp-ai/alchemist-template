---
name: database
description: Database conventions — Postgres extensions, Kysely + CamelCasePlugin, migration filenames, and query-safety rules. Load when writing migrations or any DB query.
paths:
  - "db/**"
  - "src/db/**"
  - "src/services/**.service.ts"
---

# Database conventions

These rules are authoritative for anything under `db/` and any Kysely
query. When they conflict with your training-data defaults, these win.

## Available Postgres extensions

Every Alchemist customer app runs against Postgres with the SAME extension
set across local dev, CI, and production. Don't ask "is this available
here" — the answer is yes everywhere.

| Extension | Purpose | Use when |
|---|---|---|
| `pgcrypto` | `crypt()`, `gen_random_uuid()`, `digest()` | UUID defaults, password hashing, server-side hashes |
| `uuid-ossp` | `uuid_generate_v4()`, related uuid helpers | UUID defaults (legacy code; prefer `gen_random_uuid()` for new tables — it's in PG core too) |
| `vector` (pgvector) | `vector(N)` column type + cosine/L2/inner-product operators + IVFFlat/HNSW indexes | Embeddings, semantic search, RAG retrieval |
| Full standard contrib | `citext`, `btree_gin`, `btree_gist`, `pg_trgm`, `hstore`, `intarray`, `ltree`, `tablefunc`, … | Reach for these before adding deps |

**In your migrations:**

- **DON'T** `CREATE EXTENSION ...` — the per-tenant DB user doesn't have privileges to. The platform admin installs extensions in the shared DB once; customers just USE them.
- **DO** use extension features directly: `CREATE TABLE embeddings (id UUID DEFAULT gen_random_uuid(), embedding vector(1536))`.
- **For vector indexes** the common pattern is HNSW: `CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops);`.

## Kysely + CamelCasePlugin

The CamelCasePlugin transforms identifiers at runtime -- you write
**camelCase everywhere in Kysely builders** (SELECT, WHERE, ORDER BY, ON,
`.values()`, `.set()`, `onConflict`), and the plugin emits snake_case SQL.
The TypeScript table types in `src/db/schema.ts` are camelCase, so a
snake_case reference like `.where("organization_id", ...)` is a TYPE ERROR
under `deno task check` -- don't write it.

```typescript
// SELECT
const user = await db
  .selectFrom("users")
  .select(["id", "email", "createdAt"])   // camelCase
  .where("organizationId", "=", orgId)    // camelCase in WHERE too
  .orderBy("createdAt", "desc")           // camelCase in ORDER BY too
  .executeTakeFirst();

// INSERT -- camelCase in values
await db
  .insertInto("users")
  .values({ email, name, organizationId: orgId })  // camelCase
  .execute();
```

The ONE place snake_case appears is raw SQL strings (`sql\`...\``
templates and migration files) -- those bypass the query builder, so you
write the real column names. Raw `sql<...>` template RESULTS still go
through CamelCasePlugin -- raw SQL row results are camelCase at runtime.
Reading snake_case off them yields `undefined` and silently breaks.

## Migrations

- Files: `db/migrations/<YYYYMMDDHHMMSS>_description.sql` — a **UTC timestamp** prefix (get it with `date -u +%Y%m%d%H%M%S`), sorted lexically (= chronological). **Do NOT use sequential integers (`NNN_`).** Two tickets branching from the same commit both pick the same "next" integer and land COLLIDING migrations — they don't git-conflict (different slugs) but break the unique-ordering contract, and a prefix collision crash-loops the pod entrypoint. Timestamps never collide across concurrent branches.
- **All migrations must be backward-compatible** with currently running code (expand/contract pattern).
- Run: `deno task db:migrate`. Migrations run automatically in CI before deploy.
- Each migration runs in a transaction — if it fails, it rolls back.
- Never put DML (`UPDATE`) in the same migration as `ALTER TYPE ... ADD VALUE` (PostgreSQL limitation).

## Query safety

- **`withTimeout(ms, fn)`** for all Kysely queries — prevents pool starvation during DB contention.
- **`raceTimeout(ms, promise)`** for raw `postgres.js` queries when you need snake_case result keys.
- **`countAll()` returns a string** — always wrap with `Number()`.
- **Never `JSON.stringify()` for Kysely JSONB** — pass objects directly to `.set()` / `.values()`. Stringify double-encodes.
- **JSONB columns return as strings from SELECT** — always `JSON.parse()` before using. Never cast directly.
- **Guard `whereIn()` against empty arrays** — `WHERE column IN ()` is a PostgreSQL syntax error. Always check `if (ids.length === 0) return [];` before the query.
- **`isTransientDbError(err)`** — use in catch blocks to downgrade connection resets and pool timeouts to `log.warn` instead of `log.error`.
