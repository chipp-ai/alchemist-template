/**
 * Database migration entry point.
 *
 * This file is intentionally TINY. The actual runner lives at:
 *
 *   https://raw.githubusercontent.com/chipp-ai/alchemist-template/staging/db/_runner.ts
 *
 * Customer projects scaffolded from this template get this file
 * verbatim. Fixes to the runner (bugs, new SQL constructs, lock
 * behavior, ledger schema, etc.) are made to `_runner.ts` on the
 * template's `staging` branch and propagate to every customer
 * automatically — `deno cache --reload` on local dev, or via a
 * customer-runtime base-image rebuild for prod pods (the image's
 * /opt/deno-cache-seed layer is regenerated on each release and
 * pre-caches this exact URL; see customer-runtime/precache/).
 *
 * The runner reads SQL files from `db/migrations/` relative to THIS
 * file's location (via `import.meta.url`). Customers add their own
 * SQL migrations under db/migrations/; the runner discovers them on
 * the customer's local filesystem.
 *
 * Usage:
 *   deno run --env --allow-net --allow-env --allow-read db/migrate.ts
 *   deno task db:migrate
 */

import { runMigrations } from "https://raw.githubusercontent.com/chipp-ai/alchemist-template/staging/db/_runner.ts";

try {
  await runMigrations({
    // Resolves against THIS file's customer-local path, so the
    // runner reads the customer's own migrations directory — NOT
    // a directory at the GitHub URL we imported from.
    migrationsDir: new URL("./migrations/", import.meta.url).pathname,
  });
  Deno.exit(0);
} catch (_err) {
  // _runner.ts has already logged the failure with context. Just
  // surface the non-zero exit so CI / deploy / desktop-dev-server
  // see the migration failed.
  Deno.exit(1);
}
