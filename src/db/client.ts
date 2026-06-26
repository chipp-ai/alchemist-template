/**
 * Database Client
 *
 * Kysely-based type-safe query builder for PostgreSQL.
 * Uses CamelCasePlugin: snake_case DB columns -> camelCase TS properties.
 */

import { log } from "@/lib/logger.ts";
import { CamelCasePlugin, Kysely, sql as kyselySql } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "./schema.ts";

// ── Connection setup ──

const connectionString =
  Deno.env.get("TEST_DATABASE_URL") ||
  Deno.env.get("DATABASE_URL");

// ── Per-worker test-schema isolation (deterministic parallel tests) ──
//
// `deno test --parallel` runs test FILES in separate worker PROCESSES that all
// hit the SAME database. Without isolation, a test that reads un-scoped state
// (count(*) over a table, a fixed id, an un-scoped DELETE) sees another worker's
// rows → flaky. Fix: give EACH worker its OWN Postgres schema (`test_p<pid>`)
// and point its connections' search_path at it, so cross-worker interference is
// impossible regardless of how a test is written. Provisioned by
// ensureTestSchema() (below), which helpers.ts awaits at module load.
//
// Gated HARD on the explicit `TEST_PARALLEL_ISOLATION=1` flag (set only by the
// `test*` tasks in deno.json) so production — where DATABASE_URL is set but the
// flag is NOT — can never accidentally route real queries into a `test_p<pid>`
// schema. (VALORV-494)
const TEST_SCHEMA =
  Deno.env.get("TEST_PARALLEL_ISOLATION") === "1" && connectionString
    ? `test_p${Deno.pid}`
    : null;

function createDatabaseClient(): {
  sql: ReturnType<typeof postgres>;
  db: Kysely<Database>;
  configured: boolean;
} {
  if (!connectionString) {
    log.warn("DATABASE_URL not set. Database features disabled.", {
      source: "db",
    });
    const noOpHandler = {
      get: () => {
        return () => {
          throw new Error("Database not configured. Set DATABASE_URL environment variable.");
        };
      },
    };
    return {
      sql: new Proxy({}, noOpHandler) as ReturnType<typeof postgres>,
      db: new Proxy({}, noOpHandler) as Kysely<Database>,
      configured: false,
    };
  }

  const connUrl = new URL(connectionString);
  const isLocalDb = connUrl.hostname === "localhost" || connUrl.hostname === "127.0.0.1";
  const poolMax = isLocalDb ? 5 : Number(Deno.env.get("DB_POOL_MAX")) || 10;

  const sqlClient = postgres(connectionString, {
    max: poolMax,
    idle_timeout: 20,
    connect_timeout: 5,
    max_lifetime: 600,
    connection: {
      application_name: "alchemist-template",
      statement_timeout: 15000,
      // Each parallel test worker resolves unqualified table refs to its OWN
      // schema first → deterministic under --parallel (VALORV-494). `public`
      // stays on the path for extensions/shared types. No-op in prod (null).
      ...(TEST_SCHEMA ? { search_path: `${TEST_SCHEMA},public` } : {}),
    },
  });

  const dialect = new PostgresJSDialect({
    // deno-lint-ignore no-explicit-any
    postgres: sqlClient as any,
  });

  const dbClient = new Kysely<Database>({
    dialect,
    plugins: [new CamelCasePlugin()],
  });

  return { sql: sqlClient, db: dbClient, configured: true };
}

const { sql, db, configured: dbConfigured } = createDatabaseClient();

export { sql, db };
export const isDatabaseConfigured = () => dbConfigured;

// ── Per-worker test-schema provisioning ──

/** The schema this test worker is isolated into, or null outside parallel-test mode. */
export const testSchemaName = TEST_SCHEMA;

let testSchemaReady: Promise<void> | null = null;

/**
 * Provision THIS worker's isolated test schema (VALORV-494): drop+recreate
 * `test_p<pid>` (DROP+CREATE so a reused PID starts clean), then apply
 * `db/test-schema.sql` into it. The DDL is all-UNQUALIFIED and the connection's
 * search_path leads with `test_p<pid>`, so every table/type/function lands in
 * this worker's private schema. `CREATE SCHEMA` is qualified, so it doesn't
 * depend on search_path resolving first.
 *
 * Idempotent (cached promise) + a no-op outside parallel-test mode, so it's safe
 * to call from many test files. `helpers.ts` awaits it at module load, so every
 * worker has a fully-built private schema before its first test runs.
 */
