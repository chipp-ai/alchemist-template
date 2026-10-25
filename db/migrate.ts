/**
 * Database migration entry point.
 *
 * This file is intentionally TINY. The runner is the LOCAL sibling file
 * `./_runner.ts`, committed in this repo.
 *
 * It must stay a local import. Until 2026-10-25 this file imported the
 * runner from the template's MUTABLE `staging` branch on
 * raw.githubusercontent.com, while each project's deno.lock pinned that
 * module's content hash. Every template change to the runner made the pin
 * stale, and a pod built against the old lock crash-looped at start with
 * "Integrity check failed for remote specifier" (six apps down on
 * 2026-10-25). A pod must never fetch code at start, and a template change
 * must never break a deployed app. A runner fix now reaches a project as a
 * normal commit to its own db/_runner.ts.
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

import { runMigrations } from "./_runner.ts";

try {
  await runMigrations({
    // Resolves against THIS file's customer-local path, so the
    // runner reads the customer's own migrations directory — NOT
    // a directory at the GitHub URL we imported from.
    migrationsDir: new URL("./migrations/", import.meta.url).pathname,
  });
  Deno.exit(0);
} catch (err) {
  // _runner.ts logs failures CAUSED BY a migration (SQL errors, lock
  // contention, etc.) with rich context. But errors thrown BEFORE
  // the runner reaches its own logging path — connection refused,
  // auth failure, DNS lookup miss, network unreachable — surface
  // here with the original message swallowed. Print the error so
  // CI / deploy / desktop-dev-server can diagnose without re-running
  // with strace.
  console.error("[migrate] failed:", err);
  Deno.exit(1);
}
