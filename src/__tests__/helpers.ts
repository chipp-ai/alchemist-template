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
import { db, sql } from "@/db/client.ts";
import type { Database } from "@/db/schema.ts";
import type { Kysely } from "kysely";

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
  role: "owner" | "admin" | "member" | "viewer" = "owner",
): Promise<IsolatedTestContext> {
  const id = uniqueTestId();
  const email = `test-${id}@test.local`;
  const orgName = `Test Org ${id}`;
  const orgSlug = `test-org-${id}`;

  // Create org
  const orgRow = await db
    .insertInto("app.organizations")
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
    .insertInto("app.users")
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
        .deleteFrom("app.organizations")
        .where("id", "=", orgRow.id)
        .execute();
    } catch {
      // Cleanup failure is not fatal -- the test DB may already be torn down
    }
  };

  return {
    user: userRow,
    org: orgRow,
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