export function ensureTestSchema(): Promise<void> {
  if (!TEST_SCHEMA || !dbConfigured) return Promise.resolve();
  if (!testSchemaReady) {
    testSchemaReady = (async () => {
      const ddl = await Deno.readTextFile(
        new URL("../../db/test-schema.sql", import.meta.url),
      );
      // Strip the file's outer BEGIN;/COMMIT; — postgres.js rejects an explicit
      // transaction on a pooled connection ("UNSAFE_TRANSACTION"). The DDL is
      // idempotent and applied to a freshly-created schema, so per-statement
      // autocommit is fine. (Matches only standalone `BEGIN;`/`COMMIT;` lines, so
      // a PL/pgSQL `BEGIN`/`END;` inside a `$$` function body is untouched.)
      const body = ddl
        .replace(/^\s*BEGIN\s*;\s*$/gim, "")
        .replace(/^\s*COMMIT\s*;\s*$/gim, "");
      await sql.unsafe(
        `DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE; CREATE SCHEMA "${TEST_SCHEMA}"`,
      );
      await sql.unsafe(body);
    })();
  }
  return testSchemaReady;
}

// ── Timeout utilities ──

/**
 * Run a Kysely callback in a transaction with a tight statement_timeout.
 * Races against a wall-clock timer so pool-acquisition time is also bounded.
 */
export function withTimeout<T>(
  timeoutMs: number,
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const dbOp = db.transaction().execute(async (trx) => {
    await kyselySql`SET LOCAL statement_timeout = ${kyselySql.raw(`'${timeoutMs}'`)}`.execute(trx);
    return fn(trx);
  });

  let timerId: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`DB operation timed out after ${timeoutMs}ms (including pool acquisition)`)),
      timeoutMs,
    );
  });

  const race = Promise.race([dbOp, timer]);
  dbOp.catch(() => {});
  return race.finally(() => clearTimeout(timerId));
}

/**
 * Wrap a raw postgres.js promise with a wall-clock timeout.
 * Use instead of withTimeout when result-processing code expects snake_case keys.
 */
export function raceTimeout<T>(timeoutMs: number, promise: Promise<T>): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`DB operation timed out after ${timeoutMs}ms (including pool acquisition)`)),
      timeoutMs,
    );
  });
  const race = Promise.race([promise, timer]);
  promise.catch(() => {});
  return race.finally(() => clearTimeout(timerId));
}

// ── Transient error detection ──

const TRANSIENT_PATTERNS = [
  "connection reset",
  "connection refused",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "connection terminated unexpectedly",
  "terminating connection due to administrator command",
  "server closed the connection unexpectedly",
  "Cannot acquire a connection from the pool",
  "DB operation timed out",
  "too many clients",
  "Connection terminated",
  "the database system is shutting down",
  "the database system is starting up",
  "remaining connection slots are reserved",
  "canceling statement due to statement timeout",
];

/**
 * Detect transient database errors (connection resets, pool timeouts, shutdown).
 * Use in catch blocks to downgrade to warn instead of error.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

// ── Health check ──

/**
 * Run a simple SELECT 1 to check database health.
 */
export async function checkDatabaseHealth(): Promise<"ok" | "degraded"> {
  if (!dbConfigured) return "degraded";
  try {
    await sql`SELECT 1`;
    return "ok";
  } catch {
    return "degraded";
  }
}

// ── Lifecycle ──

export async function initDatabase(): Promise<void> {
  if (!dbConfigured) return;
  try {
    await sql`SELECT 1`;
    log.info("Database connected", { source: "db" });
  } catch (err) {
    log.error("Database connection failed", { source: "db" }, err);
    throw err;
  }
}

export async function closeDatabase(): Promise<void> {
  if (!dbConfigured) return;
  try {
    await db.destroy();
    await sql.end();
    log.info("Database connections closed", { source: "db" });
  } catch (err) {
    log.warn("Error closing database", { source: "db" }, err);
  }
}
