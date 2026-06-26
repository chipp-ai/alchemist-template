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

const connectionString = Deno.env.get("TEST_DATABASE_URL") ||
  Deno.env.get("DATABASE_URL");

// ── Per-worker test-schema isolation (deterministic parallel tests) ──
//
// `deno test --parallel` runs test FILES across multiple workers that all hit
// the SAME database. Without isolation, a test that reads un-scoped state
// (count(*) over a table, a fixed id, an un-scoped DELETE) sees another worker's
// rows → flaky. Fix: give EACH worker its OWN Postgres schema and point its
// connections' search_path at it, so cross-worker interference is impossible
// regardless of how a test is written. Provisioned by ensureTestSchema()
// (below), which helpers.ts awaits at module load.
//
// CRITICAL — the schema name must be unique PER WORKER, and a worker is a V8
// ISOLATE, NOT a process. Deno's `--parallel` runs workers as separate isolates
// inside ONE process, so `Deno.pid` is IDENTICAL across all of them — keying on
// it makes every worker target the SAME schema and stomp each other's
// DROP/CREATE/migrate (observed on Valor Victoria: flaky, WORSE than no
// isolation). Each isolate evaluates this module exactly once, so a random id
// minted here is unique per worker. (`Deno.pid` stays as a human-readable prefix
// only.)
//
// Gated HARD on the explicit `TEST_PARALLEL_ISOLATION=1` flag (set only by the
// `test*` tasks in deno.json) so production — where DATABASE_URL is set but the
// flag is NOT — can never accidentally route real queries into a test schema.
// (VALORV-494)
const TEST_SCHEMA = Deno.env.get("TEST_PARALLEL_ISOLATION") === "1" && connectionString
  ? `test_p${Deno.pid}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
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

  // Idle-connection reaping. In production the pod is long-lived, so reaping
  // idle connections (idle_timeout=20s) is correct — it frees server-side slots
  // when traffic is quiet. For a LOCAL DB (dev + the `deno test --parallel`
  // suite) the idle reaper is disabled (0 → postgres.js installs a no-op timer,
  // see connection.js `timer()`). Rationale: under the parallel test runner each
  // worker leaves pooled connections idle for >20s (services issue queries
  // sequentially, so the pool's spare connections sit idle), the reaper fires
  // `end()` which writes a Terminate packet, and that timer-driven `socket.write`
  // racing the worker's event-loop teardown trips the known Deno + postgres.js
  // bug `TypeError: May not write null values to stream` (deno#29262, nextWrite
  // via 02_timers.js) — an UNCAUGHT throw that crashes the worker and fails the
  // whole suite with exit=1 even though every test passed. Disabling the idle
  // timer removes that timer-driven write entirely for the test/dev pool;
  // connections are released when the worker process exits. max_lifetime (600s)
  // never fires inside a <4min test process. Production is unchanged (remote
  // host → idle reaper stays at 20s). (VALORV-494, ported from Valor Victoria.)
  const idleTimeout = isLocalDb ? 0 : 20;

  const sqlClient = postgres(connectionString, {
    max: poolMax,
    idle_timeout: idleTimeout,
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

// ── deno#29262 teardown-race guard (test/dev only) ──
//
// Under `deno test --parallel`, each worker holds pooled postgres.js
// connections that are never explicitly closed (tests share the module
// singleton `sql`). When the worker tears down, a postgres.js buffered protocol
// write scheduled via `setImmediate` (`nextWrite`, connection.js) — or a
// connection-lifecycle timer's Terminate write — can fire AFTER Deno has nulled
// the socket's underlying stream, throwing an UNCAUGHT `TypeError: May not write
// null values to stream` (deno#29262, status "not planned"). Because that throw
// originates from a timer/event handler and not from inside any test, the `deno
// test` runner reports "uncaught error … caused the test runner to fail" and the
// whole suite exits non-zero EVEN THOUGH every test passed — a recurring
// `[FAIL exit=1]` gate symptom.
//
// Disabling the idle reaper (`idle_timeout=0`, above) removes one source of the
// doomed write but not the buffered-protocol-write source, so we also swallow
// this ONE specific teardown error at the isolate level. The match is narrow
// (exact `TypeError` message) so no genuine error is ever masked, and it is
// scoped to non-production only — the live pod is long-lived and never hits a
// `deno test` worker-teardown race. (VALORV-494, ported from Valor Victoria.)
if (Deno.env.get("NODE_ENV") !== "production") {
  const isPostgresTeardownNullWrite = (reason: unknown): boolean =>
    reason instanceof TypeError &&
    reason.message.includes("May not write null values to stream");
  globalThis.addEventListener("error", (event) => {
    if (isPostgresTeardownNullWrite((event as ErrorEvent).error)) {
      event.preventDefault();
    }
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    if (isPostgresTeardownNullWrite((event as PromiseRejectionEvent).reason)) {
      event.preventDefault();
    }
  });
}

export { db, sql };
export const isDatabaseConfigured = () => dbConfigured;

// ── Per-worker test-schema provisioning ──

/** The schema this test worker is isolated into, or null outside parallel-test mode. */
export const testSchemaName = TEST_SCHEMA;

let testSchemaReady: Promise<void> | null = null;

