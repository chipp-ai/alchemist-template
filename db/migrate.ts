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

/**
 * Split a SQL migration into top-level statements, respecting:
 *   - single-quoted strings ('...'), including doubled '' escapes
 *   - dollar-quoted strings ($$ ... $$ and $tag$ ... $tag$)
 *   - line comments (-- ... to EOL)
 *   - block comments (/* ... *\/ — non-nested)
 *
 * Returns the SQL split on `;` at the top level (not inside the above).
 * Empty / comment-only chunks are filtered out so postgres.js doesn't
 * see a stray empty query.
 *
 * Intentionally NOT a full SQL parser — only `@no-transaction`
 * migrations go through this, and they need to keep each statement
 * isolated from the next so PG autocommits between them.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment: skip to end of line
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        current += sql[i];
        i++;
      }
      continue;
    }

    // Block comment: skip to */
    if (ch === "/" && next === "*") {
      current += "/*";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        current += sql[i];
        i++;
      }
      if (i < sql.length) {
        current += "*/";
        i += 2;
      }
      continue;
    }

    // Single-quoted string: read until matching ' (with '' as escape)
    if (ch === "'") {
      current += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        current += sql[i];
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty)
    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        current += tag;
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          // Unterminated dollar-quote: append remainder and bail.
          current += sql.slice(i);
          i = sql.length;
        } else {
          current += sql.slice(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }

    // Statement terminator at top level
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  // Trailing statement with no terminating ';'
  const tail = current.trim();
  if (tail) statements.push(tail);
  // Drop pure-comment chunks (only -- or /* */ left after trimming)
  return statements.filter((s) => /[^\s\-/*]/.test(s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")));
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
        // No outer transaction. CRITICAL: split the migration text
        // into individual statements and execute each separately —
        // postgres.js's `unsafe(content)` sends a multi-statement
        // batch via the simple query protocol, which PG treats as
        // ONE implicit transaction even without an explicit BEGIN.
        // That breaks the canonical use case for `@no-transaction`:
        // `ALTER TYPE ... ADD VALUE 'x'` followed by a statement
        // referencing 'x' fails with PG 55P04 ("unsafe use of new
        // value of enum type") because the new enum value isn't
        // committed yet. Splitting + calling unsafe() per statement
        // gives each one its own PG message → its own implicit txn
        // → autocommits before the next one runs.
        //
        // Idempotency is still the migration author's responsibility
        // (a mid-file crash leaves the DB partially mutated with no
        // ledger entry); both 003 + future enum-add migrations are
        // expected to guard every statement with IF NOT EXISTS /
        // WHERE clauses so a re-run resumes cleanly.
        const statements = splitSqlStatements(content);
        for (const stmt of statements) {
          await sql.unsafe(stmt);
        }
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
