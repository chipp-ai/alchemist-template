/**
 * Drop leftover per-worker test schemas (VALORV-494).
 *
 * Parallel-test isolation gives each worker ISOLATE its own `test_p<pid>_<rand>`
 * schema (see src/db/client.ts). The random suffix is what makes it unique per
 * isolate (workers share one process/pid), but it means a worker can't reuse +
 * clean a stable name across runs — so each run leaves ~N (one per isolate)
 * schemas behind. Left unchecked they accumulate on a persistent dev DB.
 *
 * This runs ONCE, before the workers start (wired as a `&&` prefix on the `test*`
 * tasks in deno.json), so there's no race with live workers: it drops every
 * `test_p%` schema, then the suite mints fresh ones. Bounded to one run's worth
 * at any time. Fail-soft: a missing/unreachable DB is a no-op (the suite's own
 * provisioning will surface a real DB problem).
 */

import postgres from "postgres";

const connectionString = Deno.env.get("TEST_DATABASE_URL") || Deno.env.get("DATABASE_URL");
if (!connectionString) {
  // No DB configured — nothing to clean. Not an error (mirrors client.ts).
  Deno.exit(0);
}

const sql = postgres(connectionString, { max: 1, connect_timeout: 5 });
try {
  const rows = await sql<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test_p%'
  `;
  for (const { nspname } of rows) {
    // Identifier comes from pg_namespace (not user input); still quote it.
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
  }
  if (rows.length > 0) {
    console.log(`[clean-test-schemas] dropped ${rows.length} leftover test_p% schema(s)`);
  }
} catch (err) {
  console.warn(
    `[clean-test-schemas] skipped (${err instanceof Error ? err.message : err})`,
  );
} finally {
  await sql.end();
}
