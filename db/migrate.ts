/**
 * Database migration runner.
 *
 * Reads SQL files from db/migrations/ in sorted order, applies any that
 * haven't been recorded in the `schema_migrations` tracking table.
 *
 * Usage:
 *   deno run --env --allow-net --allow-env --allow-read db/migrate.ts
 *
 * Or via deno task:
 *   deno task db:migrate
 */

import postgres from "postgres";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  Deno.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const rows = await sql<{ version: string }[]>`
    SELECT version FROM schema_migrations ORDER BY version
  `;
  return new Set(rows.map((r) => r.version));
}

async function getMigrationFiles(): Promise<{ version: string; path: string }[]> {
  const migrationsDir = new URL("./migrations/", import.meta.url).pathname;
  const entries: { version: string; path: string }[] = [];

  for await (const entry of Deno.readDir(migrationsDir)) {
    if (entry.isFile && entry.name.endsWith(".sql")) {
      entries.push({
        version: entry.name.replace(/\.sql$/, ""),
        path: `${migrationsDir}${entry.name}`,
      });
    }
  }

  entries.sort((a, b) => a.version.localeCompare(b.version));
  return entries;
}

async function runMigrations() {
  console.log("Starting database migration...\n");

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  const pending = files.filter((f) => !applied.has(f.version));

  if (pending.length === 0) {
    console.log("No pending migrations.");
    await sql.end();
    Deno.exit(0);
  }

  console.log(`Found ${pending.length} pending migration(s).\n`);

  // A migration can opt OUT of the wrapping transaction by including
  // `-- @no-transaction` on its own line in the file (typically as the
  // first comment). PostgreSQL refuses certain DDL — most notably
  // `ALTER TYPE ... ADD VALUE` followed by use of the new value in the
  // same transaction (PG 55P04, "unsafe use of new value of enum
  // type") — so transactions are unsafe for those migrations. Outside
  // the wrapping tx, partial failures leave the DB in a half-applied
  // state with no ledger entry; migrations using this opt-out should
  // be idempotent (IF NOT EXISTS / IF EXISTS / ON CONFLICT) so a
  // re-run cleanly resumes.
  const NO_TRANSACTION_MARKER = /^--\s*@no-transaction\b/m;

  for (const migration of pending) {
    const content = await Deno.readTextFile(migration.path);
    const useTransaction = !NO_TRANSACTION_MARKER.test(content);

    console.log(
      `Applying: ${migration.version}${useTransaction ? "" : " (no-transaction)"}`,
    );

    try {
      if (useTransaction) {
        await sql.begin(async (tx) => {
          await tx.unsafe(content);
          await tx`
            INSERT INTO schema_migrations (version) VALUES (${migration.version})
          `;
        });
      } else {
        // No outer transaction. The migration's own statements either
        // auto-commit individually (postgres.js default for unsafe())
        // or include their own BEGIN/COMMIT. The ledger insert runs
        // separately AFTER the SQL succeeds.
        await sql.unsafe(content);
        await sql`
          INSERT INTO schema_migrations (version) VALUES (${migration.version})
        `;
      }
      console.log(`  Applied successfully.\n`);
    } catch (err) {
      console.error(`\n  Failed to apply ${migration.version}:`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}\n`);
      console.error(
        useTransaction
          ? "Migration rolled back. Fix the issue and re-run."
          : "WARNING: this migration ran without a transaction wrapper; the DB may be partially mutated. Migration files using `-- @no-transaction` MUST be idempotent so a re-run resumes cleanly.",
      );
      await sql.end();
      Deno.exit(1);
    }
  }

  console.log("All migrations applied successfully.");
  await sql.end();
  Deno.exit(0);
}

runMigrations();
