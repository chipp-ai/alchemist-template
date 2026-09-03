/**
 * Test Helpers
 *
 * Utilities for writing isolated, parallel-safe tests.
 *
 * Usage:
 *   import { createIsolatedUser, getTestDb, withTestServer } from "../helpers.ts";
 *
 *   Deno.test("my test", async () => {
 *     const { user, org, cleanup } = await createIsolatedUser("owner");
 *     try {
 *       // ... test logic
 *     } finally {
 *       await cleanup();
 *     }
 *   });
 */

import { Hono } from "hono";
import { db, ensureTestSchema, sql } from "@/db/client.ts";
import type { Database } from "@/db/schema.ts";
import type { Kysely } from "kysely";

// Provision THIS worker's isolated test schema BEFORE any test in a file that
// imports these helpers runs (top-level await blocks the importing module until
// it resolves). This is what makes `deno test --parallel` deterministic: each
// worker process builds + uses its own `test_p<pid>` schema, so parallel files
// can never see each other's rows (VALORV-494). No-op outside parallel-test mode.
await ensureTestSchema();

// ── Types ──

export interface IsolatedTestContext {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    organizationId: string;
  };
  org: {
    id: string;
    name: string;
    slug: string;
  };
  cleanup: () => Promise<void>;
}

// ── Unique ID generation for test isolation ──

let testCounter = 0;

