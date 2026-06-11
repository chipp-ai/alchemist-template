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

The CamelCasePlugin transforms column names:
- **In SELECT results:** snake_case columns become camelCase properties (`created_at` -> `createdAt`)
- **In WHERE, ORDER BY, ON:** Use the original **snake_case** column names
- **In INSERT/UPDATE `.set()` and `.values()`:** Use **camelCase** property names

```typescript
// SELECT -- camelCase in results
const user = await db
  .selectFrom("app.users")
  .select(["id", "email", "createdAt"])   // camelCase
  .where("organization_id", "=", orgId)   // snake_case in WHERE
  .orderBy("created_at", "desc")          // snake_case in ORDER BY
  .executeTakeFirst();

// INSERT -- camelCase in values
await db
  .insertInto("app.users")
  .values({ email, name, organizationId: orgId })  // camelCase
  .execute();
```

Raw `sql<...>` templates STILL go through CamelCasePlugin — raw SQL row
results are camelCase at runtime. Reading snake_case off them yields
`undefined` and silently breaks.

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
