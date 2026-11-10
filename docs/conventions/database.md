# Database conventions

## Database Conventions

> **Detailed database rules live in `.claude/rules/database.md`** (Postgres
> extensions, Kysely + CamelCasePlugin, migration filenames, query safety).
> They auto-load when you touch `db/**` or a `*.service.ts`. The essentials:
> never `CREATE EXTENSION` (the platform installs them); migrations use a
> `YYYYMMDDHHMMSS_` UTC-timestamp prefix, never sequential integers; CamelCase
> in SELECT results + INSERT values, snake_case in WHERE/ORDER BY.

## JSONB: never pass a pre-stringified value as a parameter

postgres.js serializes parameters per the SERVER-declared type: a jsonb-bound
parameter is JSON-serialized by the CLIENT, so `JSON.stringify(x)` double-encodes
into a jsonb string scalar, and an explicit `::jsonb` cast does NOT parse it
back. The corruption is invisible to tolerant readers and detonates only on
SQL-level structural ops (`||` append, `@>` containment, `->` extraction).

Rules (inherited from the chipp-deno 2026-07-28 audit: 62 columns / ~1.9M rows
corrupted platform-side by exactly this):

1. Pass the JS object/array directly as the parameter. In raw `sql` templates
   use `sql.json(value)`. NEVER `JSON.stringify` a value bound to a jsonb
   column, with or without a `::jsonb` cast.
2. Every NEW jsonb column must ship `CHECK (jsonb_typeof(col) <> 'string')`
   in the migration that creates it, so a double-encoding write fails loudly
   at write time instead of corrupting silently. Pre-existing columns are
   covered by the `jsonb_no_string_scalars` migration.
3. Only skip the CHECK when the column legitimately stores bare JSON string
   scalars, and say why in a comment next to the column.