/**
 * Fixed advisory-lock key that SERIALIZES per-worker schema provisioning across
 * parallel test workers (VALORV-494). The per-worker schemas themselves don't
 * conflict, but the migrations' shared, DB-level `CREATE EXTENSION` statements
 * race if N workers run them at once (observed on Valor Victoria: most workers'
 * provisioning failed under concurrency). Serializing the whole provisioning
 * section is simple + correct: the first worker creates the extensions, every
 * later worker's `CREATE EXTENSION IF NOT EXISTS` is then a no-op.
 */
const PROVISION_LOCK_KEY = 494494;

/**
 * Provision THIS worker's isolated test schema (VALORV-494): drop+recreate
 * `test_p<pid>`, then apply the FULL MIGRATION set into it.
 *
 * Provisioned from MIGRATIONS, NOT `db/test-schema.sql`: that file drifts from
 * the real schema on customer repos (e.g. Valor Victoria's was stale, missing
 * dozens of tables) and customer CI builds the test DB from migrations anyway.
 * Migration DDL is all-UNQUALIFIED, so it lands in whichever schema leads the
 * search_path. `runMigrations` opens its OWN connection, so the per-worker
 * search_path is threaded through the connection URL's `options` param (verified
 * postgres.js honors `?options=-c search_path=...`). A computed import specifier
 * keeps the shared prod runner out of `deno check`'s graph.
 *
 * Two concurrency hazards, both closed by holding a session ADVISORY LOCK across
 * the whole provisioning section (see PROVISION_LOCK_KEY):
 *   1. RACE — N workers running the migrations' shared `CREATE EXTENSION` at once.
 *   2. WRONG SCHEMA — an unqualified `CREATE EXTENSION` in a migration installs
 *      the extension's functions into the leading search_path schema (this
 *      worker's `test_p<pid>`), so OTHER workers can't resolve `uuid_generate_v4`
 *      etc. Fix: pre-create every extension the migrations reference explicitly in
 *      `public` (`SCHEMA public`) before migrating — they land shared, and each
 *      migration's own `CREATE EXTENSION IF NOT EXISTS` then no-ops. Every worker
 *      resolves them via its `,public` search_path suffix.
 *
 * Idempotent (cached promise) + a no-op outside parallel-test mode; `helpers.ts`
 * awaits it at module load so every worker has a fully-migrated private schema
 * before its first test.
 */
export function ensureTestSchema(): Promise<void> {
  if (!TEST_SCHEMA || !dbConfigured || !connectionString) return Promise.resolve();
  if (!testSchemaReady) {
    testSchemaReady = (async () => {
      const migrationsDir = new URL("../../db/migrations/", import.meta.url).pathname;
      const runnerUrl = new URL("../../db/_runner.ts", import.meta.url).href;
      const { runMigrations } = await import(runnerUrl) as {
        runMigrations: (
          o: { migrationsDir: string; databaseUrl?: string },
        ) => Promise<void>;
      };
      const url = new URL(connectionString);
      url.searchParams.set("options", `-c search_path=${TEST_SCHEMA},public`);
      // Hold the advisory lock on a reserved connection across runMigrations
      // (which uses its OWN connection) so provisioning is serialized worker-wide.
      const lock = await sql.reserve();
      try {
        await lock`SELECT pg_advisory_lock(${PROVISION_LOCK_KEY})`;
        await lock.unsafe(
          `DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE; CREATE SCHEMA "${TEST_SCHEMA}"`,
        );
        for (const ext of await extensionsReferencedByMigrations(migrationsDir)) {
          // Best-effort: a migration may guard an unavailable extension in a DO
          // block, so don't let one missing extension abort provisioning.
          try {
            await lock.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}" SCHEMA public`);
          } catch { /* migration's own guarded CREATE handles absence */ }
        }
        await runMigrations({ migrationsDir, databaseUrl: url.toString() });
      } finally {
        try {
          await lock`SELECT pg_advisory_unlock(${PROVISION_LOCK_KEY})`;
        } catch { /* best-effort */ }
        lock.release();
      }
    })();
  }
  return testSchemaReady;
}

/**
 * Scan the migration SQL for the extensions it creates, so we can pre-install
 * them into `public` (shared) instead of letting an unqualified `CREATE EXTENSION`
 * land in a single worker's private schema. Matches `CREATE EXTENSION [IF NOT
 * EXISTS] <name|"name">` — the leading `CREATE EXTENSION` keyword is what counts,
 * so a guarded one inside a DO block is still found.
 */
async function extensionsReferencedByMigrations(dir: string): Promise<string[]> {
  const found = new Set<string>();
  const re = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_-]+)["']?/gi;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
      const text = await Deno.readTextFile(`${dir}${entry.name}`);
      for (const m of text.matchAll(re)) found.add(m[1]);
    }
  } catch { /* no migrations dir → nothing to pre-create */ }
  return [...found];
}

// Provision THIS worker's isolated schema at MODULE LOAD — every test that
// touches the DB imports `@/db/client.ts` (for `sql`/`db`), so doing it here
// (rather than only in helpers.ts) guarantees provisioning even for test files
// that use `sql` directly and never import the test helpers. Without this, such
// a file's queries resolve against an unprovisioned (empty `public`) schema and
// fail with "relation ... does not exist". A no-op outside parallel-test mode
// (ensureTestSchema returns immediately when TEST_SCHEMA is null), so production
// import cost is zero. (VALORV-494)
await ensureTestSchema();

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
      () =>
        reject(
          new Error(`DB operation timed out after ${timeoutMs}ms (including pool acquisition)`),
        ),
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
      () =>
        reject(
          new Error(`DB operation timed out after ${timeoutMs}ms (including pool acquisition)`),
        ),
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
