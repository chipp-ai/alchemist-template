/**
 * Canonical database migration runner — single source of truth.
 *
 * Customer projects' `db/migrate.ts` is a thin shim that HTTP-imports
 * this file from `chipp-ai/alchemist-template`'s default branch. The
 * shim passes in `migrationsDir` resolved against its OWN import.meta.url
 * (so the runner reads the CUSTOMER's local SQL files, not files from
 * the GitHub URL we were imported from).
 *
 * Why HTTP import vs. vendor:
 *   - Customer projects get scaffolded ONCE at project-creation time
 *     (POST /repos/:template/generate). Anything in their repo at that
 *     moment is frozen — template updates don't propagate unless the
 *     customer pulls them in or re-clones. The migration RUNNER has no
 *     reason to be customer-customizable (customers add migration FILES
 *     in db/migrations/, not changes to the runner itself), so hoisting
 *     it to a stable HTTP source is the right tradeoff: customers no
 *     longer carry stale runner code, and a fix here (or via Deno cache
 *     reload / customer-runtime image rebuild) reaches every customer.
 *
 * Why this file is named `_runner.ts` not `migrate.ts`:
 *   - `db/migrate.ts` is the entry point customers invoke via
 *     `deno task db:migrate`. Keeping the entry filename and pushing
 *     the implementation to a sibling underscored file (`_runner.ts`)
 *     follows the convention of "private to this directory" while
 *     letting the shim resolve `import.meta.url` against the customer's
 *     local path for migration discovery.
 */

import postgres from "postgres";

export interface RunMigrationsOptions {
  /** Absolute path to the directory containing `NNN_*.sql` migration files. */
  migrationsDir: string;
  /**
   * Optional override for DATABASE_URL. Defaults to the env var of the
   * same name. Exposed for tests; production calls leave it unset.
   */
  databaseUrl?: string;
}

/**
 * Split a SQL migration into top-level statements, respecting:
 *   - single-quoted strings ('...'), including doubled '' escapes
 *   - dollar-quoted strings ($$ ... $$ and $tag$ ... $tag$)
 *   - line comments (-- ... to EOL)
 *   - block comments (slash-star ... star-slash — non-nested)
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
  return statements.filter((s) =>
    /[^\s\-/*]/.test(
      s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""),
    )
  );
}

const NO_TRANSACTION_MARKER = /^--\s*@no-transaction\b/m;

/**
 * Apply all pending SQL migrations in `migrationsDir`. Throws on any
 * failure (after logging) — callers handle the exit code so this
 * function can be unit-tested without process-killing side effects.
 */
export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<void> {
  const databaseUrl = options.databaseUrl ?? Deno.env.get("DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log("Starting database migration...\n");

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const appliedRows = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const applied = new Set(appliedRows.map((r) => r.version));

    const files: { version: string; path: string }[] = [];
    for await (const entry of Deno.readDir(options.migrationsDir)) {
      if (entry.isFile && entry.name.endsWith(".sql")) {
        files.push({
          version: entry.name.replace(/\.sql$/, ""),
          path: `${options.migrationsDir}${entry.name}`,
        });
      }
    }
    files.sort((a, b) => a.version.localeCompare(b.version));

    const pending = files.filter((f) => !applied.has(f.version));

    if (pending.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    console.log(`Found ${pending.length} pending migration(s).\n`);

    for (const migration of pending) {
      const content = await Deno.readTextFile(migration.path);
      const useTransaction = !NO_TRANSACTION_MARKER.test(content);

      console.log(
        `Applying: ${migration.version}${
          useTransaction ? "" : " (no-transaction)"
        }`,
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
          // Idempotency is the migration author's responsibility — a
          // mid-file crash leaves the DB partially mutated with no
          // ledger entry, so every statement should guard with
          // IF NOT EXISTS / WHERE clauses so a re-run resumes cleanly.
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
        console.error(
          `  ${err instanceof Error ? err.message : String(err)}\n`,
        );
        console.error(
          useTransaction
            ? "Migration rolled back. Fix the issue and re-run."
            : "WARNING: this migration ran without a transaction wrapper; the DB may be partially mutated. Migration files using `-- @no-transaction` MUST be idempotent so a re-run resumes cleanly.",
        );
        throw err;
      }
    }

    console.log("All migrations applied successfully.");
  } finally {
    await sql.end();
  }
}