function uniqueTestId(): string {
  testCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}-${testCounter}`;
}

// ── createIsolatedUser ──

/**
 * Creates a fresh org + user in the test database.
 * Each call produces a completely isolated set of resources with unique names,
 * so tests running in parallel never collide.
 *
 * Cleanup deletes the org, which cascades to the user and all related records.
 *
 * @param role - The org-level role for the created user. Default: "owner"
 */
export async function createIsolatedUser(
  role: "owner" | "admin" | "editor" | "viewer" = "owner",
): Promise<IsolatedTestContext> {
  // Defensive: ensure this worker's schema exists even if a test file used
  // createIsolatedUser without importing at module top (cached → cheap).
  await ensureTestSchema();
  const id = uniqueTestId();
  const email = `test-${id}@test.local`;
  const orgName = `Test Org ${id}`;
  const orgSlug = `test-org-${id}`;

  // Create org
  const orgRow = await db
    .insertInto("organizations")
    .values({
      name: orgName,
      slug: orgSlug,
      subscriptionTier: "FREE",
      creditsExhausted: false,
    })
    .returning(["id", "name", "slug"])
    .executeTakeFirstOrThrow();

  // Create user
  const userRow = await db
    .insertInto("users")
    .values({
      email,
      name: `Test User ${id}`,
      role,
      organizationId: orgRow.id,
      emailVerified: true,
    })
    .returning(["id", "email", "name", "role", "organizationId"])
    .executeTakeFirstOrThrow();

  const cleanup = async () => {
    try {
      // Deleting the org cascades to users and all related records
      await db
        .deleteFrom("organizations")
        .where("id", "=", orgRow.id)
        .execute();
    } catch {
      // Cleanup failure is not fatal -- the test DB may already be torn down
    }
  };

  // The schema marks `users.organizationId` and `organizations.slug` as
  // nullable, but we just INSERTed both with non-null values above — narrow the
  // Selectable result back to the non-null shape IsolatedTestContext expects.
  // Without this, `deno test` (which type-checks test files — the Type Check job's
  // `deno check main.ts` does NOT reach them) fails with TS2322 in every test
  // that calls createIsolatedUser.
  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      role: userRow.role,
      organizationId: userRow.organizationId as string,
    },
    org: {
      id: orgRow.id,
      name: orgRow.name,
      slug: orgRow.slug as string,
    },
    cleanup,
  };
}

// ── getTestDb ──

/**
 * Returns the Kysely database instance configured for the test environment.
 * Uses TEST_DATABASE_URL if set, otherwise falls back to DATABASE_URL.
 *
 * This is the same shared instance used by the application code -- do not
 * call .destroy() on it. Use createIsolatedUser() for resource cleanup.
 */
export function getTestDb(): Kysely<Database> {
  return db;
}

/**
 * Returns the raw postgres.js SQL client for test queries that need
 * snake_case result keys or raw SQL execution.
 */
export function getTestSql() {
  return sql;
}

// ── withLocalStorage ──

const STORAGE_ENV_VARS = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_KEY_PREFIX",
  "LOCAL_STORAGE_DIR",
  "LOCAL_STORAGE_SIGNING_SECRET",
] as const;

/**
 * Fixed advisory-lock key that SERIALIZES the `withLocalStorage` critical
 * section across every parallel test worker, mirroring `PROVISION_LOCK_KEY`
 * in `src/db/client.ts`.
 *
 * `deno test --parallel` runs test FILES as separate V8 isolates inside ONE
 * OS process (see the schema-isolation comment in `db/client.ts`). `Deno.env`
 * is a binding onto the real process environment, so it is genuinely shared
 * across those isolates -- but each isolate gets its OWN module registry, so
 * an in-JS mutex (a module-scoped `Promise` chain / lock variable) only
 * serializes calls *within one isolate* and does nothing for two different
 * test files racing from two different isolates. A Postgres advisory lock is
 * scoped to a DATABASE SESSION, not a JS realm, so it is the one mutex primitive
 * that actually reaches across isolate boundaries: whichever isolate's
 * `withLocalStorage` call grabs it first mutates `Deno.env`, runs `fn`, and
 * restores the env before the NEXT call (in any isolate) is allowed to start
 * its own mutation window. Without this, two concurrent calls would
 * interleave their env-var writes/restores and readers would hit "file not
 * found" against a directory another call already tore down (ALCHEM7-5).
 *
 * `storage.test.ts` also holds this SAME lock (imported from here) for its
 * whole run, because it mutates the identical R2_* env vars at module load
 * and never restores them -- see that file for why.
 */
export const STORAGE_ENV_LOCK_KEY = 495495;
const LOCAL_STORAGE_LOCK_KEY = STORAGE_ENV_LOCK_KEY;

/**
 * Run a test with the LOCAL storage driver active, against a throwaway
 * directory, and put every storage env var back afterwards.
 *
 * Two reasons this exists rather than each test setting env by hand.
 * Test files share a worker process, so a file that sets R2_ENDPOINT at
 * module load (storage.test.ts does) would otherwise change what an
 * unrelated file is testing. And a real temp directory per case means an
 * upload test exercises the actual round trip instead of a mock, which
 * is the whole point of having a local driver.
 *
 * `setKeyPrefix` switches tenant mid-test, for isolation cases that need
 * project A to write and project B to try to read.
 *
 * The whole body runs inside an advisory-lock critical section (see
 * `LOCAL_STORAGE_LOCK_KEY`) so concurrent callers -- including ones in a
 * different test file / isolate under `deno test --parallel` -- never
 * observe each other's env-var mutations mid-flight.
 */
export async function withLocalStorage<T>(
  fn: (ctx: { root: string; setKeyPrefix: (prefix: string) => void }) => Promise<T> | T,
  opts: { keyPrefix?: string } = {},
): Promise<T> {
  const lock = await sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${LOCAL_STORAGE_LOCK_KEY})`;

    const saved = new Map<string, string | undefined>();
    for (const name of STORAGE_ENV_VARS) saved.set(name, Deno.env.get(name));

    const root = await Deno.makeTempDir({ prefix: "alchemist-storage-" });
    try {
      for (
        const name of ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
      ) {
        Deno.env.delete(name);
      }
      Deno.env.set("R2_KEY_PREFIX", opts.keyPrefix ?? "");
      Deno.env.set("LOCAL_STORAGE_DIR", root);
      Deno.env.set("LOCAL_STORAGE_SIGNING_SECRET", "test-signing-secret");

      return await fn({
        root,
        setKeyPrefix: (prefix: string) => Deno.env.set("R2_KEY_PREFIX", prefix),
      });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  } finally {
    try {
      await lock`SELECT pg_advisory_unlock(${LOCAL_STORAGE_LOCK_KEY})`;
    } catch {
      // best-effort -- releasing the connection below still frees the
      // session-scoped lock even if the explicit unlock call fails.
    }
    lock.release();
  }
}

// ── withTestServer ──

/**
 * Creates a Hono app instance for route integration testing.
 *
 * Pass route handlers to mount them, then use the returned `app` with
 * `app.request()` to simulate HTTP requests without starting a real server.
 *
 * Usage:
 *   const app = withTestServer((app) => {
 *     app.route("/api/items", itemRoutes);
 *   });
 *
 *   const res = await app.request("/api/items", { method: "GET" });
 *   assertEquals(res.status, 200);
 */
export function withTestServer(
  setup: (app: Hono) => void,
): Hono {
  const app = new Hono();

  // Global error handler matching production behavior
  app.onError((err, c) => {
    // Re-export AppError shape for test assertions
    if ("statusCode" in err && "code" in err) {
      const appErr = err as { statusCode: number; code: string; message: string };
      return c.json(
        { error: appErr.message, code: appErr.code },
        appErr.statusCode as 400,
      );
    }
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  });

  setup(app);
  return app;
}
